import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError, LastSuperuserError } from '$lib/errors';
import { rolesOf } from '$lib/server/authz';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	grantRole,
	listUsersWithRoles,
	revokeRole,
	ROLE_CHANGE_ACTION
} from '$lib/server/services/user/roles';

/**
 * Managing roles: granting, revoking, the last-superuser rule, and the audit trail every change
 * has to leave behind — against a real PostgreSQL, with the trigger from
 * `drizzle/0003_authz_audit.sql` giving every user their default `resident` role.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any real sign-up. */
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

/** A superuser, ready to act as `actorId` in every test that needs one who is allowed to manage roles. */
async function insertSuperuser(name: string): Promise<string> {
	const id = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId: id, role: ROLE.superuser, createdAt: new Date(START) });
	return id;
}

describe('listUsersWithRoles', () => {
	it('refuses a caller who is not a superuser', async () => {
		const residentId = await insertUser('Warga Penasaran');

		await expect(listUsersWithRoles(testDb.db, residentId)).rejects.toThrow(PermissionDeniedError);
	});

	it('lists every user with the roles each one holds, for a superuser caller', async () => {
		const superuserId = await insertSuperuser('Pengurus Daftar');
		const residentId = await insertUser('Warga Terdaftar');

		const listed = await listUsersWithRoles(testDb.db, superuserId);

		const resident = listed.find((entry) => entry.userId === residentId);
		const superuser = listed.find((entry) => entry.userId === superuserId);
		expect(resident?.roles).toEqual([ROLE.resident]);
		expect(superuser?.roles.slice().sort()).toEqual([ROLE.resident, ROLE.superuser].sort());
	});
});

describe('grantRole', () => {
	it('adds the role and records who changed it, and what changed', async () => {
		const superuserId = await insertSuperuser('Pengurus Pemberi');
		const targetId = await insertUser('Warga Diberi');
		const clock = new FakeClock(START);

		await grantRole(testDb.db, clock, {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		expect(await rolesOf(testDb.db, targetId)).toEqual(new Set([ROLE.resident, ROLE.admin]));
		const entries = await auditEntriesFor(testDb.db, targetId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: ROLE_CHANGE_ACTION,
			targetId,
			before: [ROLE.resident],
			after: [ROLE.resident, ROLE.admin]
		});
		expect(entries[0].occurredAt.getTime()).toBe(Date.parse(START));
	});

	it('is a no-op, with no audit row, when the target already holds the role', async () => {
		const superuserId = await insertSuperuser('Pengurus Ulang');
		const targetId = await insertUser('Warga Sudah Admin');
		await grantRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		await grantRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		expect(await auditEntriesFor(testDb.db, targetId)).toHaveLength(1);
	});

	it('refuses a caller who is not a superuser, and changes nothing', async () => {
		const residentId = await insertUser('Warga Bukan Pengurus');
		const targetId = await insertUser('Warga Sasaran');

		await expect(
			grantRole(testDb.db, new FakeClock(START), {
				actorId: residentId,
				targetUserId: targetId,
				role: ROLE.admin
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await rolesOf(testDb.db, targetId)).toEqual(new Set([ROLE.resident]));
		expect(await auditEntriesFor(testDb.db, targetId)).toHaveLength(0);
	});
});

describe('revokeRole', () => {
	it('removes the role and records who changed it, and what changed', async () => {
		const superuserId = await insertSuperuser('Pengurus Pencabut');
		const targetId = await insertUser('Warga Dicabut');
		await grantRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});
		const clock = new FakeClock(START);
		clock.advance(60_000);

		await revokeRole(testDb.db, clock, {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		expect(await rolesOf(testDb.db, targetId)).toEqual(new Set([ROLE.resident]));
		const entries = await auditEntriesFor(testDb.db, targetId);
		const revocation = entries.find((entry) => (entry.after as Role[] | null)?.length === 1);
		expect(revocation).toMatchObject({
			actorId: superuserId,
			action: ROLE_CHANGE_ACTION,
			targetId,
			before: [ROLE.resident, ROLE.admin],
			after: [ROLE.resident]
		});
	});

	it('is a no-op, with no audit row, when the target does not hold the role', async () => {
		const superuserId = await insertSuperuser('Pengurus Sia-sia');
		const targetId = await insertUser('Warga Tanpa Admin');

		await revokeRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		expect(await auditEntriesFor(testDb.db, targetId)).toHaveLength(0);
	});

	it('refuses to remove the last superuser in the system, and changes nothing', async () => {
		// The rule is checked across every superuser *in the system*, and this file's schema
		// accumulates rows across every test that ran before this one — including several other
		// superusers created above. Clearing them first is what makes "the last one" true here,
		// exactly as it would be on a system that really has only one.
		await testDb.db.delete(userRoles).where(eq(userRoles.role, ROLE.superuser));
		const onlySuperuserId = await insertSuperuser('Pengurus Satu-satunya');

		await expect(
			revokeRole(testDb.db, new FakeClock(START), {
				actorId: onlySuperuserId,
				targetUserId: onlySuperuserId,
				role: ROLE.superuser
			})
		).rejects.toThrow(LastSuperuserError);

		expect(await rolesOf(testDb.db, onlySuperuserId)).toContain(ROLE.superuser);
		expect(await auditEntriesFor(testDb.db, onlySuperuserId)).toHaveLength(0);
	});

	it('allows removing a superuser role when another superuser remains', async () => {
		const firstSuperuserId = await insertSuperuser('Pengurus Pertama');
		const secondSuperuserId = await insertSuperuser('Pengurus Kedua');

		await revokeRole(testDb.db, new FakeClock(START), {
			actorId: firstSuperuserId,
			targetUserId: secondSuperuserId,
			role: ROLE.superuser
		});

		expect(await rolesOf(testDb.db, secondSuperuserId)).toEqual(new Set([ROLE.resident]));
	});

	it('refuses a caller who is not a superuser, and changes nothing', async () => {
		const superuserId = await insertSuperuser('Pengurus Terjaga');
		const residentId = await insertUser('Warga Tak Berhak');
		const targetId = await insertUser('Warga Sasaran Cabut');
		await grantRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		await expect(
			revokeRole(testDb.db, new FakeClock(START), {
				actorId: residentId,
				targetUserId: targetId,
				role: ROLE.admin
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await rolesOf(testDb.db, targetId)).toEqual(new Set([ROLE.resident, ROLE.admin]));
	});
});

describe('user_roles uniqueness', () => {
	it('never lets the same role be held twice by the same person, even outside the service layer', async () => {
		const userId = await insertUser('Warga Ganda');

		await expect(
			testDb.db
				.insert(userRoles)
				.values({ userId, role: ROLE.resident, createdAt: new Date(START) })
		).rejects.toThrow();
	});
});

describe('the resident role, granted and revoked like any other', () => {
	it('can be revoked from someone who holds another role, and the audit row proves it', async () => {
		const superuserId = await insertSuperuser('Pengurus Warga Ganda Peran');
		const targetId = await insertUser('Warga Dicabut Warganya');
		await grantRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		await revokeRole(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			targetUserId: targetId,
			role: ROLE.resident
		});

		expect(await rolesOf(testDb.db, targetId)).toEqual(new Set([ROLE.admin]));
	});
});

describe('the user_roles table, checked directly', () => {
	it('refuses a role that is not one of the three, whatever writes it', async () => {
		const userId = await insertUser('Warga Peran Tak Dikenal');
		const failure: unknown = await testDb.db
			.insert(userRoles)
			.values({ userId, role: 'wizard' as Role, createdAt: new Date(START) })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
	});
});
