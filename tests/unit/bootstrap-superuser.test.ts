import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEntriesFor } from '$lib/server/audit';
import { rolesOf } from '$lib/server/authz';
import { auditLog } from '$lib/server/db/schema/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { bootstrapSuperuser, MACHINE_OPERATOR_ACTOR_ID } from '$lib/server/services/user/bootstrap';
import { grantRole, ROLE_CHANGE_ACTION } from '$lib/server/services/user/roles';

/**
 * The way the first superuser comes into being, against a real PostgreSQL — with the trigger from
 * `drizzle/0003_authz_audit.sql` giving every new user their default `resident` role, exactly as a
 * freshly migrated database would.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any real sign-up. */
async function insertUser(name: string, email: string): Promise<string> {
	const id = randomUUID().replaceAll('-', '');
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** How many audit rows this file's schema holds, for the tests that assert nothing was written. */
async function auditRowCount(): Promise<number> {
	return (await testDb.db.select({ id: auditLog.id }).from(auditLog)).length;
}

describe('bootstrapSuperuser', () => {
	it('grants the role and records the change against the machine operator', async () => {
		const email = 'pengurus.pertama@komplek.local';
		const userId = await insertUser('Pengurus Pertama', email);

		const outcome = await bootstrapSuperuser(testDb.db, new FakeClock(START), email);

		expect(outcome).toEqual({ kind: 'granted', email, userId });
		expect(await rolesOf(testDb.db, userId)).toEqual(new Set([ROLE.resident, ROLE.superuser]));

		const entries = await auditEntriesFor(testDb.db, userId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: MACHINE_OPERATOR_ACTOR_ID,
			action: ROLE_CHANGE_ACTION,
			targetId: userId,
			before: [ROLE.resident],
			after: [ROLE.resident, ROLE.superuser]
		});
		expect(entries[0].occurredAt.getTime()).toBe(Date.parse(START));
	});

	it('cannot be confused with a real account: the actor id is not a shape better-auth ever writes', () => {
		// better-auth draws identifiers from `a-zA-Z0-9` only, so a colon is what keeps a reader
		// filtering the audit log by user id from ever matching this row by accident.
		expect(MACHINE_OPERATOR_ACTOR_ID).toContain(':');
		expect(/^[a-zA-Z0-9]+$/.test(MACHINE_OPERATOR_ACTOR_ID)).toBe(false);
	});

	it('changes nothing on a second run: no second role row, no second audit row', async () => {
		const email = 'pengurus.dua.kali@komplek.local';
		const userId = await insertUser('Pengurus Dua Kali', email);
		await bootstrapSuperuser(testDb.db, new FakeClock(START), email);

		const second = new FakeClock(START);
		second.advance(60_000);
		const outcome = await bootstrapSuperuser(testDb.db, second, email);

		expect(outcome).toEqual({ kind: 'alreadySuperuser', email, userId });
		const roleRows = await testDb.db
			.select({ id: userRoles.id })
			.from(userRoles)
			.where(eq(userRoles.userId, userId));
		expect(roleRows).toHaveLength(2);
		expect(await auditEntriesFor(testDb.db, userId)).toHaveLength(1);
	});

	it('refuses an address nobody is registered with, and writes nothing', async () => {
		const before = await auditRowCount();

		const outcome = await bootstrapSuperuser(
			testDb.db,
			new FakeClock(START),
			'bukan.siapa-siapa@komplek.local'
		);

		expect(outcome).toEqual({ kind: 'noSuchUser', email: 'bukan.siapa-siapa@komplek.local' });
		expect(await auditRowCount()).toBe(before);
	});

	it('matches the address after trimming and lower-casing it, as sign-up stored it', async () => {
		const email = 'pengurus.huruf.besar@komplek.local';
		const userId = await insertUser('Pengurus Huruf Besar', email);

		const outcome = await bootstrapSuperuser(
			testDb.db,
			new FakeClock(START),
			'  Pengurus.Huruf.Besar@Komplek.Local  '
		);

		expect(outcome).toEqual({ kind: 'granted', email, userId });
		expect(await rolesOf(testDb.db, userId)).toContain(ROLE.superuser);
	});

	it('still grants when the system already has a superuser, so a lost account has a way back', async () => {
		const firstEmail = 'pengurus.lama@komplek.local';
		await insertUser('Pengurus Lama', firstEmail);
		await bootstrapSuperuser(testDb.db, new FakeClock(START), firstEmail);
		const secondEmail = 'pengurus.baru@komplek.local';
		const secondId = await insertUser('Pengurus Baru', secondEmail);

		const outcome = await bootstrapSuperuser(testDb.db, new FakeClock(START), secondEmail);

		expect(outcome).toEqual({ kind: 'granted', email: secondEmail, userId: secondId });
		expect(await rolesOf(testDb.db, secondId)).toContain(ROLE.superuser);
	});

	it('opens the loop: the account it grants can then grant roles through the guarded service', async () => {
		// The whole point of the command. Before it runs, `grantRole` refuses everybody, because
		// `ACTION.manageRoles` belongs to `superuser` alone and nobody holds it.
		const email = 'pengurus.pembuka@komplek.local';
		const bootstrappedId = await insertUser('Pengurus Pembuka', email);
		const targetId = await insertUser('Warga Diberi Admin', 'warga.diberi.admin@komplek.local');
		await bootstrapSuperuser(testDb.db, new FakeClock(START), email);

		await grantRole(testDb.db, new FakeClock(START), {
			actorId: bootstrappedId,
			targetUserId: targetId,
			role: ROLE.admin
		});

		expect(await rolesOf(testDb.db, targetId)).toEqual(new Set([ROLE.resident, ROLE.admin]));
	});
});
