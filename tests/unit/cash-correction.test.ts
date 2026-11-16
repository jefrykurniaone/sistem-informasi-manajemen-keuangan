import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '#lib/errors.ts';
import { rupiah } from '#lib/money.ts';
import { auditEntriesFor } from '#lib/server/audit.ts';
import { createConnection, readDatabaseUrl } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles, type Role } from '#lib/server/db/schema/authz.ts';
import { CASH_CATEGORY_TYPE } from '#lib/server/db/schema/cash-category.ts';
import { cashTransactions, type CashTransaction } from '#lib/server/db/schema/cash-transaction.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock, FakeFileStore } from '#lib/server/ports/fakes.ts';
import { createCashCategory } from '#lib/server/services/cash/category.ts';
import {
	CASH_CORRECTION_RECORDED_ACTION,
	CashTransactionAlreadyCorrectedError,
	CashTransactionNotFoundError,
	recordCashCorrection
} from '#lib/server/services/cash/correction.ts';
import {
	getOpeningBalance,
	recordOpeningBalance
} from '#lib/server/services/cash/opening-balance.ts';
import { lockPeriod, PeriodLockedError, unlockPeriod } from '#lib/server/services/cash/period.ts';
import {
	CASH_WRITE_KIND,
	CashCorrectionTargetError,
	writeCashTransaction
} from '#lib/server/services/cash/writer.ts';
import {
	CashRuleError,
	recordCashTransaction,
	recordDuesIncome,
	recordDuesRefund
} from '#lib/server/services/cash/transaction.ts';

/**
 * The Koreksi: the reversing line that is the only way a mistake in the buku kas is put right, and
 * the rule that one line is corrected once. Against a real PostgreSQL, because "once" is held by a
 * row lock and a lock is a rule about concurrent transactions, with the partial unique index
 * `cash_transactions_correction_of_unique` behind it (#339).
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
		// superuser that a wrong figure is put right with a correcting transaction, then replaced by
		// recording a new one. The original opening balance is the line this function reverses, so the
		// system category it sits in is never refused for a Koreksi of the original — only the
		// *manual recording* path refuses one. A Koreksi of that Koreksi is refused: see below.
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
		// The opening balance itself is untouched, but corrected it is no longer the one in force, so
		// a new one may be recorded (spec #308, decision 3, reversing #33).
		expect(await getOpeningBalance(testDb.db, superuserId)).toBeUndefined();
		await testDb.db.delete(cashTransactions);
	});

	describe('refuses every line in "Iuran warga", and points at the Keuangan Unit screen', () => {
		/** Asserts the ordinary Koreksi refused `lineId` as a dues line, and wrote nothing. */
		async function expectDuesLineRefused(adminId: string, lineId: string) {
			const before = await testDb.db.select().from(cashTransactions);

			const refusal: unknown = await recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: lineId,
				reason: 'Salah catat.'
			}).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(CashCorrectionTargetError);
			expect(refusal).toMatchObject({
				transactionId: lineId,
				kind: 'correction',
				reason: 'duesLine'
			});
			expect(await testDb.db.select().from(cashTransactions)).toHaveLength(before.length);
			expect(await auditEntriesFor(testDb.db, lineId)).toEqual([]);
		}

		it('a dues income line', async () => {
			const adminId = await insertAdmin('Pengurus Koreksi Baris Iuran');
			const income = await testDb.db.transaction((transaction) =>
				recordDuesIncome(transaction, new FakeClock(START), {
					occurredOn: DAY,
					amount: AMOUNT,
					description: 'Iuran warga Blok Q No 1 (pembayaran uji koreksi)',
					recordedBy: adminId
				})
			);

			await expectDuesLineRefused(adminId, income.id);
		});

		it('a Pengembalian line', async () => {
			const adminId = await insertAdmin('Pengurus Koreksi Baris Pengembalian');
			const refund = await testDb.db.transaction((transaction) =>
				recordDuesRefund(transaction, new FakeClock(START), {
					occurredOn: DAY,
					amount: AMOUNT,
					description: 'Pengembalian Saldo Titipan Blok Q No 2 (uji koreksi)',
					recordedBy: adminId
				})
			);

			await expectDuesLineRefused(adminId, refund.id);
		});

		it('a Koreksi in that category, written by the Pembatalan verifikasi kind', async () => {
			const adminId = await insertAdmin('Pengurus Koreksi Atas Koreksi Iuran');
			const income = await testDb.db.transaction((transaction) =>
				recordDuesIncome(transaction, new FakeClock(START), {
					occurredOn: DAY,
					amount: AMOUNT,
					description: 'Iuran warga Blok Q No 3 (uji koreksi atas koreksi)',
					recordedBy: adminId
				})
			);
			const reversal = await testDb.db.transaction((transaction) =>
				writeCashTransaction(transaction, new FakeClock(START), {
					kind: CASH_WRITE_KIND.unverifyCorrection,
					recordedBy: adminId,
					transactionId: income.id,
					reason: 'Pembayaran tidak sah.'
				})
			);

			await expectDuesLineRefused(adminId, reversal.id);
		});
	});

	it('still corrects a manual line, and the original opening balance', async () => {
		const adminId = await insertAdmin('Pengurus Koreksi Baris Biasa');
		const category = await addCategory('Perbaikan talud');
		const manual = await recordOne(adminId, category.id);

		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: manual.id,
				reason: 'Salah ketik nominal.'
			})
		).resolves.toMatchObject({ correctionOf: manual.id });
	});

	it('refuses a Koreksi of a Koreksi of the Saldo awal, so one replaced opening balance is never reinstated beside its replacement', async () => {
		// Saldo awal, its Koreksi, a new Saldo awal, then a Koreksi of the first Koreksi: that last
		// step would put the first opening balance back in force next to the second and count the
		// cash twice. A reversed opening balance is replaced by recording a new one (#322), never by
		// reversing its Koreksi.
		const adminId = await insertAdmin('Pengurus Koreksi Saldo Awal Ganda');
		const superuserId = await insertSuperuser('Pengurus Catat Saldo Awal Ganda');
		await testDb.db.delete(cashTransactions);
		const first = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: rupiah(2_750_000),
			occurredOn: '2026-01-05'
		});
		const firstCorrection = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: first.id,
			reason: 'Saldo awal keliru.'
		});
		const second = await recordOpeningBalance(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			amount: rupiah(2_500_000),
			occurredOn: '2026-01-05'
		});
		const before = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: firstCorrection.id,
			reason: 'Koreksinya keliru.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(CashCorrectionTargetError);
		expect(refusal).toMatchObject({
			transactionId: firstCorrection.id,
			kind: 'correction',
			reason: 'reversedOpeningBalance'
		});
		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(before.length);
		// The replacement is the one in force, alone.
		expect(await getOpeningBalance(testDb.db, superuserId)).toMatchObject({ id: second.id });
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

/** What PostgreSQL said when it refused a statement, read off the `cause` chain Drizzle wraps it in. */
function databaseRefusal(error: unknown): { code: unknown; constraint: unknown } | undefined {
	let current: unknown = error;
	while (current instanceof Error) {
		if ('code' in current) {
			return {
				code: current.code,
				constraint: 'constraint' in current ? current.constraint : undefined
			};
		}
		current = current.cause;
	}
	return undefined;
}

describe('the index behind the lock', () => {
	it('answers a Koreksi only the index catches with the same named refusal, and leaves the transaction usable', async () => {
		// The one way a second Koreksi reaches `cash_transactions_correction_of_unique` through the
		// writer. At READ COMMITTED it cannot: the competing Koreksi waits on the line lock (its
		// foreign key check takes the line `for key share`), or has committed already and
		// `findCorrectionOf` sees it. Under `repeatable read` a snapshot taken before the other
		// Koreksi committed is granted the lock, cannot see that Koreksi, and inserts: PostgreSQL
		// refuses with 23505 on the index. Nothing here depends on timing, so the test is
		// deterministic: the snapshot is taken, then the other row commits, then the writer runs.
		const adminId = await insertAdmin('Pengurus Koreksi Lewat Indeks');
		const category = await addCategory('Perbaikan saluran air');
		const original = await recordOne(adminId, category.id);

		const other = await connectToSchema();
		let refusal: unknown;
		try {
			await testDb.db.transaction(
				async (transaction) => {
					// The first statement fixes the snapshot, and it sees no Koreksi yet.
					expect(
						await transaction
							.select()
							.from(cashTransactions)
							.where(eq(cashTransactions.correctionOf, original.id))
					).toHaveLength(0);

					await other.client.query(
						`insert into cash_transactions
							(occurred_on, type, category_id, amount, description, recorded_by, correction_of, created_at)
						 values ($1, $2, $3, $4, $5, $6, $7, now())`,
						[
							original.occurredOn,
							CASH_CATEGORY_TYPE.income,
							original.categoryId,
							original.amount,
							'Koreksi yang ditulis lebih dulu, di luar penulis.',
							adminId,
							original.id
						]
					);

					refusal = await writeCashTransaction(transaction, new FakeClock(START), {
						kind: CASH_WRITE_KIND.correction,
						recordedBy: adminId,
						transactionId: original.id,
						reason: 'Koreksi kedua yang hanya ditahan indeks.'
					}).catch((error: unknown) => error);

					// The savepoint rolled the insert back alone: without it the transaction would be
					// aborted and this statement would fail. The snapshot still cannot see the other
					// Koreksi, which is why the refusal names none.
					expect(
						await transaction
							.select()
							.from(cashTransactions)
							.where(eq(cashTransactions.correctionOf, original.id))
					).toHaveLength(0);
				},
				{ isolationLevel: 'repeatable read' }
			);
		} finally {
			await other.release();
		}

		expect(refusal).toBeInstanceOf(CashTransactionAlreadyCorrectedError);
		expect(refusal).toMatchObject({ transactionId: original.id, correctionId: null });
		expect(databaseRefusal(refusal)).toBeUndefined();
		const corrections = await testDb.db
			.select()
			.from(cashTransactions)
			.where(eq(cashTransactions.correctionOf, original.id));
		expect(corrections.map((row) => row.description)).toEqual([
			'Koreksi yang ditulis lebih dulu, di luar penulis.'
		]);
	});

	it('leaves any other unique violation on a Koreksi untranslated', async () => {
		// The translation recognises the index by name, not by 23505 alone. A unique index this test
		// adds to its own schema, on the keterangan, is the other violation: the original line and
		// its Koreksi both carry the same text, so the Koreksi collides on it and on nothing else.
		const OTHER_INDEX = 'cash_transactions_test_other_unique';
		const SAME_TEXT = 'Teks yang dijaga indeks lain dalam tes ini.';
		const adminId = await insertAdmin('Pengurus Koreksi Indeks Lain');
		const category = await addCategory('Perbaikan papan nama');
		await testDb.db.execute(
			sql`create unique index ${sql.identifier(OTHER_INDEX)} on cash_transactions (description)
			    where description = ${sql.raw(`'${SAME_TEXT}'`)}`
		);
		try {
			const original = await recordOne(adminId, category.id, SAME_TEXT);

			const refusal: unknown = await recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: original.id,
				reason: SAME_TEXT
			}).catch((error: unknown) => error);

			expect(refusal).not.toBeInstanceOf(CashTransactionAlreadyCorrectedError);
			expect(databaseRefusal(refusal)).toEqual({ code: '23505', constraint: OTHER_INDEX });
			expect(
				await testDb.db
					.select()
					.from(cashTransactions)
					.where(eq(cashTransactions.correctionOf, original.id))
			).toHaveLength(0);
		} finally {
			await testDb.db.execute(sql`drop index ${sql.identifier(OTHER_INDEX)}`);
		}
	});
});
