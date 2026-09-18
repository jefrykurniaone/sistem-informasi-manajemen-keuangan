import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY
} from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import * as openingBalanceModule from '$lib/server/services/cash/opening-balance';
import {
	getOpeningBalance,
	OPENING_BALANCE_DESCRIPTION,
	OPENING_BALANCE_RECORDED_ACTION,
	OpeningBalanceAlreadyRecordedError,
	recordOpeningBalance
} from '$lib/server/services/cash/opening-balance';

/**
 * The Saldo awal: recorded once, by a superuser, as one income transaction in the system category
 * `opening-balance` — and refused every time after that, including when the second request arrives
 * while the first one is still open. Against a real PostgreSQL, because the rule being tested is a
 * rule about committing.
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

	it('refuses an admin who is not also a superuser', async () => {
		const adminId = await insertUserWithRole('Pengurus Harian Baca Saldo', ROLE.admin);

		await expect(getOpeningBalance(testDb.db, adminId)).rejects.toThrow(PermissionDeniedError);
	});
});
