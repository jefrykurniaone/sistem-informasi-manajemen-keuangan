import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	currentDay,
	isStillRunningOn,
	isVisibleOn,
	mergeDateRanges,
	occupiedRangesOfUnit,
	stillRunningOn,
	unitVisibilityFor,
	visibilityDateFilter,
	VISIBLE_ALWAYS,
	VISIBLE_NEVER,
	type UnitVisibility
} from '$lib/server/services/occupancy/visibility';

/**
 * The visibility contract the iuran and kas-laporan specs are going to filter their rows with —
 * `spec-warga-unit-v1.md`'s "Penyaringan tampilan menurut masa huni".
 *
 * The scenario the spec names by hand is the one at the bottom of this file: a tenant turnover, with
 * the proof that whoever moved in later cannot see the days before they arrived while the pengurus
 * sees the whole history of the house.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The old occupant's stay. */
const OLD_FROM = '2026-01-01';
const OLD_UNTIL = '2026-03-31';
/** The new occupant's stay, starting the day after the old one ended. */
const NEW_FROM = '2026-04-01';
/** A day inside the old occupant's stay, and one inside the new occupant's. */
const DAY_IN_MARCH = '2026-03-15';
const DAY_IN_MAY = '2026-05-15';

/** Makes every block this file writes different from every other one. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role. */
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

/** An account together with the `residents` row that points at it. */
async function insertResident(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = await insertUser(name);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return { userId, residentId: row.id };
}

/** A superuser: the "admin melihat seluruh riwayat Unit" side of the contract. */
async function insertSuperuser(name: string): Promise<string> {
	const userId = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.superuser, createdAt: new Date(START) });
	return userId;
}

/** One house. */
async function insertUnitRow(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One stay, written directly: this file tests the reading side, not the writing one. */
async function insertOccupancyRow(
	unitId: string,
	residentId: string,
	startedOn: string,
	endedOn: string | null
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.tenant,
		startedOn,
		endedOn,
		createdAt: new Date(START)
	});
}

describe('mergeDateRanges', () => {
	it('sorts ranges by their first day', () => {
		const merged = mergeDateRanges([
			{ from: '2026-05-01', to: '2026-05-31' },
			{ from: '2026-01-01', to: '2026-01-31' }
		]);

		expect(merged).toEqual([
			{ from: '2026-01-01', to: '2026-01-31' },
			{ from: '2026-05-01', to: '2026-05-31' }
		]);
	});

	it('folds two overlapping ranges into one', () => {
		const merged = mergeDateRanges([
			{ from: '2026-01-01', to: '2026-03-31' },
			{ from: '2026-03-01', to: '2026-06-30' }
		]);

		expect(merged).toEqual([{ from: '2026-01-01', to: '2026-06-30' }]);
	});

	it('leaves a range that is wholly inside another one alone', () => {
		const merged = mergeDateRanges([
			{ from: '2026-01-01', to: '2026-12-31' },
			{ from: '2026-05-01', to: '2026-05-31' }
		]);

		expect(merged).toEqual([{ from: '2026-01-01', to: '2026-12-31' }]);
	});

	it('lets a range that has not ended swallow everything after it', () => {
		const merged = mergeDateRanges([
			{ from: '2026-01-01', to: null },
			{ from: '2026-05-01', to: '2026-05-31' }
		]);

		expect(merged).toEqual([{ from: '2026-01-01', to: null }]);
	});

	it('keeps two stays that do not touch apart', () => {
		const merged = mergeDateRanges([
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]);

		expect(merged).toEqual([
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]);
	});
});

describe('isVisibleOn', () => {
	const twoStays: UnitVisibility = {
		kind: 'ranges',
		ranges: [
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]
	};

	it.each([
		['the first day of a stay', OLD_FROM, true],
		['the last day of a stay', OLD_UNTIL, true],
		['a day inside a stay', DAY_IN_MARCH, true],
		['a day between two stays', DAY_IN_MAY, false],
		['a day before every stay', '2025-12-31', false],
		['a day long after a stay that has not ended', '2030-01-01', true]
	])('answers %s', (_description, day, expected) => {
		expect(isVisibleOn(twoStays, day)).toBe(expected);
	});

	it('says yes to every day for a viewer who may see the whole history', () => {
		expect(isVisibleOn(VISIBLE_ALWAYS, DAY_IN_MARCH)).toBe(true);
	});

	it('says no to every day for a viewer who never lived there', () => {
		expect(isVisibleOn(VISIBLE_NEVER, DAY_IN_MARCH)).toBe(false);
	});
});

describe('visibilityDateFilter', () => {
	it('is undefined for the whole history, so and() composes it away', () => {
		expect(visibilityDateFilter(occupancies.startedOn, VISIBLE_ALWAYS)).toBeUndefined();
	});

	it('matches no row at all when the viewer may see nothing', async () => {
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Tanpa Rentang');
		await insertOccupancyRow(unitId, residentId, OLD_FROM, null);

		const rows = await testDb.db
			.select()
			.from(occupancies)
			.where(
				and(
					eq(occupancies.unitId, unitId),
					visibilityDateFilter(occupancies.startedOn, VISIBLE_NEVER)
				)
			);

		expect(rows).toHaveLength(0);
	});

	it('keeps only the rows whose day falls inside one of the ranges', async () => {
		const unitId = await insertUnitRow();
		const early = await insertResident('Warga Awal Tahun');
		const late = await insertResident('Warga Akhir Tahun');
		await insertOccupancyRow(unitId, early.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, late.residentId, DAY_IN_MAY, null);

		const rows = await testDb.db
			.select({ startedOn: occupancies.startedOn })
			.from(occupancies)
			.where(
				and(
					eq(occupancies.unitId, unitId),
					visibilityDateFilter(occupancies.startedOn, {
						kind: 'ranges',
						ranges: [{ from: OLD_FROM, to: OLD_UNTIL }]
					})
				)
			);

		expect(rows).toEqual([{ startedOn: OLD_FROM }]);
	});

	it('keeps every row from the first day onwards when the range has not ended', async () => {
		const unitId = await insertUnitRow();
		const early = await insertResident('Warga Masuk Duluan');
		const late = await insertResident('Warga Menyusul');
		await insertOccupancyRow(unitId, early.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, late.residentId, DAY_IN_MAY, null);

		const rows = await testDb.db
			.select({ startedOn: occupancies.startedOn })
			.from(occupancies)
			.where(
				and(
					eq(occupancies.unitId, unitId),
					visibilityDateFilter(occupancies.startedOn, {
						kind: 'ranges',
						ranges: [{ from: NEW_FROM, to: null }]
					})
				)
			);

		expect(rows).toEqual([{ startedOn: DAY_IN_MAY }]);
	});
});

describe('occupiedRangesOfUnit', () => {
	it('reads back one range per stay, merged and sorted', async () => {
		const unitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Dua Kali');
		await insertOccupancyRow(unitId, residentId, '2026-09-01', null);
		await insertOccupancyRow(unitId, residentId, OLD_FROM, OLD_UNTIL);

		expect(await occupiedRangesOfUnit(testDb.db, userId, unitId)).toEqual([
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]);
	});

	it('counts no stay in another house', async () => {
		const unitId = await insertUnitRow();
		const otherUnitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Rumah Sebelah');
		await insertOccupancyRow(otherUnitId, residentId, OLD_FROM, null);

		expect(await occupiedRangesOfUnit(testDb.db, userId, unitId)).toEqual([]);
	});
});

describe('unitVisibilityFor', () => {
	it('answers the whole history to whoever may manage occupancies', async () => {
		const unitId = await insertUnitRow();
		const superuserId = await insertSuperuser('Pengurus Lihat Semua');

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: superuserId, unitId })).toEqual(
			VISIBLE_ALWAYS
		);
	});

	it('answers nothing to a signed-in account with no residents row yet', async () => {
		const unitId = await insertUnitRow();
		const userId = await insertUser('Warga Belum Tercatat');

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId })).toEqual(
			VISIBLE_NEVER
		);
	});

	it('answers nothing to a resident who never lived in that house', async () => {
		const unitId = await insertUnitRow();
		const { userId } = await insertResident('Warga Rumah Lain');

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId })).toEqual(
			VISIBLE_NEVER
		);
	});

	it('answers the days a resident lived there', async () => {
		const unitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Menghuni');
		await insertOccupancyRow(unitId, residentId, OLD_FROM, OLD_UNTIL);

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId })).toEqual({
			kind: 'ranges',
			ranges: [{ from: OLD_FROM, to: OLD_UNTIL }]
		});
	});
});

describe('currentDay', () => {
	it('reads the instant as a UTC calendar day', () => {
		expect(currentDay(new FakeClock('2026-08-01T12:00:00.000Z'))).toBe('2026-08-01');
	});

	it.each([
		['the first moment of a day', '2026-08-01T00:00:00.000Z', '2026-08-01'],
		['the last moment of a day', '2026-08-01T23:59:59.999Z', '2026-08-01'],
		// The complex is at UTC+7, so this instant is already the 2nd in Jakarta. The module's doc
		// comment states that consequence rather than hiding it: the answer can lag the local day by
		// the offset, and the lag only ever keeps someone counted as living in their house for
		// longer.
		['an instant that is already tomorrow in Jakarta', '2026-08-01T18:00:00.000Z', '2026-08-01']
	])('answers %s', (_description, instant, expected) => {
		expect(currentDay(new FakeClock(instant))).toBe(expected);
	});
});

describe('isStillRunningOn', () => {
	it.each([
		['a stay with no end date at all', null, true],
		['a stay ending after today', '2027-12-31', true],
		['a stay ending today', '2026-08-01', true],
		['a stay that ended yesterday', '2026-07-31', false]
	])('answers %s', (_description, endedOn, expected) => {
		expect(isStillRunningOn(endedOn, '2026-08-01')).toBe(expected);
	});
});

describe('stillRunningOn', () => {
	it('keeps the stays that have not ended by the given day, and drops the ones that have', async () => {
		const unitId = await insertUnitRow();
		const leavingNextYear = await insertResident('Warga Akan Pergi');
		const gone = await insertResident('Warga Sudah Pergi');
		const staying = await insertResident('Warga Tanpa Tanggal Selesai');
		await insertOccupancyRow(unitId, leavingNextYear.residentId, OLD_FROM, '2027-12-31');
		await insertOccupancyRow(unitId, gone.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, staying.residentId, OLD_FROM, null);

		const rows = await testDb.db
			.select({ endedOn: occupancies.endedOn })
			.from(occupancies)
			.where(and(eq(occupancies.unitId, unitId), stillRunningOn(occupancies.endedOn, '2026-08-01')))
			.orderBy(occupancies.endedOn);

		expect(rows).toEqual([{ endedOn: '2027-12-31' }, { endedOn: null }]);
	});
});

describe('a stay whose end date has not arrived', () => {
	it('still shows the resident the days they are living through', async () => {
		// The other half of the defect reported against `/my-unit`: whatever the occupant count says,
		// the visibility contract must not cut someone off from days they are still living in. It
		// answers the days as data, so an end date in the future is simply part of the range.
		const unitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Pamit Untuk Tahun Depan');
		await insertOccupancyRow(unitId, residentId, OLD_FROM, '2027-12-31');

		const visibility = await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId });

		expect(visibility).toEqual({ kind: 'ranges', ranges: [{ from: OLD_FROM, to: '2027-12-31' }] });
		expect(isVisibleOn(visibility, '2026-08-01')).toBe(true);
		expect(isVisibleOn(visibility, '2027-12-31')).toBe(true);
		expect(isVisibleOn(visibility, '2028-01-01')).toBe(false);
	});
});

describe('a tenant turnover', () => {
	/** The house, the occupant who left, the one who arrived, and the pengurus watching both. */
	async function turnover() {
		const unitId = await insertUnitRow();
		const leaving = await insertResident('Warga Penghuni Lama');
		const arriving = await insertResident('Warga Penghuni Baru');
		const superuserId = await insertSuperuser('Pengurus Pergantian Penghuni');
		await insertOccupancyRow(unitId, leaving.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, arriving.residentId, NEW_FROM, null);
		return { unitId, leaving, arriving, superuserId };
	}

	it('hides every day before the new occupant moved in, and shows every day after', async () => {
		const { unitId, arriving } = await turnover();

		const visibility = await unitVisibilityFor(testDb.db, {
			viewerUserId: arriving.userId,
			unitId
		});

		expect(visibility).toEqual({ kind: 'ranges', ranges: [{ from: NEW_FROM, to: null }] });
		expect(isVisibleOn(visibility, DAY_IN_MARCH)).toBe(false);
		expect(isVisibleOn(visibility, DAY_IN_MAY)).toBe(true);
	});

	it('leaves the previous occupant their own months and nothing after them', async () => {
		const { unitId, leaving } = await turnover();

		const visibility = await unitVisibilityFor(testDb.db, {
			viewerUserId: leaving.userId,
			unitId
		});

		expect(isVisibleOn(visibility, DAY_IN_MARCH)).toBe(true);
		expect(isVisibleOn(visibility, DAY_IN_MAY)).toBe(false);
	});

	it('shows the pengurus the whole history of the house', async () => {
		const { unitId, superuserId } = await turnover();

		const visibility = await unitVisibilityFor(testDb.db, {
			viewerUserId: superuserId,
			unitId
		});

		expect(visibility).toEqual(VISIBLE_ALWAYS);
		expect(isVisibleOn(visibility, DAY_IN_MARCH)).toBe(true);
		expect(isVisibleOn(visibility, DAY_IN_MAY)).toBe(true);
	});

	it('filters a query of the unit’s own history down to what each of them may see', async () => {
		const { unitId, arriving, superuserId } = await turnover();

		const forNewOccupant = await visibleStartDates(unitId, arriving.userId);
		const forPengurus = await visibleStartDates(unitId, superuserId);

		expect(forNewOccupant).toEqual([NEW_FROM]);
		expect(forPengurus).toEqual([OLD_FROM, NEW_FROM]);
	});

	/** Every stay of `unitId` whose first day `viewerUserId` is allowed to see, in order. */
	async function visibleStartDates(unitId: string, viewerUserId: string): Promise<string[]> {
		const visibility = await unitVisibilityFor(testDb.db, { viewerUserId, unitId });
		const rows = await testDb.db
			.select({ startedOn: occupancies.startedOn })
			.from(occupancies)
			.where(
				and(eq(occupancies.unitId, unitId), visibilityDateFilter(occupancies.startedOn, visibility))
			)
			.orderBy(occupancies.startedOn);
		return rows.map((row) => row.startedOn);
	}
});
