import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readOrigin } from '$lib/server/auth';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaints,
	type Complaint
} from '$lib/server/db/schema/complaint';
import { emailQueue } from '$lib/server/db/schema/email';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import {
	complaintStatusChangedPayload,
	complaintStatusChangedTemplate,
	COMPLAINT_STATUS_CHANGED_KIND
} from '$lib/server/email/templates/complaint-status-changed';
import {
	newComplaintPayload,
	newComplaintTemplate,
	NEW_COMPLAINT_KIND
} from '$lib/server/email/templates/new-complaint';
import type { Clock } from '$lib/server/ports/clock';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import {
	changeComplaintStatus,
	createComplaint,
	withdrawComplaint,
	type CreateComplaintRequest
} from '$lib/server/services/complaint';
import {
	notifyComplaintStatusChanged,
	notifyNewComplaint
} from '$lib/server/services/complaint/notification';
import {
	MandatorySubscriptionKindError,
	setSubscriptionPreference
} from '$lib/server/services/subscription';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * `./notification.ts` — the two emails #46 adds — and the templates they render through.
 *
 * `tests/unit/complaint-state-machine.test.ts` and `tests/unit/complaint-create.test.ts` already
 * prove the state machine and `createComplaint` themselves; this file proves the two pieces #46
 * added on top: who `notifyNewComplaint` and `notifyComplaintStatusChanged` decide to email (tested
 * directly, the same split `tests/unit/dues-notification.test.ts` and
 * `tests/unit/post-notification.test.ts` draw), that `createComplaint`, `changeComplaintStatus` and
 * `withdrawComplaint` wire to them the way #46's acceptance criteria ask for, and what the two
 * templates render.
 */

const testDb = testDatabase();
const START = '2026-05-10T00:00:00.000Z';

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

/** An admin with a `residents` row — the only shape `notifyNewComplaint` ever counts as a recipient. */
async function insertAdmin(name: string): Promise<string> {
	return insertAccount(name, ROLE.admin);
}

async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

async function emailOf(userId: string): Promise<string> {
	const [row] = await testDb.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
	return row.email;
}

async function subscribe(
	userId: string,
	clock: FakeClock,
	kind: string,
	enabled: boolean
): Promise<void> {
	await setSubscriptionPreference(testDb.db, clock, {
		callerUserId: userId,
		residentId: await residentIdOf(userId),
		kind,
		enabled
	});
}

/** Every queued email of `kind` addressed to `recipient`, since this file's schema is shared across tests. */
async function emailsTo(recipient: string, kind: string) {
	const rows = await testDb.db.select().from(emailQueue).where(eq(emailQueue.recipient, recipient));
	return rows.filter((row) => row.kind === kind);
}

/**
 * A `Complaint`-shaped value for calling `notifyNewComplaint`/`notifyComplaintStatusChanged`
 * directly, without a real row — neither function reads the `complaints` table itself, only the
 * fields this file hands them.
 */
function complaintFixture(
	overrides: Partial<Complaint> & { readonly reporterId: string }
): Complaint {
	const now = new Date(START);
	return {
		id: randomUUID(),
		title: unique('Lampu jalan mati'),
		category: 'fasilitas',
		description: 'Uraian yang tidak boleh pernah masuk email.',
		status: COMPLAINT_STATUS.new,
		visibility: COMPLAINT_VISIBILITY.private,
		rejectionReason: null,
		createdAt: now,
		statusChangedAt: now,
		...overrides
	};
}

/** A complaint written straight to the table, in `new`, for `changeComplaintStatus` and `withdrawComplaint`. */
async function insertComplaintRow(reporterUserId: string): Promise<Complaint> {
	const reporterId = await residentIdOf(reporterUserId);
	const now = new Date(START);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Selokan tersumbat'),
			category: 'fasilitas',
			description: 'Uraian yang tidak boleh pernah masuk email.',
			status: COMPLAINT_STATUS.new,
			visibility: COMPLAINT_VISIBILITY.private,
			rejectionReason: null,
			createdAt: now,
			statusChangedAt: now
		})
		.returning();
	return row;
}

/** Reports a complaint through the real service, with this file's defaults. */
async function report(overrides: Partial<CreateComplaintRequest> & { readonly actorId: string }) {
	return createComplaint(testDb.db, new FakeClock(START), new FakeFileStore(new FakeClock(START)), {
		title: unique('Pos ronda gelap'),
		category: 'keamanan',
		description: 'Uraian yang tidak boleh pernah masuk email.',
		visibility: COMPLAINT_VISIBILITY.private,
		attachments: [],
		...overrides
	});
}

/**
 * A clock that works `failAt - 1` times and then throws — the same move
 * `tests/unit/payment-verification.test.ts`'s `FailingClock` makes, used here to prove that a
 * failure inside `enqueueEmail` never reaches the caller of `notifyNewComplaint` or
 * `notifyComplaintStatusChanged`.
 */
class FailingClock implements Clock {
	#calls = 0;
	readonly #failAt: number;

	constructor(failAt: number) {
		this.#failAt = failAt;
	}

	now(): Date {
		this.#calls += 1;
		if (this.#calls === this.#failAt) {
			throw new Error('Injected clock failure, on purpose, from the failure-path test.');
		}
		return new Date(START);
	}
}

describe('notifyNewComplaint', () => {
	it('queues one email per resident subscribed to new-complaint who also holds the admin role', async () => {
		const clock = new FakeClock(START);
		const subscribedAdminId = await insertAdmin(unique('Pengurus Berlangganan'));
		await subscribe(subscribedAdminId, clock, SUBSCRIPTION_KIND.newComplaint, true);
		const unsubscribedAdminId = await insertAdmin(unique('Pengurus Diam'));
		const subscribedResidentId = await insertAccount(unique('Warga Berlangganan'));
		await subscribe(subscribedResidentId, clock, SUBSCRIPTION_KIND.newComplaint, true);
		const reporterUserId = await insertAccount(unique('Warga Pelapor'));
		const complaint = complaintFixture({ reporterId: await residentIdOf(reporterUserId) });

		await notifyNewComplaint(testDb.db, clock, complaint);

		const rows = await emailsTo(await emailOf(subscribedAdminId), NEW_COMPLAINT_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			title: complaint.title,
			category: complaint.category,
			url: `${readOrigin()}/admin/complaints/${complaint.id}`,
			locale: 'id'
		});
		expect(await emailsTo(await emailOf(unsubscribedAdminId), NEW_COMPLAINT_KIND)).toEqual([]);
		expect(await emailsTo(await emailOf(subscribedResidentId), NEW_COMPLAINT_KIND)).toEqual([]);
	});

	it('queues nothing at all when nobody is subscribed', async () => {
		const clock = new FakeClock(START);
		const adminId = await insertAdmin(unique('Pengurus Sepi'));
		const reporterUserId = await insertAccount(unique('Warga Pelapor Sepi'));
		const complaint = complaintFixture({ reporterId: await residentIdOf(reporterUserId) });

		await notifyNewComplaint(testDb.db, clock, complaint);

		expect(await emailsTo(await emailOf(adminId), NEW_COMPLAINT_KIND)).toEqual([]);
	});

	it('resolves instead of rejecting when enqueuing fails, and queues nothing', async () => {
		const clock = new FakeClock(START);
		const adminId = await insertAdmin(unique('Pengurus Gagal'));
		await subscribe(adminId, clock, SUBSCRIPTION_KIND.newComplaint, true);
		const reporterUserId = await insertAccount(unique('Warga Pelapor Gagal'));
		const complaint = complaintFixture({ reporterId: await residentIdOf(reporterUserId) });

		await expect(
			notifyNewComplaint(testDb.db, new FailingClock(1), complaint)
		).resolves.toBeUndefined();
		expect(await emailsTo(await emailOf(adminId), NEW_COMPLAINT_KIND)).toEqual([]);
	});
});

describe('notifyComplaintStatusChanged', () => {
	it('queues one email to the reporter, naming the new status and the note', async () => {
		const clock = new FakeClock(START);
		const reporterUserId = await insertAccount(unique('Warga Menunggu'));
		const complaint = complaintFixture({
			reporterId: await residentIdOf(reporterUserId),
			status: COMPLAINT_STATUS.reviewing
		});

		await notifyComplaintStatusChanged(testDb.db, clock, complaint, 'Sudah dicek ke lokasi.');

		const rows = await emailsTo(await emailOf(reporterUserId), COMPLAINT_STATUS_CHANGED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			title: complaint.title,
			status: COMPLAINT_STATUS.reviewing,
			note: 'Sudah dicek ke lokasi.',
			rejectionReason: null,
			url: `${readOrigin()}/complaints/${complaint.id}`,
			locale: 'id'
		});
	});

	it('carries the rejection reason, and no note, when the move was a rejection', async () => {
		const clock = new FakeClock(START);
		const reporterUserId = await insertAccount(unique('Warga Ditolak'));
		const complaint = complaintFixture({
			reporterId: await residentIdOf(reporterUserId),
			status: COMPLAINT_STATUS.rejected,
			rejectionReason: 'Bukan tanggung jawab komplek.'
		});

		await notifyComplaintStatusChanged(testDb.db, clock, complaint, null);

		const rows = await emailsTo(await emailOf(reporterUserId), COMPLAINT_STATUS_CHANGED_KIND);
		expect(rows[0].payload).toMatchObject({
			status: COMPLAINT_STATUS.rejected,
			note: null,
			rejectionReason: 'Bukan tanggung jawab komplek.'
		});
	});

	it('resolves instead of rejecting when enqueuing fails, and queues nothing', async () => {
		const reporterUserId = await insertAccount(unique('Warga Gagal Kirim'));
		const complaint = complaintFixture({ reporterId: await residentIdOf(reporterUserId) });

		await expect(
			notifyComplaintStatusChanged(testDb.db, new FailingClock(1), complaint, null)
		).resolves.toBeUndefined();
		expect(await emailsTo(await emailOf(reporterUserId), COMPLAINT_STATUS_CHANGED_KIND)).toEqual(
			[]
		);
	});
});

describe('createComplaint queues new-complaint to subscribed admins', () => {
	it('queues one email for an admin who turned the kind on, and none for one who did not', async () => {
		const clock = new FakeClock(START);
		const subscribedAdminId = await insertAdmin(unique('Pengurus Aktif'));
		await subscribe(subscribedAdminId, clock, SUBSCRIPTION_KIND.newComplaint, true);
		const silentAdminId = await insertAdmin(unique('Pengurus Nonaktif'));
		const reporterUserId = await insertAccount(unique('Warga Pelapor Baru'));

		const created = await report({ actorId: reporterUserId });

		const rows = await emailsTo(await emailOf(subscribedAdminId), NEW_COMPLAINT_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({ title: created.title, category: created.category });
		expect(await emailsTo(await emailOf(silentAdminId), NEW_COMPLAINT_KIND)).toEqual([]);
	});
});

describe('changeComplaintStatus queues own-complaint-status-changed to the reporter', () => {
	it('queues one email to the reporter for a handled transition', async () => {
		const reporterUserId = await insertAccount(unique('Warga Diproses'));
		const adminUserId = await insertAdmin(unique('Pengurus Proses'));
		const complaint = await insertComplaintRow(reporterUserId);
		const clock = new FakeClock(START);

		await changeComplaintStatus(testDb.db, clock, {
			actorId: adminUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.reviewing,
			note: 'Sedang ditinjau.'
		});

		const rows = await emailsTo(await emailOf(reporterUserId), COMPLAINT_STATUS_CHANGED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			status: COMPLAINT_STATUS.reviewing,
			note: 'Sedang ditinjau.'
		});
	});
});

describe('withdrawComplaint never emails the reporter', () => {
	it('queues nothing when the reporter withdraws their own complaint', async () => {
		const reporterUserId = await insertAccount(unique('Warga Menarik Sendiri'));
		const complaint = await insertComplaintRow(reporterUserId);

		await withdrawComplaint(testDb.db, new FakeClock(START), {
			actorId: reporterUserId,
			complaintId: complaint.id
		});

		expect(await emailsTo(await emailOf(reporterUserId), COMPLAINT_STATUS_CHANGED_KIND)).toEqual(
			[]
		);
	});
});

describe('own-complaint-status-changed cannot be switched off', () => {
	it('refuses setSubscriptionPreference(..., { kind: "own-complaint-status-changed", enabled: false })', async () => {
		const userId = await insertAccount(unique('Warga Wajib Keluhan'));

		await expect(
			setSubscriptionPreference(testDb.db, new FakeClock(START), {
				callerUserId: userId,
				residentId: await residentIdOf(userId),
				kind: SUBSCRIPTION_KIND.ownComplaintStatusChanged,
				enabled: false
			})
		).rejects.toBeInstanceOf(MandatorySubscriptionKindError);
	});
});

describe('new-complaint can be switched off per admin', () => {
	it('accepts enabled: false, and an admin who switched it off is no longer notified', async () => {
		const clock = new FakeClock(START);
		const adminId = await insertAdmin(unique('Pengurus Matikan'));
		await subscribe(adminId, clock, SUBSCRIPTION_KIND.newComplaint, true);

		await expect(
			subscribe(adminId, clock, SUBSCRIPTION_KIND.newComplaint, false)
		).resolves.toBeUndefined();

		const reporterUserId = await insertAccount(unique('Warga Pelapor Uji Matikan'));
		const complaint = complaintFixture({ reporterId: await residentIdOf(reporterUserId) });
		await notifyNewComplaint(testDb.db, clock, complaint);

		expect(await emailsTo(await emailOf(adminId), NEW_COMPLAINT_KIND)).toEqual([]);
	});
});

describe('newComplaintTemplate', () => {
	it('renders the title, the category and the link', () => {
		const payload = newComplaintPayload({
			title: 'Selokan mampet',
			category: 'fasilitas',
			url: 'https://komplek.local/admin/complaints/abc-123',
			locale: 'id'
		});

		const rendered = newComplaintTemplate(payload);

		expect(rendered.subject).toBe('Keluhan baru: Selokan mampet');
		expect(rendered.text).toContain('fasilitas');
		expect(rendered.text).toContain('https://komplek.local/admin/complaints/abc-123');
	});

	it('renders in the locale the payload names', () => {
		const rendered = newComplaintTemplate(
			newComplaintPayload({
				title: 'Blocked drain',
				category: 'facilities',
				url: 'https://komplek.local/admin/complaints/xyz-789',
				locale: 'en'
			})
		);

		expect(rendered.subject).toBe('New complaint: Blocked drain');
	});

	it.each([
		['title', { title: 1 }],
		['category', { category: 1 }],
		['url', { url: 1 }],
		['locale', { locale: 1 }]
	])('throws TypeError when %s is not a string', (_name, overrides) => {
		const payload = { title: 't', category: 'c', url: 'u', locale: 'id', ...overrides };

		expect(() => newComplaintTemplate(payload)).toThrow(TypeError);
	});
});

describe('complaintStatusChangedTemplate', () => {
	it('renders the status word and the note, never the description', () => {
		const payload = complaintStatusChangedPayload({
			title: 'Selokan mampet',
			status: COMPLAINT_STATUS.reviewing,
			note: 'Sudah dicek ke lokasi.',
			rejectionReason: null,
			url: 'https://komplek.local/complaints/abc-123',
			locale: 'id'
		});

		const rendered = complaintStatusChangedTemplate(payload);

		expect(rendered.subject).toBe('Status keluhan Anda berubah: Selokan mampet');
		expect(rendered.text).toContain('Ditinjau');
		expect(rendered.text).toContain('Sudah dicek ke lokasi.');
		expect(rendered.text).not.toContain('Uraian yang tidak boleh');
	});

	it('renders the rejection reason and no note line when there is no note', () => {
		const rendered = complaintStatusChangedTemplate(
			complaintStatusChangedPayload({
				title: 'Pagar rusak',
				status: COMPLAINT_STATUS.rejected,
				note: null,
				rejectionReason: 'Bukan tanggung jawab komplek.',
				url: 'https://komplek.local/complaints/xyz-789',
				locale: 'id'
			})
		);

		expect(rendered.text).toContain('Alasan: Bukan tanggung jawab komplek.');
		expect(rendered.text).not.toContain('Catatan:');
	});

	it('renders in the locale the payload names', () => {
		const rendered = complaintStatusChangedTemplate(
			complaintStatusChangedPayload({
				title: 'Blocked drain',
				status: COMPLAINT_STATUS.resolved,
				note: null,
				rejectionReason: null,
				url: 'https://komplek.local/complaints/def-456',
				locale: 'en'
			})
		);

		expect(rendered.subject).toBe('Your complaint status changed: Blocked drain');
		expect(rendered.text).toContain('Resolved');
	});

	it.each([
		['title', { title: 1 }],
		['status', { status: 'unknown' }],
		['note', { note: 1 }],
		['rejectionReason', { rejectionReason: 1 }],
		['url', { url: 1 }],
		['locale', { locale: 1 }]
	])('throws TypeError when %s is invalid', (_name, overrides) => {
		const payload = {
			title: 't',
			status: COMPLAINT_STATUS.new,
			note: null,
			rejectionReason: null,
			url: 'u',
			locale: 'id',
			...overrides
		};

		expect(() => complaintStatusChangedTemplate(payload)).toThrow(TypeError);
	});
});
