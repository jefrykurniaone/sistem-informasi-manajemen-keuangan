import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaints,
	type Complaint,
	type ComplaintVisibility
} from '$lib/server/db/schema/complaint';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	addComplaintReply,
	COMPLAINT_REPLY_RULE,
	ComplaintReplyRuleError,
	listComplaintReplies
} from '$lib/server/services/complaint';

/**
 * Tanggapan: the reply thread on one Keluhan. Story 6 (the reporter), story 17 (the pengurus), and
 * the rule this ticket's orchestrator correction states outright — a reply is only ever legitimate
 * from the reporter or a handler, never from a neighbour who can merely read a `public` complaint.
 */

const testDb = testDatabase();
const START = '2026-06-01T00:00:00.000Z';

let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function insertAccount(name: string, role?: Role): Promise<string> {
	const userId = await insertUser(name);
	if (role) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date(START) });
	}
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

async function insertComplaint(
	reporterUserId: string,
	options: { readonly visibility?: ComplaintVisibility } = {}
): Promise<Complaint> {
	const reporterId = await residentIdOf(reporterUserId);
	const at = new Date(START);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Selokan tersumbat'),
			category: 'lingkungan',
			description: 'Air tidak mengalir setelah hujan deras kemarin.',
			status: COMPLAINT_STATUS.new,
			visibility: options.visibility ?? COMPLAINT_VISIBILITY.private,
			rejectionReason: null,
			createdAt: at,
			statusChangedAt: at
		})
		.returning();
	return row;
}

describe('addComplaintReply', () => {
	it('lets the reporter reply to their own complaint', async () => {
		const reporterUserId = await insertAccount(unique('Warga Menanggapi'));
		const complaint = await insertComplaint(reporterUserId);

		const reply = await addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: reporterUserId,
			complaintId: complaint.id,
			content: 'Informasi tambahan: sudah tiga hari.'
		});

		expect(reply.content).toBe('Informasi tambahan: sudah tiga hari.');
		expect(reply.authorId).toBe(await residentIdOf(reporterUserId));
	});

	it('lets a handler reply to a complaint they did not report', async () => {
		const reporterUserId = await insertAccount(unique('Warga Dibalas'));
		const adminUserId = await insertAccount(unique('Pengurus Membalas'), ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);

		const reply = await addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: adminUserId,
			complaintId: complaint.id,
			content: 'Sudah kami tindak lanjuti.'
		});

		expect(reply.authorId).toBe(await residentIdOf(adminUserId));
	});

	it('refuses a superuser who is not also an admin, the same split handleComplaints makes', async () => {
		const reporterUserId = await insertAccount(unique('Warga Ditolak Super'));
		const superuserId = await insertAccount(unique('Superuser Bukan Admin'), ROLE.superuser);
		const complaint = await insertComplaint(reporterUserId);

		const attempt = addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			complaintId: complaint.id,
			content: 'Saya melihat semuanya tapi bukan pengurus.'
		});

		await expect(attempt).rejects.toThrow(PermissionDeniedError);
	});

	it('refuses a neighbour who can read a public complaint but is neither its reporter nor a handler', async () => {
		const reporterUserId = await insertAccount(unique('Warga Umum'));
		const neighbourUserId = await insertAccount(unique('Tetangga Pembaca'));
		const complaint = await insertComplaint(reporterUserId, {
			visibility: COMPLAINT_VISIBILITY.public
		});

		const attempt = addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: neighbourUserId,
			complaintId: complaint.id,
			content: 'Saya juga pernah mengalami ini.'
		});

		await expect(attempt).rejects.toThrow(PermissionDeniedError);
	});

	it('refuses a guessed id identically to a complaint the caller may not read at all', async () => {
		const reporterUserId = await insertAccount(unique('Warga Pribadi Ditebak'));
		const strangerUserId = await insertAccount(unique('Penebak Id'));
		const complaint = await insertComplaint(reporterUserId);

		const attempt = addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: strangerUserId,
			complaintId: complaint.id,
			content: 'Menebak isi keluhan orang lain.'
		});

		await expect(attempt).rejects.toThrow(PermissionDeniedError);
	});

	it('refuses an empty reply, even called outside a form', async () => {
		const reporterUserId = await insertAccount(unique('Warga Kosong'));
		const complaint = await insertComplaint(reporterUserId);

		const attempt = addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: reporterUserId,
			complaintId: complaint.id,
			content: '   '
		});

		await expect(attempt).rejects.toThrow(ComplaintReplyRuleError);
		await expect(attempt).rejects.toMatchObject({ rule: COMPLAINT_REPLY_RULE.contentRequired });
	});
});

describe('listComplaintReplies', () => {
	it('returns replies oldest first, naming who wrote each one', async () => {
		const reporterName = unique('Warga Berbalas');
		const adminName = unique('Pengurus Berbalas');
		const reporterUserId = await insertAccount(reporterName);
		const adminUserId = await insertAccount(adminName, ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);
		const clock = new FakeClock(START);

		await addComplaintReply(testDb.db, clock, {
			actorId: reporterUserId,
			complaintId: complaint.id,
			content: 'Pesan pertama dari pelapor.'
		});
		clock.advance(60 * 1000);
		await addComplaintReply(testDb.db, clock, {
			actorId: adminUserId,
			complaintId: complaint.id,
			content: 'Balasan dari pengurus.'
		});

		const replies = await listComplaintReplies(testDb.db, reporterUserId, complaint.id);

		expect(replies.map((reply) => reply.content)).toEqual([
			'Pesan pertama dari pelapor.',
			'Balasan dari pengurus.'
		]);
		expect(replies.map((reply) => reply.authorName)).toEqual([reporterName, adminName]);
	});

	it('answers a private complaint thread with nothing for a viewer who may not read it', async () => {
		const reporterUserId = await insertAccount(unique('Warga Rahasia'));
		const adminUserId = await insertAccount(unique('Pengurus Rahasia'), ROLE.admin);
		const strangerUserId = await insertAccount(unique('Tetangga Rahasia'));
		const complaint = await insertComplaint(reporterUserId);
		await addComplaintReply(testDb.db, new FakeClock(START), {
			actorId: adminUserId,
			complaintId: complaint.id,
			content: 'Tanggapan pribadi.'
		});

		const replies = await listComplaintReplies(testDb.db, strangerUserId, complaint.id);

		expect(replies).toHaveLength(0);
	});
});
