import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { user } from '$lib/server/db/schema/auth';
import { residents } from '$lib/server/db/schema/resident';
import { subscriptions } from '$lib/server/db/schema/subscription';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { SUBSCRIPTION_KIND, SUBSCRIPTION_KINDS } from '$lib/server/services/subscription/kinds';
import {
	MandatorySubscriptionKindError,
	ensureDefaultSubscriptions,
	residentsSubscribedTo,
	setSubscriptionPreference,
	subscriptionPreferencesFor
} from '$lib/server/services/subscription';

/**
 * Langganan: the registry of kinds, the default a fresh resident starts with, the rule that a
 * mandatory kind cannot be switched off, and the "who is subscribed" contract every later spec
 * reads — against a real PostgreSQL. See `$lib/server/services/subscription/kinds.ts` and
 * `$lib/server/services/subscription/index.ts`.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

const MANDATORY_KINDS = SUBSCRIPTION_KINDS.filter((definition) => definition.mandatory).map(
	(definition) => definition.kind
);

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

/** Inserts a `residents` row for `userId`. */
async function insertResident(userId: string): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(residents).values({ id, userId, phone: null, createdAt: new Date(START) });
	return id;
}

/** Whichever `enabled` value is stored for `residentId`/`kind`, or `undefined` when there is no row. */
async function storedEnabled(residentId: string, kind: string): Promise<boolean | undefined> {
	const [row] = await testDb.db
		.select({ enabled: subscriptions.enabled })
		.from(subscriptions)
		.where(and(eq(subscriptions.residentId, residentId), eq(subscriptions.kind, kind)));
	return row?.enabled;
}

describe('subscriptionPreferencesFor', () => {
	it('lists every known kind at its registry default when the resident has no rows at all', async () => {
		const residentId = await insertResident(await insertUser('Warga Baru Terdaftar'));

		const preferences = await subscriptionPreferencesFor(testDb.db, residentId);

		expect(preferences.map((p) => p.kind).sort()).toEqual(
			SUBSCRIPTION_KINDS.map((d) => d.kind).sort()
		);
		for (const definition of SUBSCRIPTION_KINDS) {
			const preference = preferences.find((p) => p.kind === definition.kind);
			expect(preference).toMatchObject({
				enabled: definition.defaultEnabled,
				mandatory: definition.mandatory
			});
		}
	});

	it("reflects a row that already exists over the registry's default", async () => {
		const residentId = await insertResident(await insertUser('Warga Sudah Menjawab'));
		await testDb.db.insert(subscriptions).values({
			residentId,
			kind: SUBSCRIPTION_KIND.monthlyReport,
			enabled: true,
			createdAt: new Date(START)
		});

		const preferences = await subscriptionPreferencesFor(testDb.db, residentId);

		expect(preferences.find((p) => p.kind === SUBSCRIPTION_KIND.monthlyReport)?.enabled).toBe(true);
	});
});

describe('ensureDefaultSubscriptions', () => {
	it('writes one row per known kind, at its registry default', async () => {
		const residentId = await insertResident(await insertUser('Warga Baru Diundang'));

		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);

		for (const definition of SUBSCRIPTION_KINDS) {
			expect(await storedEnabled(residentId, definition.kind)).toBe(definition.defaultEnabled);
		}
	});

	it('is idempotent: calling it again never overwrites an answer already given', async () => {
		const userId = await insertUser('Warga Diundang Dua Kali');
		const residentId = await insertResident(userId);
		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);
		await setSubscriptionPreference(testDb.db, new FakeClock(START), {
			callerUserId: userId,
			residentId,
			kind: SUBSCRIPTION_KIND.monthlyReport,
			enabled: true
		});

		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);

		expect(await storedEnabled(residentId, SUBSCRIPTION_KIND.monthlyReport)).toBe(true);
	});
});

describe('setSubscriptionPreference', () => {
	it('lets a resident switch an opt-in kind on', async () => {
		const userId = await insertUser('Warga Ingin Laporan');
		const residentId = await insertResident(userId);
		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);

		await setSubscriptionPreference(testDb.db, new FakeClock(START), {
			callerUserId: userId,
			residentId,
			kind: SUBSCRIPTION_KIND.newPost,
			enabled: true
		});

		expect(await storedEnabled(residentId, SUBSCRIPTION_KIND.newPost)).toBe(true);
	});

	it('lets a resident switch an opt-in kind back off', async () => {
		const userId = await insertUser('Warga Membatalkan Laporan');
		const residentId = await insertResident(userId);
		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);
		await setSubscriptionPreference(testDb.db, new FakeClock(START), {
			callerUserId: userId,
			residentId,
			kind: SUBSCRIPTION_KIND.monthlyReport,
			enabled: true
		});

		await setSubscriptionPreference(testDb.db, new FakeClock(START), {
			callerUserId: userId,
			residentId,
			kind: SUBSCRIPTION_KIND.monthlyReport,
			enabled: false
		});

		expect(await storedEnabled(residentId, SUBSCRIPTION_KIND.monthlyReport)).toBe(false);
	});

	it.each(MANDATORY_KINDS)(
		'refuses to switch the mandatory kind "%s" off, and changes nothing',
		async (kind) => {
			const userId = await insertUser(`Warga Menolak Mematikan ${kind}`);
			const residentId = await insertResident(userId);
			await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);

			await expect(
				setSubscriptionPreference(testDb.db, new FakeClock(START), {
					callerUserId: userId,
					residentId,
					kind,
					enabled: false
				})
			).rejects.toThrow(MandatorySubscriptionKindError);

			expect(await storedEnabled(residentId, kind)).toBe(true);
		}
	);

	it('allows turning a mandatory kind back on, which is never refused', async () => {
		const userId = await insertUser('Warga Menyalakan Tagihan');
		const residentId = await insertResident(userId);
		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);

		await expect(
			setSubscriptionPreference(testDb.db, new FakeClock(START), {
				callerUserId: userId,
				residentId,
				kind: SUBSCRIPTION_KIND.invoiceIssued,
				enabled: true
			})
		).resolves.toBeUndefined();
	});

	it('refuses a caller who does not own the resident row, and changes nothing', async () => {
		const ownerUserId = await insertUser('Warga Pemilik Langganan');
		const residentId = await insertResident(ownerUserId);
		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);
		const strangerUserId = await insertUser('Warga Lain Coba Ubah');

		await expect(
			setSubscriptionPreference(testDb.db, new FakeClock(START), {
				callerUserId: strangerUserId,
				residentId,
				kind: SUBSCRIPTION_KIND.newPost,
				enabled: true
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await storedEnabled(residentId, SUBSCRIPTION_KIND.newPost)).toBe(false);
	});
});

describe('residentsSubscribedTo', () => {
	it('includes a resident with no rows at all, for a mandatory kind defaulting to enabled', async () => {
		const userId = await insertUser('Warga Belum Diseed');
		const residentId = await insertResident(userId);

		const subscribed = await residentsSubscribedTo(testDb.db, SUBSCRIPTION_KIND.invoiceIssued);

		expect(subscribed.map((r) => r.residentId)).toContain(residentId);
	});

	it('excludes a resident with no rows at all, for an opt-in kind defaulting to disabled', async () => {
		const userId = await insertUser('Warga Belum Diseed Opsional');
		const residentId = await insertResident(userId);

		const subscribed = await residentsSubscribedTo(testDb.db, SUBSCRIPTION_KIND.newPost);

		expect(subscribed.map((r) => r.residentId)).not.toContain(residentId);
	});

	it('includes a resident who explicitly opted into an opt-in kind', async () => {
		const userId = await insertUser('Warga Opt In Post Baru');
		const residentId = await insertResident(userId);
		await ensureDefaultSubscriptions(testDb.db, new FakeClock(START), residentId);
		await setSubscriptionPreference(testDb.db, new FakeClock(START), {
			callerUserId: userId,
			residentId,
			kind: SUBSCRIPTION_KIND.newPost,
			enabled: true
		});

		const subscribed = await residentsSubscribedTo(testDb.db, SUBSCRIPTION_KIND.newPost);

		expect(subscribed).toContainEqual({
			residentId,
			userId,
			name: 'Warga Opt In Post Baru',
			email: `${userId}@komplek.local`
		});
	});
});
