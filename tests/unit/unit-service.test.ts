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
import { splitAtLetterToDigitBoundary } from '$lib/server/services/unit/queries';

/**
 * The Unit service: the admin list with search and pagination, creating a house, and switching one
 * off or back on. `tests/unit/schema-resident-unit.test.ts` already proves the database rules
 * (`units_block_number_unique`, the primary-occupant index); this file proves what the service adds
 * on top — permission, the audit trail, the conflict message a superuser reads, and the occupancy
 * summary, including the two "perlu penanggung jawab" states.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';
const STARTED_ON = '2026-01-01';

/**
 * The instant every read in this file happens at, and therefore the day `listUnits` and `getUnit`
 * decide "living here now" against. It is months after `STARTED_ON` so that a fixture ending on
 * `STARTED_ON` really has ended, and years before `FUTURE_END` so that one ending there has not.
 *
 * Every call below passes this explicitly. A test that read the real date instead would answer
 * differently depending on the day it ran.
 */
const READ_CLOCK = new FakeClock('2026-06-01T12:00:00.000Z');

/** `READ_CLOCK`'s own calendar day in WIB, and the days either side of it. */
const READ_DAY = '2026-06-01';
const DAY_BEFORE_READ = '2026-05-31';
const DAY_AFTER_READ = '2026-06-02';

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

/** An occupancy of `unitId` by `residentId`, running unless `startedOn` or `endedOn` says otherwise. */
async function insertOccupancy(
	unitId: string,
	residentId: string,
	overrides: Partial<{
		startedOn: string;
		endedOn: string;
		isPrimaryOccupant: boolean;
		createdAt: string;
	}> = {}
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: overrides.startedOn ?? STARTED_ON,
		endedOn: overrides.endedOn ?? null,
		isPrimaryOccupant: overrides.isPrimaryOccupant ?? false,
		createdAt: new Date(overrides.createdAt ?? START)
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

	/**
	 * `unique()` always appends a hyphen and a digit, so a block used in these fixtures is stripped of
	 * it first: the combined search box has to see a block with no separator character of its own, or
	 * `${block} 01` would split into three pieces (`ZQA`, `7`, `01`) instead of two and never reach the
	 * block-and-number path being tested here. See the ticket note (#199) this guards.
	 */
	function uniqueBlockWithoutSeparators(prefix: string): string {
		return unique(prefix).replaceAll('-', '');
	}

	it.each([
		['a space', (block: string) => `${block} 01`],
		['a hyphen', (block: string) => `${block}-01`],
		['a slash', (block: string) => `${block}/01`],
		['lowercase letters', (block: string) => `${block.toLowerCase()} 01`],
		['the Indonesian label words', (block: string) => `Blok ${block} No 01`],
		['the English label words', (block: string) => `Block ${block} No 01`]
	])('finds a unit by block and number combined with %s', async (_form, buildSearch) => {
		const superuserId = await insertSuperuser('Pengurus Pencari Gabungan');
		const block = uniqueBlockWithoutSeparators('ZQA');
		await insertUnitRow({ block, number: '01' });

		const page = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: buildSearch(block)
		});

		expect(page.units.some((row) => row.block === block && row.number === '01')).toBe(true);
	});

	it('finds a block-and-number keyword only in the unit it names, not a sibling block or number', async () => {
		const superuserId = await insertSuperuser('Pengurus Pencari Tepat');
		const blockA = uniqueBlockWithoutSeparators('ZQA');
		const blockB = uniqueBlockWithoutSeparators('ZQB');
		const wantedUnitId = await insertUnitRow({ block: blockA, number: '01' });
		await insertUnitRow({ block: blockB, number: '01' });
		await insertUnitRow({ block: blockA, number: '02' });

		const page = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: `${blockA} 01`
		});

		expect(page.units.map((row) => row.id)).toEqual([wantedUnitId]);
	});

	it('matches a single leftover piece against block or number, the way a lone keyword already did', async () => {
		const superuserId = await insertSuperuser('Pengurus Pencarian Satu Bagian');
		const block = uniqueBlockWithoutSeparators('ZQC');
		await insertUnitRow({ block, number: '55' });

		const byBlockAlone = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: block
		});
		const byNumberAlone = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: '55'
		});
		const byLabelledBlock = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: `Blok ${block}`
		});
		const byLabelledNumber = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: 'No 55'
		});

		for (const page of [byBlockAlone, byLabelledBlock]) {
			expect(page.units.some((row) => row.block === block && row.number === '55')).toBe(true);
		}
		for (const page of [byNumberAlone, byLabelledNumber]) {
			expect(page.units.some((row) => row.block === block && row.number === '55')).toBe(true);
		}
	});

	it('does not treat % or _ in the keyword as a wildcard', async () => {
		const superuserId = await insertSuperuser('Pengurus Wildcard');
		const block = uniqueBlockWithoutSeparators('ZQW');
		await insertUnitRow({ block, number: '01' });

		const percentSearch = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: '%'
		});
		const underscoreSearch = await listUnits(testDb.db, READ_CLOCK, {
			actorId: superuserId,
			search: '_'
		});

		expect(percentSearch.units.map((row) => row.block)).not.toContain(block);
		expect(underscoreSearch.units.map((row) => row.block)).not.toContain(block);
	});

	it.each<[string, readonly [string, string] | null]>([
		['A01', ['A', '01']],
		['ZQ7', ['ZQ', '7']],
		['AB', null],
		['12', null],
		['A', null]
	])(
		'splits %s at its first letter-to-digit boundary for the no-separator form, since a real block' +
			' from unique() always already contains a digit and cannot prove this case through listUnits',
		(piece, expected) => {
			expect(splitAtLetterToDigitBoundary(piece)).toEqual(expected);
		}
	);

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

	it('needs nothing while a Penanggung Jawab lives there with no last day written', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Ada');
		const block = unique('PJ');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Bertanggung Jawab'), {
			isPrimaryOccupant: true
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ primaryOccupantNeed: null });
		expect(row && needsPrimaryOccupant(row)).toBe(false);
	});

	it('flags an active unit that has occupants but nobody responsible for its invoices', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Kosong');
		const block = unique('NOPJ');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Tanpa Tanggung Jawab'));

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({
			activeOccupantCount: 1,
			primaryOccupantNeed: { kind: 'missing' }
		});
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
			primaryOccupantNeed: { kind: 'missing' }
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

	it('counts a Penanggung Jawab with a last day written, and flags the unit as leaving, naming them and that day', async () => {
		// The second "perlu penanggung jawab" state. The person still lives there and still receives
		// the invoices, so they are counted and they are the Penanggung Jawab; the unit is flagged all
		// the same, so the flag gets moved to whoever comes next while there is time to do it.
		const superuserId = await insertSuperuser('Pengurus Dua Jawaban');
		const block = unique('DUA');
		const unitId = await insertUnitRow({ block, number: '1' });
		const leaving = await insertResident('Warga Penanggung Jawab Pamit');
		await insertOccupancy(unitId, leaving, { endedOn: FUTURE_END, isPrimaryOccupant: true });

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({
			activeOccupantCount: 1,
			activeOccupants: [
				{ residentId: leaving, name: 'Warga Penanggung Jawab Pamit', isPrimaryOccupant: true }
			],
			primaryOccupantNeed: {
				kind: 'leaving',
				residentId: leaving,
				name: 'Warga Penanggung Jawab Pamit',
				endedOn: FUTURE_END
			}
		});
		expect(row && needsPrimaryOccupant(row)).toBe(true);
	});

	it('flags a Penanggung Jawab whose last day is today as leaving, with today as that day', async () => {
		const superuserId = await insertSuperuser('Pengurus Pamit Hari Ini');
		const block = unique('PAMIT');
		const unitId = await insertUnitRow({ block, number: '1' });
		const leaving = await insertResident('Warga Pamit Hari Ini');
		await insertOccupancy(unitId, leaving, { endedOn: READ_DAY, isPrimaryOccupant: true });

		const detail = await getUnit(testDb.db, superuserId, unitId, READ_CLOCK);

		expect(detail.primaryOccupantNeed).toEqual({
			kind: 'leaving',
			residentId: leaving,
			name: 'Warga Pamit Hari Ini',
			endedOn: READ_DAY
		});
	});

	it('reads the flag on a stay whose last day was yesterday as nobody, and the unit as missing one', async () => {
		const superuserId = await insertSuperuser('Pengurus Pamit Kemarin');
		const block = unique('PAMITKMR');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Pamit Kemarin'), {
			endedOn: DAY_BEFORE_READ,
			isPrimaryOccupant: true
		});
		await insertOccupancy(unitId, await insertResident('Warga Masih Tinggal'));

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({
			activeOccupantCount: 1,
			activeOccupants: [{ name: 'Warga Masih Tinggal', isPrimaryOccupant: false }],
			primaryOccupantNeed: { kind: 'missing' }
		});
		expect(row && needsPrimaryOccupant(row)).toBe(true);
	});

	it('takes the newest of two flagged running stays for the Penanggung Jawab, as the invoice email does', async () => {
		// Rows written under the date-clash model can leave two flagged stays running at once. The
		// summary picks one the way `notifyInvoiceIssued` picks its recipient — latest start day, then
		// latest recorded — so the screen and the email name the same person, and only that person
		// wears the badge. The older one is inserted first, so a query with no order would find it.
		const superuserId = await insertSuperuser('Pengurus Dua Penanda');
		const unitId = await insertUnitRow();
		const older = await insertResident('Anton Penanda Lama');
		const newer = await insertResident('Budi Penanda Baru');
		await insertOccupancy(unitId, older, { endedOn: FUTURE_END, isPrimaryOccupant: true });
		await insertOccupancy(unitId, newer, { startedOn: '2026-02-01', isPrimaryOccupant: true });

		const detail = await getUnit(testDb.db, superuserId, unitId, READ_CLOCK);

		expect(detail.activeOccupants).toEqual([
			{ residentId: newer, name: 'Budi Penanda Baru', isPrimaryOccupant: true },
			{ residentId: older, name: 'Anton Penanda Lama', isPrimaryOccupant: false }
		]);
		expect(detail.primaryOccupantNeed).toBeNull();
	});

	it('breaks a tie on the start day by the later recorded of two flagged stays', async () => {
		const superuserId = await insertSuperuser('Pengurus Seri Tanggal');
		const unitId = await insertUnitRow();
		const earlier = await insertResident('Warga Dicatat Duluan');
		const later = await insertResident('Warga Dicatat Belakangan');
		await insertOccupancy(unitId, earlier, {
			isPrimaryOccupant: true,
			createdAt: '2026-01-01T01:00:00.000Z'
		});
		await insertOccupancy(unitId, later, {
			endedOn: FUTURE_END,
			isPrimaryOccupant: true,
			createdAt: '2026-01-01T02:00:00.000Z'
		});

		const detail = await getUnit(testDb.db, superuserId, unitId, READ_CLOCK);

		expect(detail.primaryOccupantNeed).toEqual({
			kind: 'leaving',
			residentId: later,
			name: 'Warga Dicatat Belakangan',
			endedOn: FUTURE_END
		});
	});

	it('counts one person with two running stays in the same house once', async () => {
		// The schema has no unique pair on unit and resident, so an owner row beside a tenant row, or a
		// plain duplicate, is possible. Penghuni Aktif is a count of people, not of Masa Huni.
		const superuserId = await insertSuperuser('Pengurus Hitung Per Orang');
		const block = unique('ORANG');
		const unitId = await insertUnitRow({ block, number: '1' });
		const twice = await insertResident('Warga Dua Masa Huni');
		await insertOccupancy(unitId, twice);
		await insertOccupancy(unitId, twice, { startedOn: '2026-03-01' });

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row?.activeOccupantCount).toBe(1);
		expect(row?.activeOccupants.map((occupant) => occupant.residentId)).toEqual([twice]);
	});

	it('does not count a stay that starts tomorrow', async () => {
		const superuserId = await insertSuperuser('Pengurus Masuk Besok');
		const block = unique('BESOK');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Menetap Sekarang'));
		await insertOccupancy(unitId, await insertResident('Warga Masuk Besok'), {
			startedOn: DAY_AFTER_READ
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row?.activeOccupantCount).toBe(1);
		expect(row?.activeOccupants.map((occupant) => occupant.name)).toEqual([
			'Warga Menetap Sekarang'
		]);
	});

	it('counts a stay whose last day is today', async () => {
		const superuserId = await insertSuperuser('Pengurus Hari Terakhir');
		const block = unique('AKHIR');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Hari Terakhir'), {
			endedOn: READ_DAY
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		expect(page.units.find((unit) => unit.id === unitId)?.activeOccupantCount).toBe(1);
	});

	it('does not count a stay whose last day was yesterday', async () => {
		const superuserId = await insertSuperuser('Pengurus Kemarin');
		const block = unique('KEMARIN');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Pergi Kemarin'), {
			endedOn: DAY_BEFORE_READ
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		expect(page.units.find((unit) => unit.id === unitId)).toMatchObject({
			activeOccupantCount: 0,
			activeOccupants: []
		});
	});

	it('does not take a flagged stay that has not started for the Penanggung Jawab', async () => {
		// Under the date-clash model the Penanggung Jawab half read `ended_on is null`, so a stay
		// flagged ahead of time filled the slot before anyone lived there. ADR 0001 reads the
		// Penanggung Jawab as the flagged stay running today, so the unit is missing one until then.
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Besok');
		const block = unique('PJBESOK');
		const unitId = await insertUnitRow({ block, number: '1' });
		await insertOccupancy(unitId, await insertResident('Warga Penanggung Jawab Besok'), {
			startedOn: DAY_AFTER_READ,
			isPrimaryOccupant: true
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });

		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({
			activeOccupantCount: 0,
			activeOccupants: [],
			primaryOccupantNeed: { kind: 'missing' }
		});
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
		expect(row).toMatchObject({ primaryOccupantNeed: { kind: 'missing' } });
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
			activeOccupants: [{ residentId, name: 'Warga Detail', isPrimaryOccupant: true }],
			primaryOccupantNeed: null
		});
	});

	it('names the Penghuni Aktif, the Penanggung Jawab first and then by name, one entry per person', async () => {
		const superuserId = await insertSuperuser('Pengurus Nama Penghuni');
		const unitId = await insertUnitRow();
		const zaki = await insertResident('Zaki Penanggung Jawab');
		const citra = await insertResident('Citra Penyewa');
		const bayu = await insertResident('Bayu Pemilik');
		const dimas = await insertResident('Dimas Belum Masuk');
		const agus = await insertResident('Agus Sudah Pergi');
		await insertOccupancy(unitId, citra);
		await insertOccupancy(unitId, zaki, { isPrimaryOccupant: true });
		// Zaki also holds a second, ordinary stay: still one person, still first.
		await insertOccupancy(unitId, zaki, { startedOn: '2026-02-01' });
		await insertOccupancy(unitId, bayu, { endedOn: FUTURE_END });
		await insertOccupancy(unitId, dimas, { startedOn: DAY_AFTER_READ });
		await insertOccupancy(unitId, agus, { endedOn: DAY_BEFORE_READ });

		const detail = await getUnit(testDb.db, superuserId, unitId, READ_CLOCK);

		expect(detail.activeOccupants).toEqual([
			{ residentId: zaki, name: 'Zaki Penanggung Jawab', isPrimaryOccupant: true },
			{ residentId: bayu, name: 'Bayu Pemilik', isPrimaryOccupant: false },
			{ residentId: citra, name: 'Citra Penyewa', isPrimaryOccupant: false }
		]);
		expect(detail.activeOccupantCount).toBe(detail.activeOccupants.length);
	});

	it('reports a unit nobody lives in as empty rather than leaving the summary out', async () => {
		const superuserId = await insertSuperuser('Pengurus Unit Kosong');
		const unitId = await insertUnitRow();

		expect(await getUnit(testDb.db, superuserId, unitId, READ_CLOCK)).toMatchObject({
			activeOccupantCount: 0,
			activeOccupants: [],
			primaryOccupantNeed: { kind: 'missing' }
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
