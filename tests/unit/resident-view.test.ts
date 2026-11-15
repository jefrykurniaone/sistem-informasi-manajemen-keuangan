import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles, type Role } from '#lib/server/db/schema/authz.ts';
import { occupancies, OCCUPANCY_ROLE } from '#lib/server/db/schema/occupancy.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { units } from '#lib/server/db/schema/unit.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import {
	isInvoiceVisible,
	occupiesToday,
	residentViewFor,
	unitsOccupiedToday,
	type ResidentView
} from '#lib/server/services/occupancy/resident-view.ts';

/**
 * The seam every personal screen reads a Warga's houses and their Tagihan through — #306 decision 1,
 * ticket #313. Each test asserts only what the interface returns: which Units are in the view,
 * whether each is lived in today, and which Periode of a Unit this person may see.
 *
 * The visibility rule is the one in force before #313, moved here: a Tagihan is visible when the
 * first day of its Periode falls inside one of this person's own Masa Huni of its Unit, both ends
 * inclusive. The screens' own tests (`invoice-queries`, `payment-service`, `dashboard`) only check
 * that they are wired to this module; the cases of the rule live here.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** 10.00 WIB on 10 July 2026. */
const IN_JULY = new FakeClock('2026-07-10T03:00:00.000Z');

/** Makes every block this file writes different from every other one. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** An account holding `roles` on top of the trigger's default `resident`, with no `residents` row. */
async function insertAccount(name: string, roles: readonly Role[] = []): Promise<string> {
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
	for (const role of roles) {
		await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: now });
	}
	return id;
}

/** An account together with the `residents` row that points at it. */
async function insertResident(
	name: string,
	roles: readonly Role[] = []
): Promise<{ userId: string; residentId: string }> {
	const userId = await insertAccount(name, roles);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return { userId, residentId: row.id };
}

/** One house. */
async function insertUnitRow(): Promise<{ id: string; block: string; number: string }> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('RV'), number: '1', createdAt: new Date(START) })
		.returning();
	return row;
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
		role: OCCUPANCY_ROLE.owner,
		startedOn,
		endedOn,
		createdAt: new Date(START)
	});
}

/** The Periode of `unitId`, out of `periods`, that `view` says this person may see. */
function visiblePeriods(
	view: ResidentView,
	unitId: string,
	periods: readonly string[]
): readonly string[] {
	return periods.filter((period) => isInvoiceVisible(view, { unitId, period }));
}

/** Every month of 2026 from January to August, as `YYYY-MM`. */
const MONTHS_2026 = ['01', '02', '03', '04', '05', '06', '07', '08'].map(
	(month) => `2026-${month}`
);

describe('residentViewFor', () => {
	it('is empty for an account with no residents row, and sees no Tagihan at all', async () => {
		const unit = await insertUnitRow();
		const userId = await insertAccount('Warga Belum Tercatat');

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units).toEqual([]);
		expect(unitsOccupiedToday(view)).toEqual([]);
		expect(isInvoiceVisible(view, { unitId: unit.id, period: '2026-07' })).toBe(false);
	});

	it('carries a house with its block, number, merged ranges and whether it is lived in today', async () => {
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Satu Rumah');
		await insertOccupancyRow(unit.id, residentId, '2026-02-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units).toEqual([
			{
				unitId: unit.id,
				block: unit.block,
				number: unit.number,
				ranges: [{ from: '2026-02-01', to: null }],
				occupiedToday: true
			}
		]);
	});

	it('folds two stays in one house into one entry', async () => {
		// `occupancies` has no unique pair on unit and resident: an owner row beside a tenant row, or
		// a plain duplicate, must not list the house twice on any screen.
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Dua Masa Huni');
		await insertOccupancyRow(unit.id, residentId, '2026-01-01', null);
		await insertOccupancyRow(unit.id, residentId, '2026-03-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units).toHaveLength(1);
		expect(view.units[0].ranges).toEqual([{ from: '2026-01-01', to: null }]);
	});

	it('lists the most recent move-in first', async () => {
		const older = await insertUnitRow();
		const newer = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Pindah Rumah');
		await insertOccupancyRow(older.id, residentId, '2026-01-01', '2026-04-30');
		await insertOccupancyRow(newer.id, residentId, '2026-05-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units.map((unit) => unit.unitId)).toEqual([newer.id, older.id]);
		expect(unitsOccupiedToday(view).map((unit) => unit.unitId)).toEqual([newer.id]);
	});

	it.each([
		['a stay that has not started yet', '2026-09-01', null],
		['an ended stay that started later', '2026-05-01', '2026-05-31']
	])(
		'places a house lived in today by its most recent running stay, not by %s',
		async (_description, otherStartedOn, otherEndedOn) => {
			// Two houses lived in today: `first` since January, `second` since March. `first` also has
			// another stay starting after March. Ordered by its most recent stay of any kind, `first`
			// would jump ahead of `second`; ordered by its most recent running stay, as the payment
			// picker always did, `second` stays first.
			const first = await insertUnitRow();
			const second = await insertUnitRow();
			const { userId, residentId } = await insertResident('Warga Dua Rumah');
			await insertOccupancyRow(first.id, residentId, '2026-01-01', null);
			await insertOccupancyRow(second.id, residentId, '2026-03-01', null);
			await insertOccupancyRow(first.id, residentId, otherStartedOn, otherEndedOn);

			const view = await residentViewFor(testDb.db, IN_JULY, userId);

			expect(unitsOccupiedToday(view).map((unit) => unit.unitId)).toEqual([second.id, first.id]);
			expect(view.units.map((unit) => unit.unitId)).toEqual([second.id, first.id]);
		}
	);

	it('places the houses not lived in today after the others, most recent move-in first', async () => {
		const endedEarly = await insertUnitRow();
		const endedLate = await insertUnitRow();
		const upcoming = await insertUnitRow();
		const home = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Banyak Rumah');
		await insertOccupancyRow(endedEarly.id, residentId, '2025-01-01', '2025-06-30');
		await insertOccupancyRow(home.id, residentId, '2025-07-01', null);
		await insertOccupancyRow(endedLate.id, residentId, '2026-01-01', '2026-03-31');
		await insertOccupancyRow(upcoming.id, residentId, '2026-09-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units.map((unit) => unit.unitId)).toEqual([
			home.id,
			upcoming.id,
			endedLate.id,
			endedEarly.id
		]);
	});

	it('counts no stay of somebody else', async () => {
		const unit = await insertUnitRow();
		const neighbour = await insertResident('Warga Tetangga');
		const { userId } = await insertResident('Warga Lain');
		await insertOccupancyRow(unit.id, neighbour.residentId, '2026-01-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units).toEqual([]);
	});
});

describe('occupiesToday', () => {
	it.each([
		['a stay with no end date', '2026-01-01', null, true],
		['a stay whose end date has not arrived', '2026-01-01', '2027-12-31', true],
		['a stay whose last day is today', '2026-01-01', '2026-07-10', true],
		['a stay that ended yesterday', '2026-01-01', '2026-07-09', false],
		['a stay starting today', '2026-07-10', null, true],
		['a stay starting tomorrow', '2026-07-11', null, false]
	])('answers %s', async (_description, startedOn, endedOn, expected) => {
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Hari Ini');
		await insertOccupancyRow(unit.id, residentId, startedOn, endedOn);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(occupiesToday(view, unit.id)).toBe(expected);
		expect(unitsOccupiedToday(view).length > 0).toBe(expected);
	});

	it('reads today in WIB, so a stay starting on 1 June is running at 01.00 WIB that day', async () => {
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Tengah Malam');
		await insertOccupancyRow(unit.id, residentId, '2026-06-01', null);

		// 18.00 UTC on 31 May is 01.00 WIB on 1 June.
		const view = await residentViewFor(
			testDb.db,
			new FakeClock('2026-05-31T18:00:00.000Z'),
			userId
		);

		expect(occupiesToday(view, unit.id)).toBe(true);
	});

	it('answers no for a house this person never lived in', async () => {
		const mine = await insertUnitRow();
		const theirs = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Rumah Sendiri');
		await insertOccupancyRow(mine.id, residentId, '2026-01-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(occupiesToday(view, theirs.id)).toBe(false);
	});
});

describe('isInvoiceVisible', () => {
	it('keeps a Warga who moved out their own months, the last one included, and nothing after', async () => {
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Sudah Pindah');
		await insertOccupancyRow(unit.id, residentId, '2026-01-01', '2026-04-01');

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		// The last day, 1 April, is the first day of April's Periode: both ends are inclusive.
		expect(visiblePeriods(view, unit.id, MONTHS_2026)).toEqual([
			'2026-01',
			'2026-02',
			'2026-03',
			'2026-04'
		]);
		expect(occupiesToday(view, unit.id)).toBe(false);
	});

	it('shows a Warga who moved out and came back both stays, and none of the months between', async () => {
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Pulang Kembali');
		const between = await insertResident('Penyewa Sela');
		await insertOccupancyRow(unit.id, residentId, '2026-01-01', '2026-02-28');
		await insertOccupancyRow(unit.id, between.residentId, '2026-03-01', '2026-05-31');
		await insertOccupancyRow(unit.id, residentId, '2026-06-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(view.units[0].ranges).toEqual([
			{ from: '2026-01-01', to: '2026-02-28' },
			{ from: '2026-06-01', to: null }
		]);
		expect(visiblePeriods(view, unit.id, MONTHS_2026)).toEqual([
			'2026-01',
			'2026-02',
			'2026-06',
			'2026-07',
			'2026-08'
		]);
		expect(occupiesToday(view, unit.id)).toBe(true);
	});

	it('shows no Tagihan of a Unit without any Masa Huni at all', async () => {
		const empty = await insertUnitRow();
		const home = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Rumah Lain');
		await insertOccupancyRow(home.id, residentId, '2026-01-01', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(visiblePeriods(view, empty.id, MONTHS_2026)).toEqual([]);
	});

	it('leaves out the month someone moved in after its first day', async () => {
		// The rule reads the first day of the Periode, so moving in on 15 June leaves June to whoever
		// lived there on 1 June.
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Masuk Tengah Bulan');
		await insertOccupancyRow(unit.id, residentId, '2026-06-15', null);

		const view = await residentViewFor(testDb.db, IN_JULY, userId);

		expect(visiblePeriods(view, unit.id, MONTHS_2026)).toEqual(['2026-07', '2026-08']);
	});

	it('leaves out a Tagihan issued before the Warga moved in, and keeps the one inside the stay', async () => {
		// The regression `89948c3` fixed in the payment picker, now held at the seam both screens
		// read: a Tagihan from before this resident moved in is the previous occupant's obligation.
		const unit = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Tagihan Penghuni Lama');
		await insertOccupancyRow(unit.id, residentId, '2025-12-01', null);

		const view = await residentViewFor(testDb.db, new FakeClock(START), userId);

		expect(isInvoiceVisible(view, { unitId: unit.id, period: '2025-10' })).toBe(false);
		expect(isInvoiceVisible(view, { unitId: unit.id, period: '2025-12' })).toBe(true);
	});

	it('splits a tenant turnover between the two occupants', async () => {
		const unit = await insertUnitRow();
		const leaving = await insertResident('Warga Lama');
		const arriving = await insertResident('Warga Baru');
		await insertOccupancyRow(unit.id, leaving.residentId, '2026-01-01', '2026-03-31');
		await insertOccupancyRow(unit.id, arriving.residentId, '2026-04-01', null);

		const leavingView = await residentViewFor(testDb.db, IN_JULY, leaving.userId);
		const arrivingView = await residentViewFor(testDb.db, IN_JULY, arriving.userId);

		expect(visiblePeriods(leavingView, unit.id, MONTHS_2026)).toEqual([
			'2026-01',
			'2026-02',
			'2026-03'
		]);
		expect(visiblePeriods(arrivingView, unit.id, MONTHS_2026)).toEqual([
			'2026-04',
			'2026-05',
			'2026-06',
			'2026-07',
			'2026-08'
		]);
	});

	describe('a pengurus who also lives in a house', () => {
		// #306's example: Rina is a superuser and has lived in her house since 1 June 2026, after the
		// previous occupant left January to March unpaid. The view reads no role, so whatever Rina may
		// do on the admin screens, her own view of the house starts on 1 June.
		it.each([
			['a superuser', [ROLE.superuser]],
			['an admin', [ROLE.admin]],
			['someone holding both', [ROLE.admin, ROLE.superuser]]
		] as const)('shows %s only the months of their own Masa Huni', async (_who, roles) => {
			const unit = await insertUnitRow();
			const previous = await insertResident('Penghuni Sebelumnya');
			const pengurus = await insertResident('Rina Pengurus Menghuni', roles);
			await insertOccupancyRow(unit.id, previous.residentId, '2026-01-01', '2026-05-31');
			await insertOccupancyRow(unit.id, pengurus.residentId, '2026-06-01', null);

			const view = await residentViewFor(testDb.db, IN_JULY, pengurus.userId);

			expect(visiblePeriods(view, unit.id, MONTHS_2026)).toEqual(['2026-06', '2026-07', '2026-08']);
			expect(unitsOccupiedToday(view).map((house) => house.unitId)).toEqual([unit.id]);
		});

		it('shows a superuser who lives nowhere no Tagihan of any house', async () => {
			const unit = await insertUnitRow();
			const occupant = await insertResident('Warga Penghuni');
			await insertOccupancyRow(unit.id, occupant.residentId, '2026-01-01', null);
			const superuser = await insertResident('Superuser Tanpa Rumah', [ROLE.superuser]);

			const view = await residentViewFor(testDb.db, IN_JULY, superuser.userId);

			expect(view.units).toEqual([]);
			expect(visiblePeriods(view, unit.id, MONTHS_2026)).toEqual([]);
		});
	});
});
