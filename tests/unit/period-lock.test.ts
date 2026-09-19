import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { CASH_CATEGORY_TYPE } from '$lib/server/db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '$lib/server/db/schema/cash-transaction';
import { monthlyReports } from '$lib/server/db/schema/monthly-report';
import { PERIOD_STATUS, periods, type Period } from '$lib/server/db/schema/period';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { createCashCategory } from '$lib/server/services/cash/category';
import { recordCashCorrection } from '$lib/server/services/cash/correction';
import {
	isDateInLockedPeriod,
	listPeriods,
	lockPeriod,
	PERIOD_LOCKED_ACTION,
	PERIOD_RULE,
	PERIOD_UNLOCKED_ACTION,
	PeriodLockedError,
	PeriodRuleError,
	unlockPeriod
} from '$lib/server/services/cash/period';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';

/**
 * The Periode and its lock: the rule that gives a published Laporan Bulanan its meaning. Against a
 * real PostgreSQL, because two of the three things this file proves are statements about concurrent
 * transactions — the race to create a month's row, and a lock landing between another writer's
 * check and its insert — and neither is visible from a single connection.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The amount most of these tests record. Nothing here depends on the figure. */
const AMOUNT = rupiah(150_000);

/** The reason a publication gives when it closes a month. */
const LOCK_REASON = 'Laporan Bulanan revisi 1 terbit.';

/** The reason a superuser gives when reopening one. */
const UNLOCK_REASON = 'Nota bulan itu baru ditemukan dan harus masuk.';

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
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

/** A user holding `role` on top of the default `resident` one. */
async function insertUserWithRole(name: string, role: Role): Promise<string> {
	const id = await insertUser(name);
	await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: new Date(START) });
	return id;
}

/** An admin, who is who records a Transaksi Kas and who publishes a Laporan Bulanan. */
async function insertAdmin(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.admin);
}

/** A superuser, who is the only role that may reopen a locked Periode. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** One ordinary category, added through the service that owns categories. */
async function addCategory(name: string) {
	const superuserId = await insertSuperuser(`Pengurus Kategori ${name}`);
	return createCashCategory(testDb.db, new FakeClock(START), {
		actorId: superuserId,
		name,
		type: CASH_CATEGORY_TYPE.expense
	});
}

/** One recorded transaction, dated on `occurredOn`. */
async function record(
	actorId: string,
	categoryId: string,
	occurredOn: string,
	clock: FakeClock = new FakeClock(START)
): Promise<CashTransaction> {
	return recordCashTransaction(testDb.db, clock, new FakeFileStore(new FakeClock(START)), {
		actorId,
		occurredOn,
		categoryId,
		amount: AMOUNT,
		description: 'Perbaikan gerbang depan'
	});
}

/**
 * Locks one month the way a publication will: inside a transaction the caller already owns.
 * `lockPeriod` takes a `Transaction` precisely so that it cannot be reached any other way.
 */
async function lockMonth(
	actorId: string,
	year: number,
	month: number,
	reason: string = LOCK_REASON
): Promise<Period> {
	return testDb.db.transaction((transaction) =>
		lockPeriod(transaction, new FakeClock(START), { actorId, year, month, reason })
	);
}

/** The `periods` rows for one month — a list, so that "exactly one" can be asserted. */
async function periodRows(year: number, month: number): Promise<readonly Period[]> {
	return testDb.db
		.select()
		.from(periods)
		.where(and(eq(periods.year, year), eq(periods.month, month)));
}

/** Every transaction dated on one day. */
async function transactionsOn(occurredOn: string): Promise<readonly CashTransaction[]> {
	return testDb.db
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.occurredOn, occurredOn));
}

/**
 * A second, independent connection into this file's own schema — a stand-in for a concurrent
 * request, with its own client and its own transaction, never sharing one with `testDb.db`.
 */
async function connectToSchema(): Promise<{ client: PoolClient; release: () => Promise<void> }> {
	const connection = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
		options: `-c search_path=${testDb.schemaName}`
	});
	const client = await connection.pool.connect();
	return {
		client,
		release: async () => {
			client.release();
			await connection.close();
		}
	};
}

/**
 * How long a blocked call is given to prove it is genuinely waiting on a lock rather than merely
 * slow. A local query that is not waiting finishes in well under a millisecond.
 */
const BLOCKED_FOR_MILLISECONDS = 300;

describe('the Periode a Transaksi Kas is dated into', () => {
	it('is created, open, by the first transaction recorded inside the month', async () => {
		// "Periode terbentuk untuk setiap bulan yang punya transaksi, atau dibuat pada saat
		// dibutuhkan": the month's row comes into being when something first needs it, which is here.
		const adminId = await insertAdmin('Pengurus Periode Baru');
		const category = await addCategory('Perbaikan gerbang periode baru');

		await record(adminId, category.id, '2026-04-07');

		expect(await periodRows(2026, 4)).toEqual([
			expect.objectContaining({ year: 2026, month: 4, status: PERIOD_STATUS.open })
		]);
	});

	it('is created once, however many transactions the month goes on to hold', async () => {
		const adminId = await insertAdmin('Pengurus Periode Sekali');
		const category = await addCategory('Kebersihan periode sekali');

		await record(adminId, category.id, '2026-09-02');
		await record(adminId, category.id, '2026-09-28');

		expect(await periodRows(2026, 9)).toHaveLength(1);
	});

	it('refuses a transaction dated inside a locked Periode, by an error that names the month', async () => {
		const adminId = await insertAdmin('Pengurus Periode Terkunci');
		const category = await addCategory('Perbaikan pagar periode terkunci');
		await record(adminId, category.id, '2026-10-05');
		await lockMonth(adminId, 2026, 10);

		const refusal: unknown = await record(adminId, category.id, '2026-10-19').catch(
			(error: unknown) => error
		);

		expect(refusal).toBeInstanceOf(PeriodLockedError);
		expect(refusal).toMatchObject({
			occurredOn: '2026-10-19',
			year: 2026,
			month: 10,
			period: '2026-10'
		});
		// Refused means nothing was written, not written and hidden.
		expect(await transactionsOn('2026-10-19')).toHaveLength(0);
	});

	it('accepts the very transaction it refused, once a superuser has unlocked the month', async () => {
		// Both directions in one test, which is what the acceptance criteria asks for: "ditolak;
		// setelah dibuka kunci, transaksi yang sama diterima".
		const adminId = await insertAdmin('Pengurus Periode Dibuka');
		const superuserId = await insertSuperuser('Pengurus Buka Kunci Periode');
		const category = await addCategory('Perbaikan pompa periode dibuka');
		await lockMonth(adminId, 2026, 11);

		await expect(record(adminId, category.id, '2026-11-14')).rejects.toThrow(PeriodLockedError);

		await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2026,
			month: 11,
			reason: UNLOCK_REASON
		});
		const accepted = await record(adminId, category.id, '2026-11-14');

		expect(accepted.occurredOn).toBe('2026-11-14');
		expect(await transactionsOn('2026-11-14')).toHaveLength(1);
	});
});

describe('a Koreksi of a line inside a locked Periode', () => {
	it('waits for the unlock, because it is dated on the corrected line and not on today', async () => {
		// The Koreksi carries the corrected row's `occurredOn`, so the month it has to answer to is
		// the original's month — not whatever month the clock happens to say. The clock below is four
		// months later on purpose: if the rule read `clock.now()` the correction would sail through,
		// and a number a resident already read would move.
		const adminId = await insertAdmin('Pengurus Koreksi Periode Terkunci');
		const superuserId = await insertSuperuser('Pengurus Buka Kunci Koreksi');
		const category = await addCategory('Perbaikan gorong-gorong koreksi terkunci');
		const original = await record(adminId, category.id, '2026-03-04');
		await lockMonth(adminId, 2026, 3);
		const july = new FakeClock('2026-07-09T00:00:00.000Z');

		const refusal: unknown = await recordCashCorrection(testDb.db, july, {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Nominalnya salah ketik.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PeriodLockedError);
		expect(refusal).toMatchObject({ occurredOn: '2026-03-04', period: '2026-03' });
		// July was never consulted, so July has no row: the rule read the original's date.
		expect(await periodRows(2026, 7)).toHaveLength(0);

		await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2026,
			month: 3,
			reason: UNLOCK_REASON
		});
		const correction = await recordCashCorrection(testDb.db, july, {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Nominalnya salah ketik.'
		});

		expect(correction).toMatchObject({ occurredOn: '2026-03-04', correctionOf: original.id });
	});
});

describe('lockPeriod', () => {
	it('locks the month and records who closed it and why', async () => {
		const adminId = await insertAdmin('Pengurus Terbitkan Laporan');
		const category = await addCategory('Perbaikan lampu jalan terbit');
		await record(adminId, category.id, '2027-01-08');

		const locked = await lockMonth(adminId, 2027, 1);

		expect(locked).toMatchObject({ year: 2027, month: 1, status: PERIOD_STATUS.locked });
		const entries = await auditEntriesFor(testDb.db, locked.id);
		expect(entries[0]).toMatchObject({
			actorId: adminId,
			action: PERIOD_LOCKED_ACTION,
			targetId: locked.id,
			before: { status: PERIOD_STATUS.open },
			after: { status: PERIOD_STATUS.locked, period: '2027-01', reason: LOCK_REASON }
		});
	});

	it('creates the row, already locked, for a month that never had one', async () => {
		// A month with no transactions can still have a report published for it, and locking it must
		// not depend on somebody having recorded something first.
		const adminId = await insertAdmin('Pengurus Kunci Bulan Kosong');

		const locked = await lockMonth(adminId, 2027, 2);

		expect(locked.status).toBe(PERIOD_STATUS.locked);
		expect(await periodRows(2027, 2)).toHaveLength(1);
	});

	it('refuses a month that is already locked', async () => {
		const adminId = await insertAdmin('Pengurus Kunci Dua Kali');
		await lockMonth(adminId, 2027, 3);

		const refusal: unknown = await lockMonth(adminId, 2027, 3).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PeriodRuleError);
		expect(refusal).toMatchObject({ rule: PERIOD_RULE.alreadyLocked });
	});

	it('refuses an empty reason, and writes no Periode row at all', async () => {
		const adminId = await insertAdmin('Pengurus Kunci Tanpa Alasan');

		const refusal: unknown = await lockMonth(adminId, 2027, 4, '   ').catch(
			(error: unknown) => error
		);

		expect(refusal).toMatchObject({ rule: PERIOD_RULE.reasonMissing });
		expect(await periodRows(2027, 4)).toHaveLength(0);
	});

	it('refuses a month that is not on the calendar', async () => {
		const adminId = await insertAdmin('Pengurus Kunci Bulan Tiga Belas');

		const refusal: unknown = await lockMonth(adminId, 2027, 13).catch((error: unknown) => error);

		expect(refusal).toMatchObject({ rule: PERIOD_RULE.notACalendarMonth });
	});
});

describe('unlockPeriod', () => {
	it('reopens the month and records who opened it and why', async () => {
		const adminId = await insertAdmin('Pengurus Terbit Sebelum Dibuka');
		const superuserId = await insertSuperuser('Pengurus Buka Kunci Tercatat');
		await lockMonth(adminId, 2027, 5);
		const clock = new FakeClock(START);
		clock.advance(60_000);

		const reopened = await unlockPeriod(testDb.db, clock, {
			actorId: superuserId,
			year: 2027,
			month: 5,
			reason: `  ${UNLOCK_REASON}  `
		});

		expect(reopened.status).toBe(PERIOD_STATUS.open);
		const entries = await auditEntriesFor(testDb.db, reopened.id);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: PERIOD_UNLOCKED_ACTION,
			targetId: reopened.id,
			before: { status: PERIOD_STATUS.locked },
			after: { status: PERIOD_STATUS.open, period: '2027-05', reason: UNLOCK_REASON }
		});
	});

	it('refuses an admin who is not also a superuser, and a resident, and leaves the month locked', async () => {
		// "Peran `admin` tidak bisa" is in the acceptance criteria, and `isAllowed` has no inheritance:
		// the three roles are a set, so holding `admin` is simply not holding `unlockPeriods`.
		const adminId = await insertAdmin('Pengurus Coba Buka Kunci');
		const residentId = await insertUser('Warga Coba Buka Kunci');
		await lockMonth(adminId, 2027, 6);

		for (const actorId of [adminId, residentId]) {
			await expect(
				unlockPeriod(testDb.db, new FakeClock(START), {
					actorId,
					year: 2027,
					month: 6,
					reason: UNLOCK_REASON
				})
			).rejects.toThrow(PermissionDeniedError);
		}

		expect((await periodRows(2027, 6))[0].status).toBe(PERIOD_STATUS.locked);
	});

	it('refuses an empty reason, and leaves the month locked', async () => {
		const adminId = await insertAdmin('Pengurus Terbit Sebelum Alasan Kosong');
		const superuserId = await insertSuperuser('Pengurus Buka Tanpa Alasan');
		await lockMonth(adminId, 2027, 7);

		const refusal: unknown = await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2027,
			month: 7,
			reason: ''
		}).catch((error: unknown) => error);

		expect(refusal).toMatchObject({ rule: PERIOD_RULE.reasonMissing });
		expect((await periodRows(2027, 7))[0].status).toBe(PERIOD_STATUS.locked);
	});

	it('refuses a month that is not locked, and never creates a row to reopen', async () => {
		// A month with no row is already open — this module's lifecycle decision — so there is nothing
		// to reopen, and writing a row here would record an event that did not happen.
		const superuserId = await insertSuperuser('Pengurus Buka Bulan Terbuka');

		const refusal: unknown = await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2027,
			month: 8,
			reason: UNLOCK_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toMatchObject({ rule: PERIOD_RULE.alreadyOpen });
		expect(await periodRows(2027, 8)).toHaveLength(0);
	});
});

describe('isDateInLockedPeriod', () => {
	it('answers for a month with no row, an open one and a locked one', async () => {
		const adminId = await insertAdmin('Pengurus Tanya Kunci');
		const category = await addCategory('Perbaikan selasar tanya kunci');
		await record(adminId, category.id, '2027-09-11');
		await lockMonth(adminId, 2027, 10);

		// No row at all: nothing has ever locked that month, so it is open.
		expect(await isDateInLockedPeriod(testDb.db, '2027-11-01')).toBe(false);
		expect(await isDateInLockedPeriod(testDb.db, '2027-09-11')).toBe(false);
		expect(await isDateInLockedPeriod(testDb.db, '2027-10-30')).toBe(true);
	});
});

describe('listPeriods', () => {
	it('lists months newest first, materialised or not, with the reports published inside them', async () => {
		const adminId = await insertAdmin('Pengurus Daftar Periode');
		const category = await addCategory('Perbaikan atap daftar periode');
		await record(adminId, category.id, '2028-02-03');
		await record(adminId, category.id, '2028-02-17');
		const locked = await lockMonth(adminId, 2028, 2);
		await testDb.db.insert(monthlyReports).values({
			periodId: locked.id,
			revision: 1,
			publishedAt: new Date(START),
			publishedBy: adminId,
			openingBalance: rupiah(0),
			totalIncome: rupiah(0),
			totalExpense: rupiah(300_000),
			closingBalance: rupiah(-300_000),
			duesCollected: rupiah(0),
			duesUnitsPaid: 0,
			duesUnitsUnpaid: 0,
			categoryBreakdown: []
		});
		// A month recorded before this rule existed: transactions, but no `periods` row.
		await record(adminId, category.id, '2028-03-06');
		await testDb.db.delete(periods).where(and(eq(periods.year, 2028), eq(periods.month, 3)));

		const listing = await listPeriods(testDb.db, adminId);

		const february = listing.periods.find((summary) => summary.period === '2028-02');
		expect(february).toMatchObject({
			id: locked.id,
			status: PERIOD_STATUS.locked,
			transactionCount: 2
		});
		expect(february?.reports).toEqual([
			expect.objectContaining({ revision: 1, revisionReason: null })
		]);
		// The month with no row is on the list, open, with a null id — not hidden.
		expect(listing.periods.find((summary) => summary.period === '2028-03')).toMatchObject({
			id: null,
			status: PERIOD_STATUS.open,
			transactionCount: 1,
			reports: []
		});
		const labels = listing.periods.map((summary) => summary.period);
		expect(labels).toEqual([...labels].sort().reverse());
	});

	it('tells a superuser they may reopen a month and an admin that they may not', async () => {
		const adminId = await insertAdmin('Pengurus Daftar Tanpa Kunci');
		const superuserId = await insertSuperuser('Pengurus Daftar Dengan Kunci');

		expect((await listPeriods(testDb.db, adminId)).mayUnlock).toBe(false);
		expect((await listPeriods(testDb.db, superuserId)).mayUnlock).toBe(true);
	});

	it('refuses a resident the list altogether', async () => {
		const residentId = await insertUser('Warga Daftar Periode');

		await expect(listPeriods(testDb.db, residentId)).rejects.toThrow(PermissionDeniedError);
	});
});

describe('the race to bring a Periode row into being', () => {
	it('waits for a concurrent insert of the same month instead of failing on the unique index', async () => {
		// Two admins recording the first transaction of a new month reach the same `insert` at the
		// same time. Under READ COMMITTED a plain `select` would tell both of them the row does not
		// exist, both would insert, and the loser would get a `periods_year_month_unique` violation
		// out of a code path with nothing wrong with it — a 500 on an ordinary recording.
		//
		// `on conflict (year, month) do nothing` is what removes it, and the removal is the whole
		// point of this test: PostgreSQL's speculative insertion makes the second statement *wait* for
		// the first transaction rather than fail, and the locking `select` that follows takes a fresh
		// snapshot and finds the row the winner committed. The stand-in connection below plays the
		// winner; `recordCashTransaction` is the real function under test.
		const adminId = await insertAdmin('Pengurus Balapan Periode');
		const category = await addCategory('Perbaikan paving balapan periode');

		const other = await connectToSchema();
		try {
			await other.client.query('BEGIN');
			await other.client.query(
				`insert into periods (year, month, status, created_at) values (2029, 5, 'open', now())`
			);

			const recording = record(adminId, category.id, '2029-05-12');
			let settled = false;
			recording.then(
				() => (settled = true),
				() => (settled = true)
			);

			await new Promise((resolve) => setTimeout(resolve, BLOCKED_FOR_MILLISECONDS));
			expect(settled).toBe(false);

			await other.client.query('COMMIT');

			// Unblocked, the recording finds the row the other connection committed and uses it.
			await expect(recording).resolves.toMatchObject({ occurredOn: '2029-05-12' });
			expect(await periodRows(2029, 5)).toHaveLength(1);
		} finally {
			await other.release();
		}
	});

	it('blocks behind a concurrent lock rather than recording against a stale status', async () => {
		// The other half of the argument, and the reason `requireOpenPeriodFor` takes `for share`
		// rather than reading the row plainly. A plain read never blocks under READ COMMITTED, so a
		// publication committing between the check and the insert would leave a transaction dated
		// inside a month whose frozen report has already been read — exactly what locking exists to
		// prevent. The stand-in connection holds the row lock a publication would hold.
		const adminId = await insertAdmin('Pengurus Balapan Kunci');
		const category = await addCategory('Perbaikan bak sampah balapan kunci');
		await record(adminId, category.id, '2029-06-01');

		const other = await connectToSchema();
		try {
			await other.client.query('BEGIN');
			await other.client.query(
				`update periods set status = 'locked' where year = 2029 and month = 6`
			);

			const recording = record(adminId, category.id, '2029-06-20');
			let settled = false;
			recording.then(
				() => (settled = true),
				() => (settled = true)
			);

			await new Promise((resolve) => setTimeout(resolve, BLOCKED_FOR_MILLISECONDS));
			expect(settled).toBe(false);

			await other.client.query('COMMIT');

			// Unblocked, the recording re-reads and sees the lock that really is there now.
			await expect(recording).rejects.toThrow(PeriodLockedError);
			expect(await transactionsOn('2029-06-20')).toHaveLength(0);
		} finally {
			await other.release();
		}
	});
});
