import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { user } from '$lib/server/db/schema/auth';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { residentProfileForUser, updateOwnProfile } from '$lib/server/services/resident/profile';

/**
 * A resident reading and correcting their own name and phone number, against a real PostgreSQL —
 * see `$lib/server/services/resident/profile.ts` for the shape of the guard and for why a
 * `residents` row can legitimately be missing.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** Inserts a bare `user` row. */
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

/** Inserts a `residents` row for `userId`, as a completed undangan or persetujuan pendaftaran would. */
async function insertResident(userId: string, phone: string | null = null): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(residents).values({ id, userId, phone, createdAt: new Date(START) });
	return id;
}

describe('residentProfileForUser', () => {
	it('returns undefined for a signed-in account with no residents row yet', async () => {
		const userId = await insertUser('Warga Baru Daftar');

		expect(await residentProfileForUser(testDb.db, userId)).toBeUndefined();
	});

	it('reads the name off user and the phone number off residents', async () => {
		const userId = await insertUser('Warga Bertelepon');
		const residentId = await insertResident(userId, '0812-0000-0001');

		expect(await residentProfileForUser(testDb.db, userId)).toEqual({
			residentId,
			name: 'Warga Bertelepon',
			phone: '0812-0000-0001'
		});
	});

	it('reads a null phone number as null, not as an empty string', async () => {
		const userId = await insertUser('Warga Tanpa Telepon');
		const residentId = await insertResident(userId, null);

		expect(await residentProfileForUser(testDb.db, userId)).toEqual({
			residentId,
			name: 'Warga Tanpa Telepon',
			phone: null
		});
	});
});

describe('updateOwnProfile', () => {
	it("updates the caller's own name and phone number, and stamps user.updatedAt from the clock", async () => {
		const userId = await insertUser('Warga Lama');
		const residentId = await insertResident(userId, '0812-0000-0002');
		const clock = new FakeClock(START);
		clock.advance(60_000);

		await updateOwnProfile(testDb.db, clock, {
			callerUserId: userId,
			residentId,
			name: 'Warga Baru',
			phone: '0812-0000-0003'
		});

		expect(await residentProfileForUser(testDb.db, userId)).toEqual({
			residentId,
			name: 'Warga Baru',
			phone: '0812-0000-0003'
		});
		const [row] = await testDb.db
			.select({ updatedAt: user.updatedAt })
			.from(user)
			.where(eq(user.id, userId));
		expect(row?.updatedAt.getTime()).toBe(Date.parse(START) + 60_000);
	});

	it('clears the phone number when asked for null', async () => {
		const userId = await insertUser('Warga Menghapus Telepon');
		const residentId = await insertResident(userId, '0812-0000-0004');

		await updateOwnProfile(testDb.db, new FakeClock(START), {
			callerUserId: userId,
			residentId,
			name: 'Warga Menghapus Telepon',
			phone: null
		});

		expect((await residentProfileForUser(testDb.db, userId))?.phone).toBeNull();
	});

	it("refuses to update a residents row that is not the caller's own, and changes nothing", async () => {
		const ownerUserId = await insertUser('Warga Pemilik Data');
		const residentId = await insertResident(ownerUserId, '0812-0000-0005');
		const strangerUserId = await insertUser('Warga Lain');

		await expect(
			updateOwnProfile(testDb.db, new FakeClock(START), {
				callerUserId: strangerUserId,
				residentId,
				name: 'Nama Rekayasa',
				phone: '0812-9999-9999'
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await residentProfileForUser(testDb.db, ownerUserId)).toEqual({
			residentId,
			name: 'Warga Pemilik Data',
			phone: '0812-0000-0005'
		});
	});
});
