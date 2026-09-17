import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { ACTION, isAllowed, requirePermission, rolesOf } from '$lib/server/authz';
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

describe('isAllowed — every combination of roles and every known action', () => {
	// `ACTION.manageRoles` is, today, the only action this application knows, and it is permitted
	// to `superuser` alone. A later spec that adds an action allowed to a different role set has to
	// widen this expectation, not just `PERMISSIONS` — if it forgets, the case below for its new
	// action fails loudly instead of quietly passing.
	it.each(
		ROLE_SUBSETS.flatMap((roles) =>
			Object.values(ACTION).map((action) => ({
				roles,
				action,
				expected: roles.includes(ROLE.superuser)
			}))
		)
	)('roles $roles, action $action -> allowed: $expected', ({ roles, action, expected }) => {
		expect(isAllowed(roles, action)).toBe(expected);
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
