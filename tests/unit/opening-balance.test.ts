import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '#lib/errors.ts';
import { rupiah } from '#lib/money.ts';
import { auditEntriesFor } from '#lib/server/audit.ts';
import { createConnection, readDatabaseUrl } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles, type Role } from '#lib/server/db/schema/authz.ts';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY
} from '#lib/server/db/schema/cash-category.ts';
import { cashTransactions } from '#lib/server/db/schema/cash-transaction.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock, FakeFileStore } from '#lib/server/ports/fakes.ts';
import { createCashCategory } from '#lib/server/services/cash/category.ts';
import { recordCashCorrection } from '#lib/server/services/cash/correction.ts';
import * as openingBalanceModule from '#lib/server/services/cash/opening-balance.ts';
import { lockPeriod, PeriodLockedError, unlockPeriod } from '#lib/server/services/cash/period.ts';
import { recordCashTransaction } from '#lib/server/services/cash/transaction.ts';
import {
	getOpeningBalance,
	OPENING_BALANCE_DESCRIPTION,
	OPENING_BALANCE_RECORDED_ACTION,
	OpeningBalanceAfterEarliestCashTransactionError,
	OpeningBalanceAlreadyRecordedError,
	recordOpeningBalance
} from '#lib/server/services/cash/opening-balance.ts';

/**
 * The Saldo awal: recorded by a superuser as one income transaction in the system category
 * `opening-balance`. Only one is in force at a time: a second is refused while the first stands,
 * including when the second request arrives while the first one is still open, and accepted once a
 * Koreksi has reversed the first (spec #308, decision 3). Its day may not fall after the earliest
 * Transaksi Kas outside that category. Against a real PostgreSQL, because the rules being tested
 * are rules about committing.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The day this complex started using the application, in every test that records one. */
const STARTED_ON = '2026-01-05';

/** The money that was in the cash box on that day. */
const AMOUNT = rupiah(2_750_000);

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

/** A superuser, ready to act as `actorId` wherever a test needs one who is allowed. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/**
 * Empties the cash book. This file's schema accumulates rows across every test that ran before,
 * and "there is no opening balance yet" is the starting state most of these tests need — the same
 * move `tests/unit/roles-service.test.ts` makes before testing the last-superuser rule.
 */
async function clearCashBook(): Promise<void> {
	await testDb.db.delete(cashTransactions);
}

/** The id of the system category every opening balance is filed under. */
async function openingBalanceCategoryId(): Promise<string> {
	const [row] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.openingBalance));
	return row.id;
}

/** An admin, who is who records an ordinary Transaksi Kas and writes a Koreksi. */
async function insertAdmin(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.admin);
}

/** One ordinary income line on `occurredOn`, in a fresh category, recorded by a fresh admin. */
async function recordOrdinaryLine(occurredOn: string) {
	const superuserId = await insertSuperuser(`Pengurus Kategori ${occurredOn}`);
	const category = await createCashCategory(testDb.db, new FakeClock(START), {
		actorId: superuserId,
		name: `Sumbangan warga ${randomUUID()}`,
		type: CASH_CATEGORY_TYPE.income
	});
	const adminId = await insertAdmin(`Pengurus Harian ${occurredOn}`);
	return recordCashTransaction(
		testDb.db,
		new FakeClock(START),
		new FakeFileStore(new FakeClock(START)),
		{
			actorId: adminId,
			occurredOn,
			categoryId: category.id,
			amount: rupiah(100_000),
			description: 'Sumbangan kegiatan tujuh belasan'
		}
	);
}

/** A Koreksi of `transactionId`, written by a fresh admin through the ordinary Koreksi. */
async function correct(transactionId: string) {
	const adminId = await insertAdmin('Pengurus Koreksi Saldo Awal');
	return recordCashCorrection(testDb.db, new FakeClock(START), {
		actorId: adminId,
		transactionId,
		reason: 'Nominal saldo awal keliru.'
	});
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

describe('the opening balance module', () => {
	it('exports one way to record it and one way to read it, and nothing that changes or removes it', () => {
		// The cash book is append-only: a wrong opening balance is corrected with a reversing
		// transaction, never overwritten. A future `updateOpeningBalance` or `deleteOpeningBalance`
		// shows up here as a failing assertion, the way `tests/unit/audit.test.ts` pins the audit
		// log's surface.
		expect(Object.keys(openingBalanceModule).sort()).toEqual([
			'OPENING_BALANCE_DESCRIPTION',
			'OPENING_BALANCE_RECORDED_ACTION',
			'OpeningBalanceAfterEarliestCashTransactionError',
			'OpeningBalanceAlreadyRecordedError',
			'getOpeningBalance',
			'recordOpeningBalance'
		]);
	});
});

describe('recordOpeningBalance', () => {
	it('writes one income transaction in the system category, and an audit row with it', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal');

		const recorded = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});

		expect(recorded).toMatchObject({
			type: CASH_CATEGORY_TYPE.income,
			categoryId: await openingBalanceCategoryId(),
			amount: AMOUNT,
			occurredOn: STARTED_ON,
			description: OPENING_BALANCE_DESCRIPTION,
			recordedBy: superuserId,
			correctionOf: null
		});
		expect(recorded.createdAt.getTime()).toBe(Date.parse(START));

		const entries = await auditEntriesFor(testDb.db, recorded.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: OPENING_BALANCE_RECORDED_ACTION,
			targetId: recorded.id,
			after: { amount: AMOUNT, occurredOn: STARTED_ON }
		});
	});

	it('refuses a second one, and leaves the first untouched', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Dua Kali');
		const first = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});

		const refusal: unknown = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: rupiah(999_000),
			occurredOn: '2026-02-01'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(OpeningBalanceAlreadyRecordedError);
		expect(refusal).toMatchObject({ existingTransactionId: first.id });
		const rows = await testDb.db.select().from(cashTransactions);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: first.id, amount: AMOUNT, occurredOn: STARTED_ON });
	});

	it('refuses an admin who is not also a superuser, and writes nothing', async () => {
		await clearCashBook();
		const adminId = await insertUserWithRole('Pengurus Harian Saldo Awal', ROLE.admin);

		await expect(
			recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: adminId,
				amount: AMOUNT,
				occurredOn: STARTED_ON
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(0);
	});

	it('refuses an amount that is not strictly positive', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Nol');

		await expect(
			recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: rupiah(0),
				occurredOn: STARTED_ON
			})
		).rejects.toThrow(TypeError);
		await expect(
			recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: rupiah(-1),
				occurredOn: STARTED_ON
			})
		).rejects.toThrow(TypeError);

		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(0);
	});

	it('refuses a day that is not a real calendar day', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Tanggal');

		await expect(
			recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: AMOUNT,
				occurredOn: '5 Januari 2026'
			})
		).rejects.toThrow(TypeError);
		await expect(
			recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: AMOUNT,
				occurredOn: '2026-02-31'
			})
		).rejects.toThrow(TypeError);

		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(0);
	});

	it('refuses a day inside a locked Periode, and takes the same day once a superuser reopens the month', async () => {
		// #315: the opening balance used to skip the Periode on the assumption that its day always
		// comes before the application was in use. Nothing held that assumption, so a superuser could
		// record one inside a month whose Laporan Bulanan had already been published, and the frozen
		// figures stopped matching the cash book. It now answers to the Periode like every other row.
		// December 2025, the last day of a manual book, a month no other test in this file locks.
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Periode Terkunci');
		const lastManualDay = '2025-12-31';
		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId: superuserId,
				year: 2025,
				month: 12,
				reason: 'Laporan Bulanan Desember terbit.'
			})
		);

		const refusal: unknown = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: lastManualDay
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PeriodLockedError);
		expect(refusal).toMatchObject({ occurredOn: lastManualDay, period: '2025-12' });
		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(0);

		await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2025,
			month: 12,
			reason: 'Saldo awal dicatat pada hari terakhir buku manual.'
		});
		const recorded = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: lastManualDay
		});

		expect(recorded).toMatchObject({ occurredOn: lastManualDay, amount: AMOUNT });
	});

	it('blocks a concurrent recording behind its lock, rather than letting it act on a stale read', async () => {
		// This is the race "hanya boleh ada satu" has to survive. Both requests read "there is no
		// opening balance yet" and both insert: under READ COMMITTED a reader never blocks on another
		// transaction's uncommitted row lock, it just reads the latest *committed* row, so a plain
		// check would let both through — and a cash book with two opening balances has no correct
		// total and no way back, because a Transaksi Kas is never updated and never deleted.
		//
		// The stand-in connection below plays the part of "the other concurrent recording": it takes
		// the same lock `lockOpeningBalanceCategory` takes, inserts the opening balance, and holds the
		// transaction open before committing — the exact window in which an unlocked check would
		// already have read its stale answer. `recordOpeningBalance` is the real function under test.
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Balapan');

		const other = await connectToSchema();
		try {
			await other.client.query('BEGIN');
			await other.client.query('select id from cash_categories where system_key = $1 for update', [
				SYSTEM_CATEGORY_KEY.openingBalance
			]);

			const recording = recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: AMOUNT,
				occurredOn: STARTED_ON
			});
			let settled = false;
			recording.then(
				() => (settled = true),
				() => (settled = true)
			);

			// `recordOpeningBalance` is trying to take the same lock `other` already holds. If it is
			// still unsettled after a wait this long, it is genuinely blocked, not merely slow — a
			// local query that is not waiting on a lock finishes in well under a millisecond.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(settled).toBe(false);

			// `other` now does what the concurrent recording it stands in for would do, and commits.
			await other.client.query(
				`insert into cash_transactions
					(occurred_on, type, category_id, amount, description, recorded_by, created_at)
				 values ($1, $2, (select id from cash_categories where system_key = $3), $4, $5, $6, now())`,
				[
					STARTED_ON,
					CASH_CATEGORY_TYPE.income,
					SYSTEM_CATEGORY_KEY.openingBalance,
					AMOUNT,
					OPENING_BALANCE_DESCRIPTION,
					superuserId
				]
			);
			await other.client.query('COMMIT');

			// Unblocked, `recordOpeningBalance` re-reads and sees the row that really is there now —
			// which is the point: it decides from the current committed state, not from whatever it
			// might have read before `other`'s lock was released.
			await expect(recording).rejects.toThrow(OpeningBalanceAlreadyRecordedError);
			expect(await testDb.db.select().from(cashTransactions)).toHaveLength(1);
		} finally {
			await other.release();
		}
	});

	it('accepts a new one once a Koreksi has reversed the one in force, and refuses a third while the new one stands', async () => {
		// Spec #308, decision 3: the opening balance in force is the one no Koreksi has reversed. #33
		// counted a corrected row as "already recorded", so a wrong opening balance could be reversed
		// but never replaced.
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Ganti');
		const wrong = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});
		await correct(wrong.id);

		const right = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: rupiah(2_500_000),
			occurredOn: STARTED_ON
		});

		expect(right).toMatchObject({ amount: rupiah(2_500_000), correctionOf: null });
		const refusal: unknown = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: rupiah(1_000_000),
			occurredOn: STARTED_ON
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(OpeningBalanceAlreadyRecordedError);
		expect(refusal).toMatchObject({ existingTransactionId: right.id });
		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(3);
	});

	it('counts an opening balance as in force again once its Koreksi has itself been corrected', async () => {
		// A Koreksi of the Koreksi is how a wrong Koreksi is put right, and it puts the opening
		// balance's money back in the book. Recording a second one then would count the cash twice.
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Koreksi Ganda');
		const opening = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});
		const reversal = await correct(opening.id);
		await correct(reversal.id);

		const refusal: unknown = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(OpeningBalanceAlreadyRecordedError);
		expect(refusal).toMatchObject({ existingTransactionId: opening.id });
		expect(await getOpeningBalance(testDb.db, superuserId)).toMatchObject({ id: opening.id });
	});

	it('refuses a day after the earliest Transaksi Kas outside its category, naming that day, and takes that day itself', async () => {
		// A running balance that starts from zero and then meets an opening balance halfway through
		// is wrong for every day before it. The opening-balance category's own rows (an opening
		// balance and its Koreksi) do not count as that earliest transaction.
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Sesudah Transaksi');
		const reversed = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});
		await correct(reversed.id);
		const earliest = await recordOrdinaryLine('2026-03-04');
		await recordOrdinaryLine('2026-03-20');

		const refusal: unknown = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: '2026-03-05'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(OpeningBalanceAfterEarliestCashTransactionError);
		expect(refusal).toMatchObject({
			occurredOn: '2026-03-05',
			earliestTransactionId: earliest.id,
			earliestOccurredOn: '2026-03-04'
		});
		expect(String(refusal)).toContain('2026-03-04');
		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(4);

		// "Not after" lets the same day through: the opening balance is the cash at the start of it.
		const recorded = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: '2026-03-04'
		});
		expect(recorded).toMatchObject({ occurredOn: '2026-03-04' });
	});

	it('accepts any day in an open Periode while the book is empty', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Buku Kosong');

		const late = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: '2030-06-15'
		});
		expect(late).toMatchObject({ occurredOn: '2030-06-15' });

		await clearCashBook();
		const early = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: '2019-01-31'
		});
		expect(early).toMatchObject({ occurredOn: '2019-01-31' });
	});

	it('waits behind a Koreksi in flight against its category, and decides from what that Koreksi committed', async () => {
		// The race "the opening balance in force" has to survive beyond two recordings: the opening
		// balance is reversed, and an Admin is writing a Koreksi of that Koreksi, which puts it back
		// in force. That writer never asks for the category lock; it locks the line it corrects. If
		// `recordOpeningBalance` read the category's rows while that Koreksi was uncommitted, it would
		// see the opening balance as reversed, record a second one, and leave two in force.
		//
		// The stand-in connection plays the Koreksi writer step for step: it locks the reversing line
		// (`for no key update`, which conflicts with the writer's `for update` the same way), inserts
		// the Koreksi of it, and holds the transaction open. The insert's foreign-key check on
		// `category_id` takes `FOR KEY SHARE` on the category row, which conflicts with the category
		// lock `recordOpeningBalance` takes: that conflict is what this test proves holds.
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Balapan Koreksi');
		const opening = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});
		const reversal = await correct(opening.id);

		const other = await connectToSchema();
		try {
			await other.client.query('BEGIN');
			await other.client.query('select id from cash_transactions where id = $1 for no key update', [
				reversal.id
			]);
			await other.client.query(
				`insert into cash_transactions
					(occurred_on, type, category_id, amount, description, recorded_by, correction_of, created_at)
				 values ($1, $2, $3, $4, $5, $6, $7, now())`,
				[
					STARTED_ON,
					CASH_CATEGORY_TYPE.income,
					opening.categoryId,
					AMOUNT,
					'Koreksi atas koreksi yang keliru.',
					superuserId,
					reversal.id
				]
			);

			const recording = recordOpeningBalance(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				amount: rupiah(2_500_000),
				occurredOn: STARTED_ON
			});
			let settled = false;
			recording.then(
				() => (settled = true),
				() => (settled = true)
			);

			// A local query that is not waiting on a lock finishes in well under a millisecond.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(settled).toBe(false);

			await other.client.query('COMMIT');

			const refusal: unknown = await recording.catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(OpeningBalanceAlreadyRecordedError);
			expect(refusal).toMatchObject({ existingTransactionId: opening.id });
			expect(await testDb.db.select().from(cashTransactions)).toHaveLength(3);
		} finally {
			await other.release();
		}
	});
});

describe('getOpeningBalance', () => {
	it('answers with nothing before one is recorded, and with the row afterwards', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Baca');

		expect(await getOpeningBalance(testDb.db, superuserId)).toBeUndefined();

		const recorded = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});

		expect(await getOpeningBalance(testDb.db, superuserId)).toMatchObject({
			id: recorded.id,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});
	});

	it('answers with nothing once a Koreksi has reversed it, which is what brings the form back', async () => {
		await clearCashBook();
		const superuserId = await insertSuperuser('Pengurus Saldo Awal Baca Koreksi');
		const recorded = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: AMOUNT,
			occurredOn: STARTED_ON
		});

		await correct(recorded.id);

		expect(await getOpeningBalance(testDb.db, superuserId)).toBeUndefined();
	});

	it('refuses an admin who is not also a superuser', async () => {
		const adminId = await insertUserWithRole('Pengurus Harian Baca Saldo', ROLE.admin);

		await expect(getOpeningBalance(testDb.db, adminId)).rejects.toThrow(PermissionDeniedError);
	});
});
