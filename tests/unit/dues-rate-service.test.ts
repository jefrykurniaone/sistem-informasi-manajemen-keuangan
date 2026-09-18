import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { duesRates } from '$lib/server/db/schema/dues-rate';
import { invoices } from '$lib/server/db/schema/invoice';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	createDuesRate,
	deleteDuesRate,
	duesRateOn,
	duesRateWindows,
	DuesRateConflictError,
	DuesRateInUseError,
	DuesRateNotFoundError,
	listDuesRates,
	updateDuesRate,
	usedSincePeriodOf,
	DUES_RATE_CREATED_ACTION,
	DUES_RATE_DELETED_ACTION,
	DUES_RATE_UPDATED_ACTION
} from '$lib/server/services/dues/rate';

/**
 * The Tarif service: the rate in force on a day, the history screen's list, and the rule that a rate
 * which has already priced a Tagihan can never be changed again.
 *
 * `tests/unit/schema-dues.test.ts` already proves the database's own rules (the unique start date,
 * the non-negative amount); this file proves what the service adds on top — permission, the audit
 * trail, the computed "in force today", and the refusal that names since when a rate has been used.
 *
 * Nothing issues a Tagihan yet — that is #26 — so every test that needs "this rate has billed
 * something" writes the `invoices` row itself, which is also exactly what the rule reads: `invoices`
 * never points at `dues_rates`, so "used" is a question about periods falling inside a window.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The instant every read in this file happens at, so "today" is `2026-06-15` for every assertion. */
const READ_CLOCK = new FakeClock('2026-06-15T12:00:00.000Z');

const OLD_AMOUNT = rupiah(150_000);
const NEW_AMOUNT = rupiah(175_000);

/**
 * Every rate and every Tagihan is cleared before each test.
 *
 * Unlike the house register, a rate calendar is global: one rate's window ends where the next one
 * begins, so a row left behind by an earlier test would silently change the window every later test
 * decides against. This deletes only inside this file's own PostgreSQL schema — see
 * `src/lib/server/db/test-helpers.ts` — so it cannot reach another file's rows.
 */
beforeEach(async () => {
	await testDb.db.delete(invoices);
	await testDb.db.delete(duesRates);
});

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

/** A user holding exactly one extra role beyond the `resident` the trigger grants. */
async function insertUserWithRole(name: string, role: Role): Promise<string> {
	const id = await insertUser(name);
	await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: new Date(START) });
	return id;
}

/** A superuser, ready to act as `actorId` in every test that needs one who may manage rates. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** A rate row written directly, bypassing the service under test, for building a fixture. */
async function insertRate(effectiveFrom: string, amount: Rupiah = OLD_AMOUNT): Promise<string> {
	const [row] = await testDb.db
		.insert(duesRates)
		.values({ amount, effectiveFrom, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** A house, for a Tagihan to belong to. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({ block: `DUES-${sequence}`, number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/**
 * A Tagihan for `period`, written straight into `invoices`.
 *
 * This is what "the rate has been used to bill" reads. #26 has not landed, so there is no issuance
 * job to produce one, and the rule does not care which one produced it.
 */
async function insertInvoice(period: string): Promise<void> {
	await testDb.db.insert(invoices).values({
		unitId: await insertUnit(),
		period,
		amount: OLD_AMOUNT,
		dueDate: `${period}-05`,
		issuedAt: new Date(START)
	});
}

describe('duesRateOn', () => {
	it('answers undefined before the first rate ever starts', async () => {
		await insertRate('2026-01-01');

		expect(await duesRateOn(testDb.db, '2025-12-31')).toBeUndefined();
	});

	it('answers the rate whose start date has arrived, on the day itself', async () => {
		const rateId = await insertRate('2026-01-01');

		expect(await duesRateOn(testDb.db, '2026-01-01')).toMatchObject({ id: rateId });
	});

	it('answers the earlier rate for a day between two start dates', async () => {
		const earlier = await insertRate('2026-01-01', OLD_AMOUNT);
		await insertRate('2026-06-01', NEW_AMOUNT);

		expect(await duesRateOn(testDb.db, '2026-05-31')).toMatchObject({
			id: earlier,
			amount: OLD_AMOUNT
		});
	});

	it('answers the newest rate for any day after the last start date', async () => {
		await insertRate('2026-01-01', OLD_AMOUNT);
		const latest = await insertRate('2026-06-01', NEW_AMOUNT);

		expect(await duesRateOn(testDb.db, '2030-09-09')).toMatchObject({
			id: latest,
			amount: NEW_AMOUNT
		});
	});

	it('refuses a day that is not a real calendar day', async () => {
		await expect(duesRateOn(testDb.db, '2026-02-30')).rejects.toThrow(TypeError);
	});
});

describe('duesRateWindows and usedSincePeriodOf', () => {
	it('closes a window in the month before a successor that starts on the first', () => {
		const windows = duesRateWindows([
			{ id: 'a', effectiveFrom: '2026-01-01' },
			{ id: 'b', effectiveFrom: '2026-04-01' }
		]);

		expect(windows).toEqual([
			{ duesRateId: 'a', firstMonth: '2026-01', lastMonth: '2026-03' },
			{ duesRateId: 'b', firstMonth: '2026-04', lastMonth: null }
		]);
	});

	it('lets both rates keep a month a successor takes over in the middle of', () => {
		const windows = duesRateWindows([
			{ id: 'a', effectiveFrom: '2026-01-01' },
			{ id: 'b', effectiveFrom: '2026-04-15' }
		]);

		expect(windows).toEqual([
			{ duesRateId: 'a', firstMonth: '2026-01', lastMonth: '2026-04' },
			{ duesRateId: 'b', firstMonth: '2026-04', lastMonth: null }
		]);
	});

	it('crosses a year boundary when the successor starts in January', () => {
		const windows = duesRateWindows([
			{ id: 'a', effectiveFrom: '2025-05-01' },
			{ id: 'b', effectiveFrom: '2026-01-01' }
		]);

		expect(windows[0]).toEqual({ duesRateId: 'a', firstMonth: '2025-05', lastMonth: '2025-12' });
	});

	it('reports the earliest period inside the window, and nothing for one outside it', () => {
		const window = { duesRateId: 'a', firstMonth: '2026-02', lastMonth: '2026-04' };

		expect(usedSincePeriodOf(window, ['2026-01', '2026-03', '2026-04'])).toBe('2026-03');
		expect(usedSincePeriodOf(window, ['2026-01', '2026-05'])).toBeUndefined();
	});
});

describe('listDuesRates', () => {
	it('refuses a caller who is not a superuser', async () => {
		const residentId = await insertUser('Warga Penasaran Tarif');

		await expect(listDuesRates(testDb.db, READ_CLOCK, residentId)).rejects.toThrow(
			PermissionDeniedError
		);
	});

	it('lists every rate newest start date first, marking the one in force today', async () => {
		const superuserId = await insertSuperuser('Pengurus Riwayat Tarif');
		await insertRate('2026-01-01', OLD_AMOUNT);
		const current = await insertRate('2026-06-01', NEW_AMOUNT);
		await insertRate('2027-01-01', rupiah(200_000));

		const history = await listDuesRates(testDb.db, READ_CLOCK, superuserId);

		expect(history.today).toBe('2026-06-15');
		expect(history.rates.map((rate) => rate.effectiveFrom)).toEqual([
			'2027-01-01',
			'2026-06-01',
			'2026-01-01'
		]);
		expect(history.rates.filter((rate) => rate.isInForce).map((rate) => rate.id)).toEqual([
			current
		]);
	});

	it('marks nothing as in force while every rate is still in the future', async () => {
		const superuserId = await insertSuperuser('Pengurus Tarif Nanti');
		await insertRate('2027-01-01');

		const history = await listDuesRates(testDb.db, READ_CLOCK, superuserId);

		expect(history.rates.some((rate) => rate.isInForce)).toBe(false);
	});

	it('reports a rate that has billed as no longer editable, naming since when', async () => {
		const superuserId = await insertSuperuser('Pengurus Tarif Terpakai');
		const billed = await insertRate('2026-01-01', OLD_AMOUNT);
		const untouched = await insertRate('2026-06-01', NEW_AMOUNT);
		await insertInvoice('2026-03');

		const history = await listDuesRates(testDb.db, READ_CLOCK, superuserId);

		expect(history.rates.find((rate) => rate.id === billed)).toMatchObject({
			usedSincePeriod: '2026-03',
			isEditable: false
		});
		expect(history.rates.find((rate) => rate.id === untouched)).toMatchObject({
			usedSincePeriod: null,
			isEditable: true
		});
	});

	it('answers an empty history rather than failing when no rate has been set', async () => {
		const superuserId = await insertSuperuser('Pengurus Tarif Kosong');

		expect(await listDuesRates(testDb.db, READ_CLOCK, superuserId)).toMatchObject({ rates: [] });
	});
});

describe('createDuesRate', () => {
	it('sets the rate and records one audit row for it', async () => {
		const superuserId = await insertSuperuser('Pengurus Penetap Tarif');
		const clock = new FakeClock(START);

		const created = await createDuesRate(testDb.db, clock, {
			actorId: superuserId,
			amount: NEW_AMOUNT,
			effectiveFrom: '2026-07-01'
		});

		expect(created).toMatchObject({ amount: NEW_AMOUNT, effectiveFrom: '2026-07-01' });
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: DUES_RATE_CREATED_ACTION,
			targetId: created.id,
			after: { amount: NEW_AMOUNT, effectiveFrom: '2026-07-01' }
		});
	});

	it('refuses a second rate starting on a day one already starts on', async () => {
		const superuserId = await insertSuperuser('Pengurus Tarif Kembar');
		await insertRate('2026-07-01');

		const failure = createDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: NEW_AMOUNT,
			effectiveFrom: '2026-07-01'
		});

		await expect(failure).rejects.toThrow(DuesRateConflictError);
		await expect(failure).rejects.toMatchObject({ effectiveFrom: '2026-07-01' });
	});

	it('refuses a negative amount', async () => {
		const superuserId = await insertSuperuser('Pengurus Tarif Minus');

		await expect(
			createDuesRate(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: rupiah(-1),
				effectiveFrom: '2026-07-01'
			})
		).rejects.toThrow(TypeError);
	});

	it('refuses a start date that is not a real calendar day', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanggal Ngawur');

		await expect(
			createDuesRate(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: NEW_AMOUNT,
				effectiveFrom: '2026-02-30'
			})
		).rejects.toThrow(TypeError);
	});

	it('refuses a caller who is not a superuser, and writes nothing', async () => {
		const residentId = await insertUser('Warga Tak Berhak Tetapkan');

		await expect(
			createDuesRate(testDb.db, new FakeClock(START), {
				actorId: residentId,
				amount: NEW_AMOUNT,
				effectiveFrom: '2026-07-01'
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await testDb.db.select().from(duesRates)).toHaveLength(0);
	});
});

describe('updateDuesRate and deleteDuesRate, on a rate that has never billed', () => {
	it('changes the amount and the start date, and records one audit row', async () => {
		const superuserId = await insertSuperuser('Pengurus Ubah Tarif');
		const rateId = await insertRate('2026-07-01', OLD_AMOUNT);
		const clock = new FakeClock(START);

		const updated = await updateDuesRate(testDb.db, clock, {
			actorId: superuserId,
			duesRateId: rateId,
			amount: NEW_AMOUNT,
			effectiveFrom: '2026-08-01'
		});

		expect(updated).toMatchObject({ amount: NEW_AMOUNT, effectiveFrom: '2026-08-01' });
		const entries = await auditEntriesFor(testDb.db, rateId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: DUES_RATE_UPDATED_ACTION,
			targetId: rateId,
			before: { amount: OLD_AMOUNT, effectiveFrom: '2026-07-01' },
			after: { amount: NEW_AMOUNT, effectiveFrom: '2026-08-01' }
		});
	});

	it('removes the rate and records one audit row for the removal', async () => {
		const superuserId = await insertSuperuser('Pengurus Hapus Tarif');
		const rateId = await insertRate('2026-07-01', OLD_AMOUNT);

		const removed = await deleteDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			duesRateId: rateId
		});

		expect(removed).toMatchObject({ id: rateId, effectiveFrom: '2026-07-01' });
		expect(await testDb.db.select().from(duesRates)).toHaveLength(0);
		const entries = await auditEntriesFor(testDb.db, rateId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: DUES_RATE_DELETED_ACTION,
			before: { amount: OLD_AMOUNT, effectiveFrom: '2026-07-01' }
		});
	});

	it('refuses a new start date that another rate already starts on', async () => {
		const superuserId = await insertSuperuser('Pengurus Tabrakan Tanggal');
		await insertRate('2026-07-01');
		const moving = await insertRate('2026-08-01');

		await expect(
			updateDuesRate(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				duesRateId: moving,
				amount: NEW_AMOUNT,
				effectiveFrom: '2026-07-01'
			})
		).rejects.toThrow(DuesRateConflictError);
	});

	it('throws DuesRateNotFoundError for an id that names no rate', async () => {
		const superuserId = await insertSuperuser('Pengurus Tarif Hilang');

		await expect(
			deleteDuesRate(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				duesRateId: randomUUID()
			})
		).rejects.toThrow(DuesRateNotFoundError);
	});
});

describe('a rate that has already been used to bill', () => {
	/**
	 * A rate running from January that has priced a March Tagihan, with a successor from June that
	 * has priced nothing. The successor is what proves the refusal is about being used rather than
	 * about being old.
	 */
	async function billedCalendar(): Promise<{ billed: string; untouched: string }> {
		const billed = await insertRate('2026-01-01', OLD_AMOUNT);
		const untouched = await insertRate('2026-06-01', NEW_AMOUNT);
		await insertInvoice('2026-03');
		return { billed, untouched };
	}

	it('refuses to be changed, naming the period it has billed since', async () => {
		const superuserId = await insertSuperuser('Pengurus Ubah Terpakai');
		const { billed } = await billedCalendar();

		const failure = updateDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			duesRateId: billed,
			amount: NEW_AMOUNT,
			effectiveFrom: '2026-01-01'
		});

		await expect(failure).rejects.toThrow(DuesRateInUseError);
		await expect(failure).rejects.toMatchObject({
			duesRateId: billed,
			usedSincePeriod: '2026-03'
		});
		expect(await duesRateOn(testDb.db, '2026-03-01')).toMatchObject({ amount: OLD_AMOUNT });
	});

	it('refuses to be removed, naming the period it has billed since', async () => {
		const superuserId = await insertSuperuser('Pengurus Hapus Terpakai');
		const { billed } = await billedCalendar();

		const failure = deleteDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			duesRateId: billed
		});

		await expect(failure).rejects.toThrow(DuesRateInUseError);
		await expect(failure).rejects.toMatchObject({ usedSincePeriod: '2026-03' });
		expect(await testDb.db.select().from(duesRates)).toHaveLength(2);
	});

	it('writes no audit row for a change it refused', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanpa Jejak');
		const { billed } = await billedCalendar();

		await expect(
			deleteDuesRate(testDb.db, new FakeClock(START), { actorId: superuserId, duesRateId: billed })
		).rejects.toThrow(DuesRateInUseError);

		expect(await auditEntriesFor(testDb.db, billed)).toHaveLength(0);
	});

	it('leaves the successor that has billed nothing free to be changed', async () => {
		const superuserId = await insertSuperuser('Pengurus Ubah Penerus');
		const { untouched } = await billedCalendar();

		const updated = await updateDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			duesRateId: untouched,
			amount: rupiah(200_000),
			effectiveFrom: '2026-07-01'
		});

		expect(updated).toMatchObject({ amount: rupiah(200_000), effectiveFrom: '2026-07-01' });
	});

	it('refuses to move a free rate backwards over months that are already billed', async () => {
		// The successor has billed nothing of its own, but dragging it to February would make it the
		// rate that priced March — rewriting the history of a bill somebody has already paid, while
		// every frozen `invoices.amount` stays exactly as it was.
		const superuserId = await insertSuperuser('Pengurus Mundurkan Tarif');
		const { untouched } = await billedCalendar();

		const failure = updateDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			duesRateId: untouched,
			amount: NEW_AMOUNT,
			effectiveFrom: '2026-02-01'
		});

		await expect(failure).rejects.toThrow(DuesRateInUseError);
		await expect(failure).rejects.toMatchObject({ usedSincePeriod: '2026-03' });
	});

	it('treats both rates as used when a successor takes over in the middle of a billed month', async () => {
		const superuserId = await insertSuperuser('Pengurus Bulan Terbagi');
		const earlier = await insertRate('2026-01-01', OLD_AMOUNT);
		const later = await insertRate('2026-04-15', NEW_AMOUNT);
		await insertInvoice('2026-04');

		await expect(
			deleteDuesRate(testDb.db, new FakeClock(START), { actorId: superuserId, duesRateId: earlier })
		).rejects.toThrow(DuesRateInUseError);
		await expect(
			deleteDuesRate(testDb.db, new FakeClock(START), { actorId: superuserId, duesRateId: later })
		).rejects.toThrow(DuesRateInUseError);
	});

	it('leaves a rate whose start date has arrived but has billed nothing changeable', async () => {
		// The rule is "has it billed", never "has its date arrived": a rise that starts today and has
		// not yet priced anything is still a mistake a superuser may correct.
		const superuserId = await insertSuperuser('Pengurus Belum Menagih');
		const rateId = await insertRate('2026-01-01', OLD_AMOUNT);

		const updated = await updateDuesRate(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			duesRateId: rateId,
			amount: NEW_AMOUNT,
			effectiveFrom: '2026-01-01'
		});

		expect(updated).toMatchObject({ amount: NEW_AMOUNT });
	});
});

describe('an admin who is not a superuser', () => {
	it.each([
		['listDuesRates', async (actorId: string) => listDuesRates(testDb.db, READ_CLOCK, actorId)],
		[
			'createDuesRate',
			async (actorId: string) =>
				createDuesRate(testDb.db, new FakeClock(START), {
					actorId,
					amount: NEW_AMOUNT,
					effectiveFrom: '2026-09-01'
				})
		],
		[
			'updateDuesRate',
			async (actorId: string) =>
				updateDuesRate(testDb.db, new FakeClock(START), {
					actorId,
					duesRateId: await insertRate('2026-09-01'),
					amount: NEW_AMOUNT,
					effectiveFrom: '2026-10-01'
				})
		],
		[
			'deleteDuesRate',
			async (actorId: string) =>
				deleteDuesRate(testDb.db, new FakeClock(START), {
					actorId,
					duesRateId: await insertRate('2026-09-01')
				})
		]
	])('%s rejects them with PermissionDeniedError', async (_name, run) => {
		const adminId = await insertUserWithRole('Pengurus Harian Tanpa Tarif', ROLE.admin);

		await expect(run(adminId)).rejects.toThrow(PermissionDeniedError);
	});
});
