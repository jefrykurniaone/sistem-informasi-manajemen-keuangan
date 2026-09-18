import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaints,
	type Complaint,
	type ComplaintStatus,
	type ComplaintVisibility
} from '$lib/server/db/schema/complaint';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	changeComplaintStatus,
	getComplaint,
	listComplaints,
	withdrawComplaint
} from '$lib/server/services/complaint';
import {
	complaintAge,
	complaintStatusHistory,
	isComplaintStale,
	STALE_COMPLAINT_AGE_MILLISECONDS
} from '$lib/server/services/complaint/history';

/**
 * The Riwayat Status: one row per transition with who and when, and the age that is derived from
 * the newest of them. `docs/spec-keluhan-v1.md` asks for the second half to be proven with a fake
 * clock — "diuji dengan jam palsu yang dimajukan tujuh hari, membuktikan keluhan yang mandek muncul
 * sebagai tersorot di daftar admin" — which is what the last two describes do.
 */

const testDb = testDatabase();

const START = '2026-06-01T00:00:00.000Z';
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

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

/** A complaint written straight to the table as a fixture, created and last moved at `at`. */
async function insertComplaint(
	reporterUserId: string,
	options: {
		readonly status?: ComplaintStatus;
		readonly visibility?: ComplaintVisibility;
		readonly at?: string;
		readonly category?: string;
	} = {}
): Promise<Complaint> {
	const reporterId = await residentIdOf(reporterUserId);
	const at = new Date(options.at ?? START);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Pagar rusak'),
			category: options.category ?? 'keamanan',
			description: 'Pagar samping pos satpam roboh kena angin.',
			status: options.status ?? COMPLAINT_STATUS.new,
			visibility: options.visibility ?? COMPLAINT_VISIBILITY.private,
			rejectionReason: null,
			createdAt: at,
			statusChangedAt: at
		})
		.returning();
	return row;
}

describe('complaintStatusHistory', () => {
	it('keeps one row per transition, oldest first, naming who made each move', async () => {
		const reporterUserId = await insertAccount('Warga Beriwayat');
		const adminUserId = await insertAccount('Pengurus Beriwayat', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);
		const clock = new FakeClock(START);

		for (const to of [
			COMPLAINT_STATUS.reviewing,
			COMPLAINT_STATUS.working,
			COMPLAINT_STATUS.resolved
		]) {
			clock.advance(DAY_MILLISECONDS);
			await changeComplaintStatus(testDb.db, clock, {
				actorId: adminUserId,
				complaintId: complaint.id,
				to
			});
		}

		const history = await complaintStatusHistory(testDb.db, reporterUserId, complaint.id);

		expect(history.map((row) => [row.oldStatus, row.newStatus])).toEqual([
			[COMPLAINT_STATUS.new, COMPLAINT_STATUS.reviewing],
			[COMPLAINT_STATUS.reviewing, COMPLAINT_STATUS.working],
			[COMPLAINT_STATUS.working, COMPLAINT_STATUS.resolved]
		]);
		expect(history.map((row) => row.actorName)).toEqual([
			'Pengurus Beriwayat',
			'Pengurus Beriwayat',
			'Pengurus Beriwayat'
		]);
		expect(history.map((row) => row.occurredAt)).toEqual([
			new Date('2026-06-02T00:00:00.000Z'),
			new Date('2026-06-03T00:00:00.000Z'),
			new Date('2026-06-04T00:00:00.000Z')
		]);
	});

	it('records a withdrawal as a transition like any other, attributed to the reporter', async () => {
		const reporterUserId = await insertAccount('Warga Menarik Riwayat');
		const complaint = await insertComplaint(reporterUserId);

		await withdrawComplaint(testDb.db, new FakeClock(START), {
			actorId: reporterUserId,
			complaintId: complaint.id
		});

		const history = await complaintStatusHistory(testDb.db, reporterUserId, complaint.id);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			oldStatus: COMPLAINT_STATUS.new,
			newStatus: COMPLAINT_STATUS.withdrawn,
			actorId: await residentIdOf(reporterUserId),
			actorName: 'Warga Menarik Riwayat',
			note: null
		});
	});

	it.each([
		{ who: 'the reporter', role: undefined, own: true, sees: 1, signedOut: false },
		// Story 19: "sebagai superuser, saya ingin melihat siapa mengubah status apa dan kapan".
		{ who: 'a superuser', role: ROLE.superuser, own: false, sees: 1, signedOut: false },
		{ who: 'an admin', role: ROLE.admin, own: false, sees: 1, signedOut: false },
		// A private complaint's timeline is as private as the complaint.
		{ who: 'a neighbour', role: undefined, own: false, sees: 0, signedOut: false },
		{ who: 'nobody signed in', role: undefined, own: false, sees: 0, signedOut: true }
	])('shows $who $sees row(s) of a private complaint', async ({ role, own, sees, signedOut }) => {
		const reporterUserId = await insertAccount(unique('Warga Riwayat Pribadi'));
		const adminUserId = await insertAccount(unique('Pengurus Riwayat Pribadi'), ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);
		await changeComplaintStatus(testDb.db, new FakeClock(START), {
			actorId: adminUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.reviewing
		});

		const viewerUserId = own
			? reporterUserId
			: await insertAccount(unique('Pembaca Riwayat'), role);

		const history = await complaintStatusHistory(
			testDb.db,
			signedOut ? null : viewerUserId,
			complaint.id
		);

		expect(history).toHaveLength(sees);
	});
});

describe('complaintAge', () => {
	it('is the distance from the last status change to whatever the clock says now', () => {
		const clock = new FakeClock('2026-06-08T00:00:00.000Z');

		expect(complaintAge(clock, new Date('2026-06-01T00:00:00.000Z'))).toBe(7 * DAY_MILLISECONDS);
	});

	it('is zero rather than negative when the clock stands before the stored instant', () => {
		const clock = new FakeClock('2026-05-01T00:00:00.000Z');

		expect(complaintAge(clock, new Date('2026-06-01T00:00:00.000Z'))).toBe(0);
	});

	it('measures from the last move, not from when the complaint was reported', async () => {
		const reporterUserId = await insertAccount('Warga Berumur');
		const adminUserId = await insertAccount('Pengurus Berumur', ROLE.admin);
		const complaint = await insertComplaint(reporterUserId);
		const clock = new FakeClock(START);

		clock.advance(3 * DAY_MILLISECONDS);
		await changeComplaintStatus(testDb.db, clock, {
			actorId: adminUserId,
			complaintId: complaint.id,
			to: COMPLAINT_STATUS.reviewing
		});
		clock.advance(7 * DAY_MILLISECONDS);

		const read = await getComplaint(testDb.db, clock, adminUserId, complaint.id);

		expect(read.ageMilliseconds).toBe(7 * DAY_MILLISECONDS);
	});
});

describe('isComplaintStale', () => {
	it('is seven days, and the threshold is a constant rather than a setting', () => {
		expect(STALE_COMPLAINT_AGE_MILLISECONDS).toBe(7 * DAY_MILLISECONDS);
	});

	it.each([
		{ age: 7 * DAY_MILLISECONDS - 1, stale: false },
		{ age: 7 * DAY_MILLISECONDS, stale: false },
		{ age: 7 * DAY_MILLISECONDS + 1, stale: true },
		{ age: 30 * DAY_MILLISECONDS, stale: true }
	])('calls an open complaint aged $age stale: $stale', ({ age, stale }) => {
		const changedAt = new Date(START);
		const clock = new FakeClock(new Date(changedAt.getTime() + age));

		expect(
			isComplaintStale(clock, { status: COMPLAINT_STATUS.new, statusChangedAt: changedAt })
		).toBe(stale);
	});

	it.each([COMPLAINT_STATUS.resolved, COMPLAINT_STATUS.rejected, COMPLAINT_STATUS.withdrawn])(
		'never calls a %s complaint stale, however long ago it got there',
		(status) => {
			const changedAt = new Date(START);
			const clock = new FakeClock(new Date(changedAt.getTime() + 365 * DAY_MILLISECONDS));

			expect(isComplaintStale(clock, { status, statusChangedAt: changedAt })).toBe(false);
		}
	);
});

describe('listComplaints, as the admin queue reads it', () => {
	it('puts the longest wait first and highlights what has hung for more than seven days', async () => {
		const reporterUserId = await insertAccount('Warga Antrean');
		const adminUserId = await insertAccount('Pengurus Antrean', ROLE.admin);
		// One category of its own, so the assertion is about this test's three rows rather than about
		// everything every other test in this file happens to have left behind.
		const category = unique('kategori');
		const oldest = await insertComplaint(reporterUserId, {
			at: '2026-06-01T00:00:00.000Z',
			category
		});
		const middle = await insertComplaint(reporterUserId, {
			at: '2026-06-05T00:00:00.000Z',
			category
		});
		const newest = await insertComplaint(reporterUserId, {
			at: '2026-06-08T00:00:00.000Z',
			category
		});
		const clock = new FakeClock('2026-06-09T00:00:00.000Z');

		const listed = await listComplaints(testDb.db, clock, {
			viewerUserId: adminUserId,
			category
		});

		expect(listed.map((row) => row.id)).toEqual([oldest.id, middle.id, newest.id]);
		expect(listed.map((row) => row.stale)).toEqual([true, false, false]);
	});

	it('narrows to what can still move when asked for the open queue', async () => {
		const reporterUserId = await insertAccount('Warga Terbuka');
		const adminUserId = await insertAccount('Pengurus Terbuka', ROLE.admin);
		const category = unique('kategori');
		const open = await insertComplaint(reporterUserId, {
			status: COMPLAINT_STATUS.working,
			category
		});
		await insertComplaint(reporterUserId, { status: COMPLAINT_STATUS.resolved, category });
		await insertComplaint(reporterUserId, { status: COMPLAINT_STATUS.withdrawn, category });

		const listed = await listComplaints(testDb.db, new FakeClock(START), {
			viewerUserId: adminUserId,
			category,
			onlyOpen: true
		});

		expect(listed.map((row) => row.id)).toEqual([open.id]);
	});
});
