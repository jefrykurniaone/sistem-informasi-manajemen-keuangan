import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	COMPLAINT_STATUS,
	COMPLAINT_STATUSES,
	COMPLAINT_VISIBILITY,
	complaintStatusChanges,
	complaints,
	type Complaint,
	type ComplaintStatus
} from '$lib/server/db/schema/complaint';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	changeComplaintStatus,
	COMPLAINT_RULE,
	COMPLAINT_STATUS_CHANGED_ACTION,
	ComplaintNotFoundError,
	ComplaintRuleError,
	withdrawComplaint
} from '$lib/server/services/complaint';
import {
	COMPLAINT_ACTOR,
	ComplaintTransitionError,
	complaintTransitionActor,
	isAllowedComplaintTransition,
	isTerminalComplaintStatus,
	OPEN_COMPLAINT_STATUSES,
	type ComplaintActor
} from '$lib/server/services/complaint/state-machine';

/**
 * The Keluhan state machine: the table of legal moves, and the service layer that is the only way
 * to use it. `docs/spec-keluhan-v1.md`'s testing decisions ask for the table as a complete case
 * matrix — "untuk setiap pasangan status asal dan tujuan, diizinkan atau ditolak" — and for the
 * mandatory-reason and withdrawal rules to be proven against the service rather than a form, which
 * is what the second half of this file does.
 */

const testDb = testDatabase();

const START = '2026-04-01T00:00:00.000Z';

/**
 * Every move the table is expected to permit, and whose move it is. Everything else — the other
 * twenty-nine pairs of the six-by-six grid, self-transitions included — is expected to be refused.
 *
 * Spelled out rather than derived, unlike `ACTIONS_NOT_SUPERUSER_ONLY` in `tests/unit/authz.test.ts`
 * which is deliberately a rule. The two files want opposite things: a new permission action should
 * pass without editing that file, and a new edge in this table should not pass without editing this
 * one. An edge nobody wrote down here is an edge nobody decided.
 */
const ALLOWED_MOVES: readonly (readonly [ComplaintStatus, ComplaintStatus, ComplaintActor])[] = [
	[COMPLAINT_STATUS.new, COMPLAINT_STATUS.reviewing, COMPLAINT_ACTOR.handler],
	[COMPLAINT_STATUS.new, COMPLAINT_STATUS.rejected, COMPLAINT_ACTOR.handler],
	[COMPLAINT_STATUS.new, COMPLAINT_STATUS.withdrawn, COMPLAINT_ACTOR.reporter],
	[COMPLAINT_STATUS.reviewing, COMPLAINT_STATUS.working, COMPLAINT_ACTOR.handler],
	[COMPLAINT_STATUS.reviewing, COMPLAINT_STATUS.rejected, COMPLAINT_ACTOR.handler],
	[COMPLAINT_STATUS.working, COMPLAINT_STATUS.resolved, COMPLAINT_ACTOR.handler],
	[COMPLAINT_STATUS.working, COMPLAINT_STATUS.rejected, COMPLAINT_ACTOR.handler]
];

/** Who the list above says may move `from` to `to`, or `undefined` when nobody may. */
function expectedActor(from: ComplaintStatus, to: ComplaintStatus): ComplaintActor | undefined {
	return ALLOWED_MOVES.find(([source, target]) => source === from && target === to)?.[2];
}

/** Every ordered pair of statuses there is — the complete matrix the spec asks for. */
const EVERY_PAIR = COMPLAINT_STATUSES.flatMap((from) =>
	COMPLAINT_STATUSES.map((to) => {
		const actor = expectedActor(from, to);
		return { from, to, actor, outcome: actor ?? 'refused' };
	})
);

describe('the transition table', () => {
	it.each(EVERY_PAIR)('$from -> $to: $outcome', ({ from, to, actor }) => {
		expect(complaintTransitionActor(from, to)).toBe(actor);
		expect(isAllowedComplaintTransition(from, to)).toBe(actor !== undefined);
	});

	it('covers every ordered pair of the six statuses, so the sweep above misses none', () => {
		expect(COMPLAINT_STATUSES).toHaveLength(6);
		expect(EVERY_PAIR).toHaveLength(36);
	});

	it('calls exactly the statuses with nowhere left to go terminal', () => {
		expect(OPEN_COMPLAINT_STATUSES).toEqual([
			COMPLAINT_STATUS.new,
			COMPLAINT_STATUS.reviewing,
			COMPLAINT_STATUS.working
		]);
		expect(COMPLAINT_STATUSES.filter(isTerminalComplaintStatus)).toEqual([
			COMPLAINT_STATUS.resolved,
			COMPLAINT_STATUS.rejected,
			COMPLAINT_STATUS.withdrawn
		]);
	});
});

/** Makes every complaint this file writes distinguishable from every other one. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
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

/** A signed-in account with the `residents` row a complaint can be attributed to. */
async function insertAccount(name: string, role?: Role): Promise<string> {
	const userId = await insertUser(name);
	if (role) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date(START) });
	}
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

/** The `residents.id` behind an account, which is what a complaint's `reporterId` names. */
async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

/**
 * A complaint in a chosen status, written straight to the table.
 *
 * Reporting one is not this ticket's surface — see the Keluhan service's own doc comment — so the
 * row is a fixture here, the same way `tests/unit/post-service.test.ts` inserts `residents` rows
 * directly rather than through a service that does not exist yet.
 */
async function insertComplaint(
	reporterUserId: string,
	status: ComplaintStatus = COMPLAINT_STATUS.new
): Promise<Complaint> {
	const reporterId = await residentIdOf(reporterUserId);
	const createdAt = new Date(START);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Lampu jalan mati'),
			category: 'fasilitas',
			description: 'Lampu di depan blok C mati sejak tiga hari lalu.',
			status,
			visibility: COMPLAINT_VISIBILITY.private,
			rejectionReason: null,
			createdAt,
			statusChangedAt: createdAt
		})
		.returning();
	return row;
}

/** The history rows of one complaint, oldest first. */
async function historyOf(complaintId: string) {
	return testDb.db
		.select()
		.from(complaintStatusChanges)
		.where(eq(complaintStatusChanges.complaintId, complaintId));
}

/** The complaint row as it stands now. */
async function reload(complaintId: string): Promise<Complaint> {
	const [row] = await testDb.db.select().from(complaints).where(eq(complaints.id, complaintId));
	return row;
}

describe('changeComplaintStatus', () => {
	it('moves a complaint, stamps the move, and writes one history row and one audit row', async () => {
		const reporterUserId = await insertAccount('Warga Pelapor');
		const adminUserId = await insertAccount('Pengurus Harian', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);
		const clock = new FakeClock('2026-04-03T09:00:00.000Z');

		const moved = await changeComplaintStatus(testDb.db, clock, {
			actorId: adminUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.reviewing,
			note: 'Sudah dicek ke lokasi.'
		});

		expect(moved.status).toBe(COMPLAINT_STATUS.reviewing);
		expect(moved.statusChangedAt).toEqual(new Date('2026-04-03T09:00:00.000Z'));

		const history = await historyOf(complaint.id);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			oldStatus: COMPLAINT_STATUS.new,
			newStatus: COMPLAINT_STATUS.reviewing,
			actorId: await residentIdOf(adminUserId),
			note: 'Sudah dicek ke lokasi.',
			occurredAt: new Date('2026-04-03T09:00:00.000Z')
		});

		const entries = await auditEntriesFor(testDb.db, complaint.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: adminUserId,
			action: COMPLAINT_STATUS_CHANGED_ACTION,
			targetId: complaint.id
		});
	});

	it('refuses a rejection with no reason, and leaves the complaint exactly where it was', async () => {
		const reporterUserId = await insertAccount('Warga Tanpa Alasan');
		const adminUserId = await insertAccount('Pengurus Tanpa Alasan', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);
		const clock = new FakeClock(START);

		const failure = changeComplaintStatus(testDb.db, clock, {
			actorId: adminUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.rejected
		});

		await expect(failure).rejects.toThrow(ComplaintRuleError);
		await expect(failure).rejects.toMatchObject({ rule: COMPLAINT_RULE.rejectionNeedsReason });
		expect(await reload(complaint.id)).toMatchObject({ status: COMPLAINT_STATUS.new });
		expect(await historyOf(complaint.id)).toHaveLength(0);
	});

	it.each([' ', '\n\t'])(
		'refuses a rejection whose reason is only whitespace (%j)',
		async (blank) => {
			const reporterUserId = await insertAccount(unique('Warga Spasi'));
			const adminUserId = await insertAccount(unique('Pengurus Spasi'), ROLE.admin);
			const complaint = await insertComplaint(reporterUserId);

			await expect(
				changeComplaintStatus(testDb.db, new FakeClock(START), {
					actorId: adminUserId,
					complaintId: complaint.id,
					to: COMPLAINT_STATUS.rejected,
					rejectionReason: blank
				})
			).rejects.toMatchObject({ rule: COMPLAINT_RULE.rejectionNeedsReason });
		}
	);

	it('stores the reason when a rejection carries one', async () => {
		const reporterUserId = await insertAccount('Warga Ditolak');
		const adminUserId = await insertAccount('Pengurus Menolak', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);

		const moved = await changeComplaintStatus(testDb.db, new FakeClock(START), {
			actorId: adminUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.rejected,
			rejectionReason: '  Pagar itu milik pribadi, bukan fasilitas komplek.  '
		});

		expect(moved).toMatchObject({
			status: COMPLAINT_STATUS.rejected,
			rejectionReason: 'Pagar itu milik pribadi, bukan fasilitas komplek.'
		});
	});

	it('refuses a reason on a move that is not a rejection', async () => {
		const reporterUserId = await insertAccount('Warga Beralasan');
		const adminUserId = await insertAccount('Pengurus Beralasan', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);

		await expect(
			changeComplaintStatus(testDb.db, new FakeClock(START), {
				actorId: adminUserId,
				complaintId: complaint.id,
				to: COMPLAINT_STATUS.reviewing,
				rejectionReason: 'Tidak relevan di sini.'
			})
		).rejects.toMatchObject({ rule: COMPLAINT_RULE.reasonWithoutRejection });
	});

	it.each([
		{ from: COMPLAINT_STATUS.resolved, to: COMPLAINT_STATUS.new },
		{ from: COMPLAINT_STATUS.working, to: COMPLAINT_STATUS.reviewing },
		{ from: COMPLAINT_STATUS.reviewing, to: COMPLAINT_STATUS.resolved },
		{ from: COMPLAINT_STATUS.withdrawn, to: COMPLAINT_STATUS.working }
	])('refuses $from -> $to with a ComplaintTransitionError', async ({ from, to }) => {
		const reporterUserId = await insertAccount(unique('Warga Mesin'));
		const adminUserId = await insertAccount(unique('Pengurus Mesin'), ROLE.admin);
		const complaint = await insertComplaint(reporterUserId, from);

		const failure = changeComplaintStatus(testDb.db, new FakeClock(START), {
			actorId: adminUserId,
			complaintId: complaint.id,
			to
		});

		await expect(failure).rejects.toThrow(ComplaintTransitionError);
		await expect(failure).rejects.toMatchObject({ from, to, by: COMPLAINT_ACTOR.handler });
	});

	it('refuses a handler who tries to withdraw a complaint on the reporter’s behalf', async () => {
		// The edge exists — `new` really can become `withdrawn` — but it belongs to the reporter, and
		// the handler's own status screen asks the table for the handler's edges only.
		const reporterUserId = await insertAccount('Warga Ditarik Orang');
		const adminUserId = await insertAccount('Pengurus Menarik', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);

		await expect(
			changeComplaintStatus(testDb.db, new FakeClock(START), {
				actorId: adminUserId,
				complaintId: complaint.id,
				to: COMPLAINT_STATUS.withdrawn
			})
		).rejects.toMatchObject({
			from: COMPLAINT_STATUS.new,
			to: COMPLAINT_STATUS.withdrawn,
			by: COMPLAINT_ACTOR.handler
		});
	});

	it.each([
		{ who: 'a resident', role: undefined },
		{ who: 'a superuser who is not an admin', role: ROLE.superuser }
	])('refuses $who with PermissionDeniedError', async ({ role }) => {
		const reporterUserId = await insertAccount(unique('Warga Dijaga'));
		const callerUserId = await insertAccount(unique('Bukan Pengurus'), role);
		const complaint = await insertComplaint(reporterUserId);

		const failure = changeComplaintStatus(testDb.db, new FakeClock(START), {
			actorId: callerUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.reviewing
		});

		await expect(failure).rejects.toThrow(PermissionDeniedError);
		expect(await reload(complaint.id)).toMatchObject({ status: COMPLAINT_STATUS.new });
	});

	it('answers a guessed complaint id with ComplaintNotFoundError, permission having passed', async () => {
		const adminUserId = await insertAccount('Pengurus Menebak', ROLE.admin);

		await expect(
			changeComplaintStatus(testDb.db, new FakeClock(START), {
				actorId: adminUserId,
				complaintId: randomUUID(),
				to: COMPLAINT_STATUS.reviewing
			})
		).rejects.toThrow(ComplaintNotFoundError);
	});

	it('refuses an admin with no residents row, so no move is attributed to nobody', async () => {
		const reporterUserId = await insertAccount('Warga Tanpa Pengurus');
		const adminUserId = await insertUser('Pengurus Belum Terdaftar');
		await testDb.db
			.insert(userRoles)
			.values({ userId: adminUserId, role: ROLE.admin, createdAt: new Date(START) });
		const complaint = await insertComplaint(reporterUserId);

		await expect(
			changeComplaintStatus(testDb.db, new FakeClock(START), {
				actorId: adminUserId,
				complaintId: complaint.id,
				to: COMPLAINT_STATUS.reviewing
			})
		).rejects.toMatchObject({ rule: COMPLAINT_RULE.actorNotRegistered });
	});
});

describe('withdrawComplaint', () => {
	it('lets the reporter take back a complaint nobody has looked at yet', async () => {
		const reporterUserId = await insertAccount('Warga Menarik');
		const complaint = await insertComplaint(reporterUserId);
		const clock = new FakeClock('2026-04-02T10:00:00.000Z');

		const withdrawn = await withdrawComplaint(testDb.db, clock, {
			actorId: reporterUserId,
			complaintId: complaint.id,
			note: 'Sudah diperbaiki sendiri.'
		});

		expect(withdrawn.status).toBe(COMPLAINT_STATUS.withdrawn);
		const history = await historyOf(complaint.id);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			oldStatus: COMPLAINT_STATUS.new,
			newStatus: COMPLAINT_STATUS.withdrawn,
			actorId: await residentIdOf(reporterUserId)
		});
	});

	it.each([
		COMPLAINT_STATUS.reviewing,
		COMPLAINT_STATUS.working,
		COMPLAINT_STATUS.resolved,
		COMPLAINT_STATUS.rejected
	])('refuses a withdrawal once the complaint has reached %s', async (status) => {
		const reporterUserId = await insertAccount(unique('Warga Terlambat'));
		const complaint = await insertComplaint(reporterUserId, status);

		const failure = withdrawComplaint(testDb.db, new FakeClock(START), {
			actorId: reporterUserId,
			complaintId: complaint.id
		});

		await expect(failure).rejects.toThrow(ComplaintTransitionError);
		await expect(failure).rejects.toMatchObject({
			from: status,
			to: COMPLAINT_STATUS.withdrawn,
			by: COMPLAINT_ACTOR.reporter
		});
	});

	it.each([
		{ who: 'a neighbour', role: undefined },
		{ who: 'an admin, who may handle it but does not own it', role: ROLE.admin },
		{ who: 'a superuser', role: ROLE.superuser }
	])('refuses $who with PermissionDeniedError', async ({ role }) => {
		const reporterUserId = await insertAccount(unique('Warga Pemilik'));
		const callerUserId = await insertAccount(unique('Bukan Pelapor'), role);
		const complaint = await insertComplaint(reporterUserId);

		await expect(
			withdrawComplaint(testDb.db, new FakeClock(START), {
				actorId: callerUserId,
				complaintId: complaint.id
			})
		).rejects.toThrow(PermissionDeniedError);
		expect(await reload(complaint.id)).toMatchObject({ status: COMPLAINT_STATUS.new });
	});

	it('answers a guessed id the same way it answers somebody else’s complaint', async () => {
		// Both are `PermissionDeniedError`, so guessing cannot be used to find out which complaint
		// ids exist.
		const callerUserId = await insertAccount('Warga Menebak Tarik');

		await expect(
			withdrawComplaint(testDb.db, new FakeClock(START), {
				actorId: callerUserId,
				complaintId: randomUUID()
			})
		).rejects.toThrow(PermissionDeniedError);
	});
});
