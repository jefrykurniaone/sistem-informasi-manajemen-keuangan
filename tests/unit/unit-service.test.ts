import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	createUnit,
	deactivateUnit,
	getUnit,
	listUnits,
	needsPrimaryOccupant,
	reactivateUnit,
	UnitConflictError,
	UnitNotFoundError,
	UNIT_CREATED_ACTION,
	UNIT_DEACTIVATED_ACTION,
	UNIT_REACTIVATED_ACTION
} from '$lib/server/services/unit';

/**
 * The Unit service: the admin list with search and pagination, creating a house, and switching one
 * off or back on. `tests/unit/schema-resident-unit.test.ts` already proves the database rules
 * (`units_block_number_unique`, the primary-occupant index); this file proves what the service adds
 * on top — permission, the audit trail, and the conflict message a superuser reads.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';
const STARTED_ON = '2026-01-01';

/**
 * The instant every read in this file happens at, and therefore the day `listUnits` and `getUnit`
 * decide "living here now" against. It is months after `STARTED_ON` so that a fixture ending on
 * `STARTED_ON` really has ended, and years before `FUTURE_END` so that one ending there has not.
 *
 * Every call below passes this explicitly. `getUnit` defaults its clock to `systemClock` — it has a
 * caller outside this ticket's `writes:` that cannot pass one — and a test that leaned on that
 * default would quietly start reading the real date and would answer differently depending on the
 * day it ran.
 */
const READ_CLOCK = new FakeClock('2026-06-01T12:00:00.000Z');

/** An end date that has been written but has not arrived, as of `READ_CLOCK`. */
const FUTURE_END = '2027-12-31';

/** Makes every block this file writes different from every other one, across every test. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

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

/** A superuser, ready to act as `actorId` in every test that needs one who may manage units. */
async function insertSuperuser(name: string): Promise<string> {
	const id = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId: id, role: ROLE.superuser, createdAt: new Date(START) });
	return id;
}

/** A `residents` row, for a test that needs someone to occupy a unit. */
async function insertResident(name: string): Promise<string> {
	const userId = await insertUser(name);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** A unit row written directly, bypassing the service under test, for building a fixture. */
async function insertUnitRow(
	overrides: Partial<{ block: string; number: string; isActive: boolean }> = {}
): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({
			block: overrides.block ?? unique('B'),
			number: overrides.number ?? '1',
			isActive: overrides.isActive ?? true,
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** An occupancy of `unitId` by `residentId`, running unless `endedOn` says otherwise. */
async function insertOccupancy(
	unitId: string,
	residentId: string,
	overrides: Partial<{ endedOn: string; isPrimaryOccupant: boolean }> = {}
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: STARTED_ON,
		endedOn: overrides.endedOn ?? null,
		isPrimaryOccupant: overrides.isPrimaryOccupant ?? false,
		createdAt: new Date(START)
	});
}

describe('listUnits', () => {
	it('refuses a caller who is not a superuser', async () => {
		const residentId = await insertUser('Warga Penasaran');

		await expect(listUnits(testDb.db, READ_CLOCK, { actorId: residentId })).rejects.toThrow(
			PermissionDeniedError
		);
	});

	it('lists an active unit by default, and hides a deactivated one', async () => {
		const superuserId = await insertSuperuser('Pengurus Daftar Unit');
		const activeBlock = unique('B');
		const inactiveBlock = unique('B');
		await insertUnitRow({ block: activeBlock, number: '1' });
		await insertUnitRow({ block: inactiveBlock, number: '1', isActive: false });

		const defaultPage = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: activeBlock
		});
		const inactivePage = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: inactiveBlock
		});

		expect(defaultPage.units.map((row) => row.block)).toContain(activeBlock);
		expect(inactivePage.units).toHaveLength(0);
	});

	it('shows a deactivated unit once the filter asks for it', async () => {
		const superuserId = await insertSuperuser('Pengurus Penyaring');
		const inactiveBlock = unique('B');
		await insertUnitRow({ block: inactiveBlock, number: '1', isActive: false });

		const filtered = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: inactiveBlock,
			includeInactive: true
		});

		expect(filtered.units.map((row) => row.block)).toContain(inactiveBlock);
	});

	it('matches the search term against block or number', async () => {
		const superuserId = await insertSuperuser('Pengurus Pencari');
		const block = unique('SRCH');
		await insertUnitRow({ block, number: '77' });

		const byBlock = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });
		const byNumber = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: '77' });

		expect(byBlock.units.map((row) => row.block)).toContain(block);
		expect(byNumber.units.some((row) => row.block === block && row.number === '77')).toBe(true);
	});

	it('paginates, reporting the total count across every page', async () => {
		const superuserId = await insertSuperuser('Pengurus Halaman');
		const block = unique('PAGE');
		await insertUnitRow({ block, number: '1' });
		await insertUnitRow({ block, number: '2' });
		await insertUnitRow({ block, number: '3' });

		const firstPage = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: block,
			page: 1,
			pageSize: 2
		});
		const secondPage = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: block,
			page: 2,
			pageSize: 2
		});

		expect(firstPage.units).toHaveLength(2);
		expect(firstPage.totalCount).toBe(3);
		expect(secondPage.units).toHaveLength(1);
		expect(secondPage.totalCount).toBe(3);
	});

	it('counts only occupancies that are still running', async () => {
		const superuserId = await insertSuperuser('Pengurus Penghuni');
		const block = unique('OCC');
		const unitId = await insertUnitRow({ block, number: '1' });
		const staying = await insertResident('Warga Menetap');
		const moved = await insertResident('Warga Pindah');
		await insertOccupancy(unitId, staying);
		await insertOccupancy(unitId, moved, { endedOn: STARTED_ON });

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		expect(page.units.find((row) => row.id === unitId)?.activeOccupantCount).toBe(1);
	});

	it('says a unit has a primary occupant while that occupancy is still running', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Ada');
		const block = unique('PJ');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Bertanggung Jawab'), {
			isPrimaryOccupant: true
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ hasPrimaryOccupant: true });
		expect(row && needsPrimaryOccupant(row)).toBe(false);
	});

	it('flags an active unit that has occupants but nobody responsible for its invoices', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Kosong');
		const block = unique('NOPJ');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Tanpa Tanggung Jawab'));

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ activeOccupantCount: 1, hasPrimaryOccupant: false });
		expect(row && needsPrimaryOccupant(row)).toBe(true);
	});

	it('does not count a primary occupant whose occupancy has already ended', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Pergi');
		const block = unique('PJEND');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Bertanggung Jawab Dulu'), {
			endedOn: STARTED_ON,
			isPrimaryOccupant: true
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		expect(page.units.find((unit) => unit.id === unitId)).toMatchObject({
			activeOccupantCount: 0,
			hasPrimaryOccupant: false
		});
	});

	it('still counts someone whose end date has been written but has not arrived', async () => {
		// The defect this guards: reading "living here now" as `ended_on is null` reported an empty
		// house while the person was still in it for another eighteen months.
		const superuserId = await insertSuperuser('Pengurus Pindah Tahun Depan');
		const block = unique('NANTI');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Pindah Tahun Depan'), {
			endedOn: FUTURE_END
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		expect(page.units.find((unit) => unit.id === unitId)?.activeOccupantCount).toBe(1);
	});

	it('stops counting that same person once the day they leave has passed', async () => {
		const superuserId = await insertSuperuser('Pengurus Sudah Lewat');
		const block = unique('LEWAT');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Sudah Pindah'), {
			endedOn: FUTURE_END
		});

		const afterTheyLeft = await listUnits(testDb.db, new FakeClock('2028-01-01T00:00:00.000Z'), {
			actorId: superuserId,
			search: block
		});

		expect(afterTheyLeft.units.find((unit) => unit.id === unitId)?.activeOccupantCount).toBe(0);
	});

	it('counts a primary occupant with a future end date while reporting the slot as free', async () => {
		// The two halves answer differently here on purpose, and this is the case that separates
		// them: the person is still living there, so they are counted; the partial index has already
		// released the slot, so the unit is flagged as needing a successor while there is time to
		// name one.
		const superuserId = await insertSuperuser('Pengurus Dua Jawaban');
		const block = unique('DUA');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Penanggung Jawab Pamit'), {
			endedOn: FUTURE_END,
			isPrimaryOccupant: true
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ activeOccupantCount: 1, hasPrimaryOccupant: false });
		expect(row && needsPrimaryOccupant(row)).toBe(true);
	});

	it('leaves a deactivated unit with no primary occupant unflagged, because it is not in service', async () => {
		const superuserId = await insertSuperuser('Pengurus Unit Nonaktif');
		const block = unique('MATI');
		const unitId = await insertUnitRow({ block, number: '1', isActive: false });

		const page = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: block,
			includeInactive: true
		});

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ hasPrimaryOccupant: false });
		expect(row && needsPrimaryOccupant(row)).toBe(false);
	});
});

describe('getUnit', () => {
	it('refuses a caller who is not a superuser', async () => {
		const residentId = await insertUser('Warga Tak Berhak Lihat');
		const unitId = await insertUnitRow();

		await expect(getUnit(testDb.db, residentId, unitId, READ_CLOCK)).rejects.toThrow(
			PermissionDeniedError
		);
	});

	it('throws UnitNotFoundError for an id that names no unit', async () => {
		const superuserId = await insertSuperuser('Pengurus Cari Unit');

		await expect(getUnit(testDb.db, superuserId, randomUUID(), READ_CLOCK)).rejects.toThrow(
			UnitNotFoundError
		);
	});

	it('returns the unit together with its occupancy summary', async () => {
		const superuserId = await insertSuperuser('Pengurus Detail Unit');
		const unitId = await insertUnitRow();
		const residentId = await insertResident('Warga Detail');
		await insertOccupancy(unitId, residentId, { isPrimaryOccupant: true });

		const detail = await getUnit(testDb.db, superuserId, unitId, READ_CLOCK);

		expect(detail).toMatchObject({
			id: unitId,
			activeOccupantCount: 1,
			hasPrimaryOccupant: true
		});
	});

	it('reports a unit nobody lives in as empty rather than leaving the summary out', async () => {
		const superuserId = await insertSuperuser('Pengurus Unit Kosong');
		const unitId = await insertUnitRow();

		expect(await getUnit(testDb.db, superuserId, unitId, READ_CLOCK)).toMatchObject({
			activeOccupantCount: 0,
			hasPrimaryOccupant: false
		});
	});
});

describe('createUnit', () => {
	it('creates the unit and records who added it', async () => {
		const superuserId = await insertSuperuser('Pengurus Pembuat Unit');
		const block = unique('NEW');
		const clock = new FakeClock(START);

		const created = await createUnit(testDb.db, clock, {
			actorId: superuserId,
			block,
			number: '5'
		});

		expect(created).toMatchObject({ block, number: '5', isActive: true });
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: UNIT_CREATED_ACTION,
			targetId: created.id,
			after: { block, number: '5' }
		});
	});

	it('trims the block and number before storing them', async () => {
		const superuserId = await insertSuperuser('Pengurus Rapikan Unit');
		const block = unique('TRIM');

		const created = await createUnit(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			block: `  ${block}  `,
			number: '  9  '
		});

		expect(created).toMatchObject({ block, number: '9' });
	});

	it('rejects an empty block or number', async () => {
		const superuserId = await insertSuperuser('Pengurus Validasi Unit');

		await expect(
			createUnit(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				block: '  ',
				number: '1'
			})
		).rejects.toThrow(TypeError);
	});

	it('refuses a caller who is not a superuser, and creates nothing', async () => {
		const residentId = await insertUser('Warga Tak Berhak Tambah');
		const block = unique('DENY');

		await expect(
			createUnit(testDb.db, new FakeClock(START), { actorId: residentId, block, number: '1' })
		).rejects.toThrow(PermissionDeniedError);

		const remaining = await listUnits(testDb.db, READ_CLOCK, {
			actorId: await insertSuperuser('Pengurus Pemeriksa'),
			search: block
		});
		expect(remaining.units).toHaveLength(0);
	});

	it('rejects a block and number that already name a unit, naming which one collided', async () => {
		const superuserId = await insertSuperuser('Pengurus Duplikat Unit');
		const block = unique('DUP');
		await createUnit(testDb.db, new FakeClock(START), { actorId: superuserId, block, number: '1' });

		const failure = createUnit(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			block,
			number: '1'
		});

		await expect(failure).rejects.toThrow(UnitConflictError);
		await expect(failure).rejects.toMatchObject({ block, number: '1' });
		const page = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: block,
			includeInactive: true
		});
		expect(page.units).toHaveLength(1);
	});
});

describe('deactivateUnit and reactivateUnit', () => {
	it('deactivates an active unit and records the change', async () => {
		const superuserId = await insertSuperuser('Pengurus Nonaktifkan');
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);

		const updated = await deactivateUnit(testDb.db, clock, { actorId: superuserId, unitId });

		expect(updated.isActive).toBe(false);
		const entries = await auditEntriesFor(testDb.db, unitId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: UNIT_DEACTIVATED_ACTION,
			targetId: unitId,
			before: { isActive: true },
			after: { isActive: false }
		});
	});

	it('is a no-op, with no audit row, when the unit is already inactive', async () => {
		const superuserId = await insertSuperuser('Pengurus Nonaktif Ulang');
		const unitId = await insertUnitRow({ isActive: false });

		await deactivateUnit(testDb.db, new FakeClock(START), { actorId: superuserId, unitId });

		expect(await auditEntriesFor(testDb.db, unitId)).toHaveLength(0);
	});

	it('reactivates an inactive unit and records the change', async () => {
		const superuserId = await insertSuperuser('Pengurus Aktifkan');
		const unitId = await insertUnitRow({ isActive: false });
		const clock = new FakeClock(START);

		const updated = await reactivateUnit(testDb.db, clock, { actorId: superuserId, unitId });

		expect(updated.isActive).toBe(true);
		const entries = await auditEntriesFor(testDb.db, unitId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: UNIT_REACTIVATED_ACTION,
			targetId: unitId,
			before: { isActive: false },
			after: { isActive: true }
		});
	});

	it('is a no-op, with no audit row, when the unit is already active', async () => {
		const superuserId = await insertSuperuser('Pengurus Aktif Ulang');
		const unitId = await insertUnitRow({ isActive: true });

		await reactivateUnit(testDb.db, new FakeClock(START), { actorId: superuserId, unitId });

		expect(await auditEntriesFor(testDb.db, unitId)).toHaveLength(0);
	});

	it('throws UnitNotFoundError for an id that names no unit', async () => {
		const superuserId = await insertSuperuser('Pengurus Unit Hilang');

		await expect(
			deactivateUnit(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId: randomUUID()
			})
		).rejects.toThrow(UnitNotFoundError);
	});
});

describe('write operations, refused to a resident caller', () => {
	it.each([
		[
			'createUnit',
			async (residentId: string) =>
				createUnit(testDb.db, new FakeClock(START), {
					actorId: residentId,
					block: unique('RES'),
					number: '1'
				})
		],
		[
			'deactivateUnit',
			async (residentId: string) => {
				const unitId = await insertUnitRow();
				return deactivateUnit(testDb.db, new FakeClock(START), { actorId: residentId, unitId });
			}
		],
		[
			'reactivateUnit',
			async (residentId: string) => {
				const unitId = await insertUnitRow({ isActive: false });
				return reactivateUnit(testDb.db, new FakeClock(START), { actorId: residentId, unitId });
			}
		]
	])('%s rejects a resident with PermissionDeniedError', async (_name, run) => {
		const residentId = await insertUser('Warga Percobaan Tulis');

		await expect(run(residentId)).rejects.toThrow(PermissionDeniedError);
	});
});
