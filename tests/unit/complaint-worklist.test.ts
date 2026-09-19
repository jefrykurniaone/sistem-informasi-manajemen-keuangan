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
	type ComplaintStatus
} from '$lib/server/db/schema/complaint';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { complaintWorklistSummary } from '$lib/server/services/complaint';

/**
 * Story 20: "sebagai admin, saya ingin melihat berapa keluhan masuk dan selesai bulan ini". One
 * calendar month, read from a fake clock so a complaint filed or resolved the day before or the
 * day after the boundary proves the boundary is exact rather than approximate.
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
	options: {
		readonly status?: ComplaintStatus;
		readonly createdAt: string;
		readonly statusChangedAt?: string;
	}
): Promise<Complaint> {
	const reporterId = await residentIdOf(reporterUserId);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Lampu jalan mati'),
			category: 'penerangan',
			description: 'Lampu di depan blok C sudah tiga hari mati.',
			status: options.status ?? COMPLAINT_STATUS.new,
			visibility: COMPLAINT_VISIBILITY.private,
			rejectionReason: null,
			createdAt: new Date(options.createdAt),
			statusChangedAt: new Date(options.statusChangedAt ?? options.createdAt)
		})
		.returning();
	return row;
}

describe('complaintWorklistSummary', () => {
	// Every `it` below shares this file's one PostgreSQL schema — `src/lib/server/db/test-helpers.ts`
	// says so outright — so a complaint another test in this file wrote in June is still there when
	// the next one counts June. Each test therefore reads its own baseline first and asserts the
	// *change* its own fixtures made, rather than an absolute count nothing else in the file touched.

	// One fixture per case, each with its own before/after delta, so a one-sided boundary mistake
	// cannot cancel against another fixture the way a single `toBe(2)` over four inserts could — see
	// this ticket's hand-back. Months are UTC, matching `currentDay(clock)` in
	// `../occupancy/visibility.ts`, so these four instants are exactly the ones that matter:
	// the last instant of May, the first and last instants of June, and the first instant of July.
	// The fifth case is the one that actually distinguishes UTC from this machine's own zone
	// (`Asia/Jakarta`, UTC+7): `2026-06-30T20:00:00.000Z` is 03:00 on 1 July in Jakarta, so a
	// local-time implementation would wrongly drop it from June.
	it.each([
		{ createdAt: '2026-05-31T23:59:59.999Z', expected: 0, label: 'the last instant of May' },
		{ createdAt: '2026-06-01T00:00:00.000Z', expected: 1, label: 'the first instant of June' },
		{ createdAt: '2026-06-30T23:59:59.999Z', expected: 1, label: 'the last instant of June' },
		{ createdAt: '2026-07-01T00:00:00.000Z', expected: 0, label: 'the first instant of July' },
		{
			createdAt: '2026-06-30T20:00:00.000Z',
			expected: 1,
			label: 'inside June in UTC, inside July in Asia/Jakarta'
		}
	])(
		'counts a complaint created at $label ($createdAt) as $expected',
		async ({ createdAt, expected }) => {
			const reporterUserId = await insertAccount(unique('Warga Batas Bulan'));
			const adminUserId = await insertAccount(unique('Pengurus Batas Bulan'), ROLE.admin);
			const clock = new FakeClock('2026-06-15T12:00:00.000Z');
			const before = await complaintWorklistSummary(testDb.db, clock, adminUserId);

			await insertComplaint(reporterUserId, { createdAt });

			const after = await complaintWorklistSummary(testDb.db, clock, adminUserId);

			expect(after.openedThisMonth - before.openedThisMonth).toBe(expected);
		}
	);

	it('counts as resolved only what is resolved and moved into that status this month', async () => {
		const reporterUserId = await insertAccount(unique('Warga Selesai Bulan Ini'));
		const adminUserId = await insertAccount(unique('Pengurus Selesai Bulan Ini'), ROLE.admin);
		const clock = new FakeClock('2026-06-15T12:00:00.000Z');
		const before = await complaintWorklistSummary(testDb.db, clock, adminUserId);

		// Resolved this month.
		await insertComplaint(reporterUserId, {
			status: COMPLAINT_STATUS.resolved,
			createdAt: '2026-05-01T00:00:00.000Z',
			statusChangedAt: '2026-06-10T00:00:00.000Z'
		});
		// Resolved, but the move itself happened last month.
		await insertComplaint(reporterUserId, {
			status: COMPLAINT_STATUS.resolved,
			createdAt: '2026-05-01T00:00:00.000Z',
			statusChangedAt: '2026-05-20T00:00:00.000Z'
		});
		// Moved this month, but to a status that is not resolved.
		await insertComplaint(reporterUserId, {
			status: COMPLAINT_STATUS.working,
			createdAt: '2026-06-01T00:00:00.000Z',
			statusChangedAt: '2026-06-05T00:00:00.000Z'
		});

		const after = await complaintWorklistSummary(testDb.db, clock, adminUserId);

		expect(after.resolvedThisMonth - before.resolvedThisMonth).toBe(1);
	});

	it('is what a superuser sees too, the same split readAllComplaints makes', async () => {
		const reporterUserId = await insertAccount(unique('Warga Dilihat Super'));
		const superuserId = await insertAccount(unique('Superuser Ringkasan'), ROLE.superuser);
		const clock = new FakeClock('2026-06-15T12:00:00.000Z');
		const before = await complaintWorklistSummary(testDb.db, clock, superuserId);

		await insertComplaint(reporterUserId, { createdAt: '2026-06-02T00:00:00.000Z' });

		const after = await complaintWorklistSummary(testDb.db, clock, superuserId);

		expect(after.openedThisMonth - before.openedThisMonth).toBe(1);
	});

	it('refuses a resident who holds neither admin nor superuser', async () => {
		const residentUserId = await insertAccount(unique('Warga Biasa Ringkasan'));

		await expect(
			complaintWorklistSummary(testDb.db, new FakeClock(START), residentUserId)
		).rejects.toThrow(PermissionDeniedError);
	});
});
