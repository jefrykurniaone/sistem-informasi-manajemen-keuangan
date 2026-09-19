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
import { CASH_CATEGORY_TYPE } from '$lib/server/db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '$lib/server/db/schema/cash-transaction';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { createCashCategory } from '$lib/server/services/cash/category';
import {
	CASH_CORRECTION_RECORDED_ACTION,
	CashTransactionAlreadyCorrectedError,
	CashTransactionNotFoundError,
	recordCashCorrection
} from '$lib/server/services/cash/correction';
import { getOpeningBalance, recordOpeningBalance } from '$lib/server/services/cash/opening-balance';
import { lockPeriod, PeriodLockedError, unlockPeriod } from '$lib/server/services/cash/period';
import { CashRuleError, recordCashTransaction } from '$lib/server/services/cash/transaction';

/**
 * The Koreksi: the reversing line that is the only way a mistake in the buku kas is put right, and
 * the rule that one line is corrected once. Against a real PostgreSQL, because "once" is held by a
 * row lock and a lock is a rule about concurrent transactions.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The day the transaction being corrected happened. Its Koreksi carries the same day. */
const DAY = '2026-03-04';

/** The amount most of these tests record and then reverse. */
const AMOUNT = rupiah(150_000);

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

/** An admin, who is who records and corrects a Transaksi Kas. */
async function insertAdmin(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.admin);
}

/** A superuser, who is who manages categories and records the Saldo awal. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** One ordinary category, added through the service that owns categories. */
async function addCategory(name: string, type: string = CASH_CATEGORY_TYPE.expense) {
	const superuserId = await insertSuperuser(`Pengurus Kategori ${name}`);
	return createCashCategory(testDb.db, new FakeClock(START), { actorId: superuserId, name, type });
}

/** One recorded transaction, ready to be corrected. */
async function recordOne(
	actorId: string,
	categoryId: string,
	description = 'Perbaikan gerbang depan'
): Promise<CashTransaction> {
	return recordCashTransaction(
		testDb.db,
		new FakeClock(START),
		new FakeFileStore(new FakeClock(START)),
		{ actorId, occurredOn: DAY, categoryId, amount: AMOUNT, description }
	);
}

/** The row with this id, read straight back out of the table. */
async function transactionById(id: string): Promise<CashTransaction | undefined> {
	const [row] = await testDb.db.select().from(cashTransactions).where(eq(cashTransactions.id, id));
	return row;
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

describe('recordCashCorrection', () => {
	it('writes a reversing line: opposite type, same amount, same category, same day', async () => {
		const adminId = await insertAdmin('Pengurus Koreksi Dasar');
		const category = await addCategory('Perbaikan gerbang');
		const original = await recordOne(adminId, category.id);
		const clock = new FakeClock(START);
		clock.advance(60_000);

		const correction = await recordCashCorrection(testDb.db, clock, {
			actorId: adminId,
			transactionId: original.id,
			reason: '  Nominalnya salah ketik, seharusnya 1.500.000.  '
		});

		expect(correction).toMatchObject({
			// Everything but the reason is read off the original, so none of it can be got wrong.
			occurredOn: original.occurredOn,
			type: CASH_CATEGORY_TYPE.income,
			categoryId: original.categoryId,
			amount: original.amount,
			description: 'Nominalnya salah ketik, seharusnya 1.500.000.',
			attachmentKey: null,
			recordedBy: adminId,
			correctionOf: original.id
		});
		expect(original.type).toBe(CASH_CATEGORY_TYPE.expense);
	});

	it('leaves the corrected line exactly as it was, and files the audit row against it', async () => {
		// "Koreksi yang tidak terlihat sama saja dengan penghapusan": both lines stay, and the one
		// that was wrong is not touched. The audit row goes on the original because "this line was
		// corrected, by whom and why" is the question somebody reading that line actually has.
		const adminId = await insertAdmin('Pengurus Koreksi Jejak');
		const category = await addCategory('Kebersihan taman');
		const original = await recordOne(adminId, category.id);
		const before = await transactionById(original.id);
		const clock = new FakeClock(START);
		clock.advance(60_000);

		const correction = await recordCashCorrection(testDb.db, clock, {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Dobel dengan baris sebelumnya.'
		});

		expect(await transactionById(original.id)).toEqual(before);
		const entries = await auditEntriesFor(testDb.db, original.id);
		expect(entries[0]).toMatchObject({
			actorId: adminId,
			action: CASH_CORRECTION_RECORDED_ACTION,
			targetId: original.id,
			before: { type: original.type, amount: original.amount },
			after: {
				correctionId: correction.id,
				type: correction.type,
				reason: 'Dobel dengan baris sebelumnya.'
			}
		});
	});

	it('refuses a reason that says nothing, because the alasan is the only thing a person supplies', async () => {
		const adminId = await insertAdmin('Pengurus Koreksi Tanpa Alasan');
		const category = await addCategory('Perbaikan lampu taman');
		const original = await recordOne(adminId, category.id);

		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: original.id,
				reason: '   '
			})
		).rejects.toThrow(CashRuleError);

		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.correctionOf, original.id))
		).toHaveLength(0);
	});

	it('refuses a second correction of the same line, and names the one that already exists', async () => {
		const adminId = await insertAdmin('Pengurus Koreksi Dua Kali');
		const category = await addCategory('Perbaikan pagar samping');
		const original = await recordOne(adminId, category.id);
		const first = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Salah kategori.'
		});

		const refusal: unknown = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Salah lagi.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(CashTransactionAlreadyCorrectedError);
		expect(refusal).toMatchObject({ transactionId: original.id, correctionId: first.id });
		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.correctionOf, original.id))
		).toHaveLength(1);
	});

	it('corrects a Koreksi itself, once, so a wrong correction is not permanent', async () => {
		// The rule is uniform: any line accepts one Koreksi, whether it is an ordinary row or a
		// reversing one. It has to be — a Koreksi written against the wrong line is itself a mistake,
		// and an append-only book whose corrections could not be corrected would keep it forever.
		const adminId = await insertAdmin('Pengurus Koreksi Berantai');
		const category = await addCategory('Perbaikan jalan setapak');
		const original = await recordOne(adminId, category.id);
		const clock = new FakeClock(START);
		clock.advance(60_000);
		const correction = await recordCashCorrection(testDb.db, clock, {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Keliru, baris ini bukan pengeluaran itu.'
		});
		clock.advance(60_000);

		const undone = await recordCashCorrection(testDb.db, clock, {
			actorId: adminId,
			transactionId: correction.id,
			reason: 'Koreksinya yang keliru; baris aslinya benar.'
		});

		// Reversing the reversal restores the original's direction and amount, so the three lines net
		// out to exactly what the first one said.
		expect(undone).toMatchObject({
			type: original.type,
			amount: original.amount,
			categoryId: original.categoryId,
			occurredOn: original.occurredOn,
			correctionOf: correction.id
		});
		await expect(
			recordCashCorrection(testDb.db, clock, {
				actorId: adminId,
				transactionId: correction.id,
				reason: 'Sekali lagi.'
			})
		).rejects.toThrow(CashTransactionAlreadyCorrectedError);
	});

	it('corrects the Saldo awal, which is what the opening balance screen promises', async () => {
		// `recordOpeningBalance` offers no edit and no delete on purpose, and its screen tells the
		// superuser that a wrong figure is put right with a correcting transaction. That promise is
		// this function's to keep, so the system category a Koreksi lands in is never refused — only
		// the *manual recording* path refuses one.
		const adminId = await insertAdmin('Pengurus Koreksi Saldo Awal');
		const superuserId = await insertSuperuser('Pengurus Catat Saldo Awal Koreksi');
		await testDb.db.delete(cashTransactions);
		const opening = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: rupiah(2_750_000),
			occurredOn: '2026-01-05'
		});

		const correction = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: opening.id,
			reason: 'Saldo awal keliru; uang di kas sebenarnya 2.500.000.'
		});

		expect(correction).toMatchObject({
			type: CASH_CATEGORY_TYPE.expense,
			amount: opening.amount,
			categoryId: opening.categoryId,
			occurredOn: opening.occurredOn,
			correctionOf: opening.id
		});
		// The opening balance itself is untouched, and #33 still refuses to record a second one.
		expect(await getOpeningBalance(testDb.db, superuserId)).toBeDefined();
		await testDb.db.delete(cashTransactions);
	});

	it('refuses an id no transaction carries', async () => {
		const adminId = await insertAdmin('Pengurus Koreksi Hantu');

		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: randomUUID(),
				reason: 'Tidak ada barisnya.'
			})
		).rejects.toThrow(CashTransactionNotFoundError);
	});

	it('refuses a superuser who is not also an admin, and a resident, and writes nothing', async () => {
		const adminId = await insertAdmin('Pengurus Koreksi Berhak');
		const category = await addCategory('Perbaikan bak sampah');
		const original = await recordOne(adminId, category.id);
		const superuserId = await insertSuperuser('Pengurus Koreksi Tanpa Peran Harian');
		const residentId = await insertUser('Warga Biasa Koreksi');

		for (const actorId of [superuserId, residentId]) {
			await expect(
				recordCashCorrection(testDb.db, new FakeClock(START), {
					actorId,
					transactionId: original.id,
					reason: 'Bukan hak saya.'
				})
			).rejects.toThrow(PermissionDeniedError);
		}

		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.correctionOf, original.id))
		).toHaveLength(0);
	});

	it('waits for the unlock when the line it corrects sits inside a locked Periode', async () => {
		// The Koreksi carries the corrected line's own `occurredOn`, so the month it has to answer to
		// is that line's month. A correction of a published month therefore waits for the superuser's
		// unlock instead of quietly moving a number residents have already read. August is used rather
		// than this file's `DAY` so that locking a month cannot reach the tests around it.
		const adminId = await insertAdmin('Pengurus Koreksi Bulan Terkunci');
		const superuserId = await insertSuperuser('Pengurus Buka Kunci Bulan Koreksi');
		const category = await addCategory('Perbaikan talang koreksi');
		const original = await recordCashTransaction(
			testDb.db,
			new FakeClock(START),
			new FakeFileStore(new FakeClock(START)),
			{
				actorId: adminId,
				occurredOn: '2026-08-13',
				categoryId: category.id,
				amount: AMOUNT,
				description: 'Perbaikan talang belakang'
			}
		);
		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId: adminId,
				year: 2026,
				month: 8,
				reason: 'Laporan Bulanan revisi 1 terbit.'
			})
		);

		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: original.id,
				reason: 'Nominalnya salah ketik.'
			})
		).rejects.toThrow(PeriodLockedError);

		await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2026,
			month: 8,
			reason: 'Nota bulan itu baru ditemukan dan harus masuk.'
		});
		const correction = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Nominalnya salah ketik.'
		});

		expect(correction).toMatchObject({ occurredOn: '2026-08-13', correctionOf: original.id });
	});

	it('blocks a concurrent correction behind its lock, rather than letting it act on a stale read', async () => {
		// This is the race "tidak dapat dikoreksi dua kali" has to survive. Both requests read "no
		// Koreksi yet" and both insert: under READ COMMITTED a reader never blocks on another
		// transaction's uncommitted row lock, it just reads the latest *committed* row, so a plain
		// check would let both through — and a line reversed twice is the same money taken out of the
		// book twice, with no way back, because a Transaksi Kas is never updated and never deleted.
		//
		// The stand-in connection below plays the part of "the other concurrent correction": it takes
		// the same row lock `lockTransaction` takes, inserts the Koreksi, and holds the transaction
		// open before committing — the exact window in which an unlocked check would already have read
		// its stale answer. `recordCashCorrection` is the real function under test.
		const adminId = await insertAdmin('Pengurus Koreksi Balapan');
		const category = await addCategory('Perbaikan gorong-gorong');
		const original = await recordOne(adminId, category.id);

		const other = await connectToSchema();
		try {
			await other.client.query('BEGIN');
			await other.client.query('select id from cash_transactions where id = $1 for update', [
				original.id
			]);

			const correcting = recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: original.id,
				reason: 'Koreksi yang kalah balapan.'
			});
			let settled = false;
			correcting.then(
				() => (settled = true),
				() => (settled = true)
			);

			// `recordCashCorrection` is trying to take the same lock `other` already holds. If it is
			// still unsettled after a wait this long, it is genuinely blocked, not merely slow — a local
			// query that is not waiting on a lock finishes in well under a millisecond.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(settled).toBe(false);

			// `other` now does what the concurrent correction it stands in for would do, and commits.
			await other.client.query(
				`insert into cash_transactions
					(occurred_on, type, category_id, amount, description, recorded_by, correction_of, created_at)
				 values ($1, $2, $3, $4, $5, $6, $7, now())`,
				[
					original.occurredOn,
					CASH_CATEGORY_TYPE.income,
					original.categoryId,
					original.amount,
					'Koreksi yang menang balapan.',
					adminId,
					original.id
				]
			);
			await other.client.query('COMMIT');

			// Unblocked, `recordCashCorrection` re-reads and sees the Koreksi that really is there now.
			await expect(correcting).rejects.toThrow(CashTransactionAlreadyCorrectedError);
			expect(
				await testDb.db
					.select()
					.from(cashTransactions)
					.where(eq(cashTransactions.correctionOf, original.id))
			).toHaveLength(1);
		} finally {
			await other.release();
		}
	});
});
