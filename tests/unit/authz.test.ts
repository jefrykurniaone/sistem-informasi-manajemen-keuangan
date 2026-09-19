import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { ACTION, isAllowed, requirePermission, rolesOf, type Action } from '$lib/server/authz';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, ROLES, userRoles, type Role } from '$lib/server/db/schema/authz';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The permission guard: the pure decision table in `isAllowed`/`requirePermission`, and the
 * database trigger that gives every new `user` row its default `resident` role.
 */

const testDb = testDatabase();

/** Every possible combination of roles a person could hold, including holding none. */
const ROLE_SUBSETS: readonly (readonly Role[])[] = subsetsOf(ROLES);

/** Inserts a bare `user` row, exactly as better-auth's own insert would look to the trigger. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date('2026-01-01T00:00:00.000Z');
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

/** Grants a role directly, bypassing the service layer — this file tests the guard, not `roles.ts`. */
async function grant(userId: string, role: Role): Promise<void> {
	await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date() });
}

/**
 * The actions whose role set is deliberately something other than "superuser alone", and which set
 * each of them really is.
 *
 * Read together with `expectedRolesFor` below, this is a *rule* rather than a table of every
 * action: anything not named here — including an action added after this file was last edited — is
 * still expected to be superuser-only, and the sweep still walks `Object.values(ACTION)` to find
 * out which actions exist. That shape is on purpose. A table listing every action by name would
 * make this file the second place the permission map lives, and a ticket adding an ordinary
 * superuser-only action would fail a test it never touched. As it is, a new superuser-only action
 * passes without anybody editing this file, and a new action granted to somebody else fails loudly
 * until whoever made that decision comes here and writes it down — which is the whole reason this
 * sweep exists.
 */
const ACTIONS_NOT_SUPERUSER_ONLY: Readonly<Partial<Record<Action, readonly Role[]>>> = {
	// `CONTEXT.md` puts "mengelola Post" on Admin and leaves it off Superuser, and
	// `docs/spec-fondasi-v1.md` makes the three roles a set rather than a ladder. See the argument
	// recorded next to `PERMISSIONS` in `src/lib/server/authz.ts`.
	[ACTION.managePosts]: [ROLE.admin],
	// `CONTEXT.md` puts "menangani Keluhan" on Admin and leaves it off Superuser, the same reading
	// that put `managePosts` on Admin: moving a complaint between statuses changes neither the past
	// nor anybody's rights, which is what Superuser's list is for.
	[ACTION.handleComplaints]: [ROLE.admin],
	// Both, unlike every other entry here. `docs/spec-keluhan-v1.md` says a `pribadi` complaint is
	// readable by "pemegang peran admin atau superuser", and user story 19 — "sebagai superuser,
	// saya ingin melihat siapa mengubah status apa dan kapan" — is a read of the Riwayat Status by
	// somebody the spec never asks to handle a complaint. See `PERMISSIONS`.
	[ACTION.readAllComplaints]: [ROLE.admin, ROLE.superuser],
	// `CONTEXT.md` puts "mencatat Transaksi Kas" on Admin and leaves it off Superuser, the same
	// reading that put `managePosts` and `handleComplaints` there. A Koreksi does not change the past
	// either: it adds a reversing row and leaves the row it corrects exactly as it was, which is what
	// keeps an append-only cash book out of Superuser's "mengubah masa lalu" sentence. Recording the
	// Saldo awal stays `recordOpeningBalance`, and stays Superuser's.
	[ACTION.recordCashTransactions]: [ROLE.admin],
	// Both, the second entry here that is not a single set. The period screen's only button is
	// superuser-only — `CONTEXT.md` names "pembukaan kunci Periode" in Superuser's sentence — so the
	// list is deliberately readable by somebody who may not press it: an admin is refused by a locked
	// month when recording a Transaksi Kas, and an admin is who publishes the Laporan Bulanan that
	// locks one. Superuser alone would answer 403 to the role that causes every lock on the screen.
	// `ACTION.unlockPeriods` itself needs no entry, because it really is superuser-only.
	[ACTION.readPeriods]: [ROLE.admin, ROLE.superuser],
	// `docs/spec-iuran-v1.md:220` puts the daftar penunggak on Admin alone — "hanya bisa dibuka oleh
	// admin" — the same reading that put `managePosts`, `handleComplaints` and
	// `recordCashTransactions` there: none of them change the past or who may do what, which is what
	// keeps them out of Superuser's sentence in `CONTEXT.md`.
	[ACTION.readOverdue]: [ROLE.admin],
	// `CONTEXT.md` puts "memverifikasi Pembayaran" on Admin and leaves it off Superuser, the same
	// reading that put `managePosts`, `handleComplaints`, `recordCashTransactions` and `readOverdue`
	// there: verifying a payment records what happened rather than changing the past or anybody's
	// rights. See the argument recorded next to the action in `src/lib/server/authz.ts`.
	[ACTION.verifyPayments]: [ROLE.admin],
	// `CONTEXT.md` ends Admin's own sentence with "dan menerbitkan Laporan Bulanan" and leaves it off
	// Superuser, so a superuser who is not also an admin cannot publish one. Publishing adds a
	// numbered document and closes a month; the direction that changes the past is reopening one, and
	// that is `unlockPeriods`, which really is superuser-only and therefore needs no entry here.
	[ACTION.publishReports]: [ROLE.admin]
};

/** Which roles `action` is expected to be permitted to. Superuser alone unless stated otherwise. */
function expectedRolesFor(action: Action): readonly Role[] {
	return ACTIONS_NOT_SUPERUSER_ONLY[action] ?? [ROLE.superuser];
}

describe('isAllowed — every combination of roles and every known action', () => {
	it.each(
		ROLE_SUBSETS.flatMap((roles) =>
			Object.values(ACTION).map((action) => ({
				roles,
				action,
				expected: expectedRolesFor(action).some((permitted) => roles.includes(permitted))
			}))
		)
	)('roles $roles, action $action -> allowed: $expected', ({ roles, action, expected }) => {
		expect(isAllowed(roles, action)).toBe(expected);
	});

	it('permits managePosts to an admin and refuses it to a superuser who is not one', () => {
		// The one case the sweep above would also cover, spelled out on its own because it is the
		// first time in this run that holding `superuser` is not enough for something.
		expect(isAllowed([ROLE.admin], ACTION.managePosts)).toBe(true);
		expect(isAllowed([ROLE.superuser], ACTION.managePosts)).toBe(false);
		expect(isAllowed([ROLE.resident], ACTION.managePosts)).toBe(false);
	});

	it('lets a superuser read every Keluhan without letting them handle one', () => {
		// The first action pair in this table where reading and writing are held by different sets,
		// spelled out because the split is the decision rather than a consequence of one: a superuser
		// sees the whole queue and every private complaint on it, and the buttons on that queue still
		// refuse them.
		expect(isAllowed([ROLE.superuser], ACTION.readAllComplaints)).toBe(true);
		expect(isAllowed([ROLE.superuser], ACTION.handleComplaints)).toBe(false);
		expect(isAllowed([ROLE.admin], ACTION.readAllComplaints)).toBe(true);
		expect(isAllowed([ROLE.admin], ACTION.handleComplaints)).toBe(true);
		expect(isAllowed([ROLE.resident], ACTION.readAllComplaints)).toBe(false);
		expect(isAllowed([ROLE.resident], ACTION.handleComplaints)).toBe(false);
	});
});

describe('the default resident role', () => {
	it('is granted to a brand new user by the database, without any service call', async () => {
		const userId = await insertUser('Warga Baru');

		expect(await rolesOf(testDb.db, userId)).toEqual(new Set([ROLE.resident]));
	});

	it('is not granted twice to the same person', async () => {
		// The trigger runs once, on insert; nothing else re-runs it, so a person who is later given
		// more roles still holds exactly one resident row, not one per role change.
		const userId = await insertUser('Warga Lain');
		await grant(userId, ROLE.admin);

		const rows = await testDb.db.select().from(userRoles).where(eq(userRoles.userId, userId));
		expect(rows.filter((row) => row.role === ROLE.resident)).toHaveLength(1);
	});
});

describe('rolesOf', () => {
	it('reads back every role a person holds, as a set', async () => {
		const userId = await insertUser('Warga Berperan');
		await grant(userId, ROLE.admin);
		await grant(userId, ROLE.superuser);

		expect(await rolesOf(testDb.db, userId)).toEqual(
			new Set([ROLE.resident, ROLE.admin, ROLE.superuser])
		);
	});
});

describe('requirePermission', () => {
	it('resolves for a caller who holds a permitting role', async () => {
		const superuserId = await insertUser('Pengurus Utama');
		await grant(superuserId, ROLE.superuser);

		await expect(
			requirePermission(testDb.db, superuserId, ACTION.manageRoles)
		).resolves.toBeUndefined();
	});

	it('throws PermissionDeniedError, naming the caller and the action, for one who does not', async () => {
		const residentId = await insertUser('Warga Biasa');

		const failure = requirePermission(testDb.db, residentId, ACTION.manageRoles);

		await expect(failure).rejects.toThrow(PermissionDeniedError);
		await expect(failure).rejects.toMatchObject({
			callerId: residentId,
			action: ACTION.manageRoles
		});
	});
});

/** Every subset of `items`, including the empty one, in no particular order. */
function subsetsOf<T>(items: readonly T[]): readonly T[][] {
	return items.reduce<T[][]>(
		(subsets, item) => [...subsets, ...subsets.map((subset) => [...subset, item])],
		[[]]
	);
}
