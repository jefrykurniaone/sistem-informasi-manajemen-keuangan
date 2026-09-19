import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { invoiceHistoryForUnit, listOverdueUnits } from '$lib/server/services/dues/queries';

/**
 * "Peran warga tidak dapat membuka daftar penunggak; percobaan langsung ke lapisan service
 * ditolak" — `docs/spec-iuran-v1.md`'s own success criterion, tested here as a direct service call
 * that never goes near a route, exactly as the acceptance criterion asks. `tests/unit/authz.test.ts`
 * proves `ACTION.readOverdue` is in `isAllowed`'s table correctly; this file proves the two
 * functions that guard themselves with it actually refuse.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

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

async function insertWithRole(
	name: string,
	role: (typeof ROLE)[keyof typeof ROLE]
): Promise<string> {
	const userId = await insertUser(name);
	if (role !== ROLE.resident) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date(START) });
	}
	return userId;
}

async function insertUnitRow(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

describe('the daftar penunggak refuses a plain warga at the service layer', () => {
	it('rejects listOverdueUnits for a caller holding only the default resident role', async () => {
		const residentUserId = await insertWithRole('Warga Biasa', ROLE.resident);

		await expect(
			listOverdueUnits(testDb.db, new FakeClock(START), residentUserId)
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it('rejects invoiceHistoryForUnit for the same caller, on any house', async () => {
		const residentUserId = await insertWithRole('Warga Ingin Tahu', ROLE.resident);
		const unitId = await insertUnitRow();

		await expect(
			invoiceHistoryForUnit(testDb.db, new FakeClock(START), residentUserId, unitId)
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it('rejects a superuser who does not also hold admin — the roles are a set, not a ladder', async () => {
		const superuserId = await insertWithRole('Superuser Saja', ROLE.superuser);
		const unitId = await insertUnitRow();

		await expect(
			listOverdueUnits(testDb.db, new FakeClock(START), superuserId)
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(
			invoiceHistoryForUnit(testDb.db, new FakeClock(START), superuserId, unitId)
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it('lets an admin through both, proving the refusal above is about the role and not the query', async () => {
		const adminId = await insertWithRole('Admin Penagih', ROLE.admin);
		const unitId = await insertUnitRow();

		await expect(listOverdueUnits(testDb.db, new FakeClock(START), adminId)).resolves.toEqual([]);
		await expect(
			invoiceHistoryForUnit(testDb.db, new FakeClock(START), adminId, unitId)
		).resolves.toMatchObject({ unitId, invoices: [] });
	});
});
