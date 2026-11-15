import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '#lib/errors.ts';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { auditEntriesFor } from '#lib/server/audit.ts';
import { createConnection, readDatabaseUrl } from '#lib/server/db/index.ts';
import { allocations } from '#lib/server/db/schema/allocation.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles, type Role } from '#lib/server/db/schema/authz.ts';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY
} from '#lib/server/db/schema/cash-category.ts';
import { cashTransactions } from '#lib/server/db/schema/cash-transaction.ts';
import { duesRates } from '#lib/server/db/schema/dues-rate.ts';
import { invoices } from '#lib/server/db/schema/invoice.ts';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '#lib/server/db/schema/payment.ts';
import { refunds } from '#lib/server/db/schema/refund.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { units } from '#lib/server/db/schema/unit.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import {
	CashCorrectionTargetError,
	recordCashCorrection
} from '#lib/server/services/cash/correction.ts';
import { lockPeriod, PeriodLockedError } from '#lib/server/services/cash/period.ts';
import {
	creditBalanceOfUnit,
	lockUnallocatedVerifiedPayments
} from '#lib/server/services/dues/credit-balance.ts';
import {
	correctionsHistoryFor,
	unitFinanceFor
} from '#lib/server/services/dues/corrections-history.ts';
import {
	CREDIT_REFUNDED_ACTION,
	REFUND_REVERSED_ACTION,
	REVERSE_REFUND_RULE,
	RefundNotFoundError,
	ReverseRefundRuleError,
	readDuesCorrectionRecord,
	refundCredit,
	reverseRefund,
	type RefundOutcome,
	type RefundReversedRecord
} from '#lib/server/services/dues/dues-correction.ts';
import { issueInvoicesForPeriod } from '#lib/server/services/dues/issuance.ts';

/**
 * Pembatalan Pengembalian (#329, spec #308 decision 6): one Pengembalian reversed by a Koreksi of
 * its cash expense, through the writer's `refundReverseCorrection` kind, with no column of its own:
 * "already reversed" is the Koreksi on the cash line, and Saldo Titipan subtracts only the
 * Pengembalian still in force. Against a real PostgreSQL with a fake clock, because every rule here
 * is about committed rows, dated money and row locks.
 *
 * The locks are proven the way the repository asks: a second connection holds a row
 * `for no key update`, the reversal is shown to be waiting on it through `pg_blocking_pids`, and what
 * the reversal does once the holder lets go is asserted.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. Its UTC day is 2026-03-10. */
const START = '2026-03-10T09:00:00.000Z';

/** The day the refunded money in this file was handed back. */
const REFUND_DAY = '2026-03-08';

const REFUND_REASON = 'Masa huninya berakhir dan saldo titipannya dikembalikan.';
const REVERSE_REASON = 'Pengembalian salah catat: uangnya tidak jadi diserahkan.';

/** PostgreSQL's `lock_not_available`, raised by a `nowait` lock that would have to wait. */
const LOCK_NOT_AVAILABLE = '55P03';

/** How long a lock test waits for the reversal to start waiting before it gives up. */
const WAIT_TIMEOUT_MILLISECONDS = 10_000;

/** How often it looks. */
const POLL_MILLISECONDS = 20;

/** Makes every house and every email in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** A second connection into this file's schema, for holding a lock the code under test must meet. */
async function connectToSchema() {
	const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
		options: `-c search_path=${testDb.schemaName}`
	});
	const client = await other.pool.connect();
	const [{ pid }] = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows;
	return {
		client,
		pid,
		release: async () => {
			client.release();
			await other.close();
		}
	};
}

/**
 * Waits until some backend is waiting on a lock the backend `blockerPid` holds. Polled, because
 * PostgreSQL announces no event for a statement starting to wait.
 */
async function waitUntilWaitingOn(blockerPid: number): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await testDb.db.execute<{ waiting: number }>(
			sql`select count(*)::int as waiting from pg_stat_activity activity
				where ${blockerPid}::int = any(pg_blocking_pids(activity.pid))`
		);
		if ((result.rows[0]?.waiting ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
	}
	throw new Error(`No backend ever waited on backend ${blockerPid}.`);
}

/** Inserts a bare `user` row. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${unique(id)}@komplek.local`,
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

/** The superuser who refunds and reverses. No `residents` row: both attribute by account. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** One house. Returns its id. */
async function insertUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'RV', number: unique('1'), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One verified Pembayaran of `amount`, received on `receivedOn`. Returns its id. */
async function insertVerifiedPayment(
	unitId: string,
	amount: Rupiah,
	receivedOn: string = '2026-02-03'
): Promise<string> {
	const userId = await insertUser('Warga Pembatalan Pengembalian');
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy: resident.id,
			amount,
			receivedOn,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: null,
			status: PAYMENT_STATUS.verified,
			verifiedBy: resident.id,
			verifiedAt: new Date(START),
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** The seeded system category "Iuran warga". */
async function duesCategoryId(): Promise<string> {
	const [row] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	return row.id;
}

/** A Pengembalian of `amount` from `unitId`'s balance, through the real service. */
async function refund(
	actorId: string,
	unitId: string,
	amount: Rupiah,
	occurredOn: string = REFUND_DAY
): Promise<RefundOutcome> {
	return refundCredit(testDb.db, new FakeClock(START), {
		actorId,
		unitId,
		amount,
		occurredOn,
		reason: REFUND_REASON
	});
}

/** Every Koreksi filed against `cashTransactionId`. */
async function correctionsOf(cashTransactionId: string) {
	return testDb.db
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.correctionOf, cashTransactionId));
}

/** The remainders a spender of `unitId`'s balance would be handed. */
async function remaindersOf(unitId: string) {
	return testDb.db.transaction(async (transaction) =>
		lockUnallocatedVerifiedPayments(transaction, unitId)
	);
}

/** One house with a verified Rp300.000 Pembayaran, Rp120.000 of which was returned. */
async function refundedHouse(name: string, occurredOn: string = REFUND_DAY) {
	const actorId = await insertSuperuser(name);
	const unitId = await insertUnit();
	const paymentId = await insertVerifiedPayment(unitId, rupiah(300_000));
	const outcome = await refund(actorId, unitId, rupiah(120_000), occurredOn);
	expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(180_000);
	const [portion] = outcome.portions;
	return {
		actorId,
		unitId,
		paymentId,
		refundId: portion.refund.id,
		cashTransactionId: portion.cashTransaction.id
	};
}

describe('reverseRefund', () => {
	it('gives the Unit its Saldo Titipan back by the refund amount, through one Koreksi of the cash line', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Pengembalian');
		const [refundBefore] = await testDb.db
			.select()
			.from(refunds)
			.where(eq(refunds.id, house.refundId));

		const reversed = await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: `  ${REVERSE_REASON}  `
		});

		// The balance and the payment's remainder are back by exactly the refund's amount.
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(300_000);
		expect(await remaindersOf(house.unitId)).toEqual([
			expect.objectContaining({ paymentId: house.paymentId, remainder: 300_000 })
		]);

		// One Koreksi: income, the same amount, day and category as the expense, pointing at it.
		expect(reversed.unitId).toBe(house.unitId);
		expect(reversed.correction).toMatchObject({
			occurredOn: REFUND_DAY,
			type: CASH_CATEGORY_TYPE.income,
			categoryId: await duesCategoryId(),
			amount: 120_000,
			description: REVERSE_REASON,
			recordedBy: house.actorId,
			attachmentKey: null,
			correctionOf: house.cashTransactionId
		});
		expect(await correctionsOf(house.cashTransactionId)).toEqual([reversed.correction]);

		// Nothing changed in place: the `refunds` row is exactly what it was.
		const [refundAfter] = await testDb.db
			.select()
			.from(refunds)
			.where(eq(refunds.id, house.refundId));
		expect(refundAfter).toEqual(refundBefore);
		expect(reversed.refund).toEqual(refundBefore);
	});

	it('keeps the cash book and the dues side balanced: the dues category nets back to the money kept', async () => {
		// The buku kas side of the invariant, on one Pengembalian: its expense and its Koreksi net to
		// zero once it is reversed, so the kas holds again exactly the money the Unit's balance got
		// back. The whole-book version runs in `tests/unit/unit-money-invariant.test.ts`.
		const house = await refundedHouse('Pengurus Pembatalan Buku Kas');
		const categoryId = await duesCategoryId();
		/** The signed total of the refund's cash line and any Koreksi of it, all in "Iuran warga". */
		const netOfHouse = async () => {
			const rows = await testDb.db
				.select()
				.from(cashTransactions)
				.where(
					and(
						eq(cashTransactions.categoryId, categoryId),
						or(
							eq(cashTransactions.id, house.cashTransactionId),
							eq(cashTransactions.correctionOf, house.cashTransactionId)
						)
					)
				);
			return rows.reduce(
				(total, row) => total + (row.type === CASH_CATEGORY_TYPE.income ? row.amount : -row.amount),
				0
			);
		};
		expect(await netOfHouse()).toBe(-120_000);

		await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: REVERSE_REASON
		});

		expect(await netOfHouse()).toBe(0);
	});

	it('reverses one Pengembalian of a refund that drained two Pembayaran, and only that one', async () => {
		// Spec #308 decision 6: one refund action over two Pembayaran is stored as two Pengembalian,
		// and each is reversed on its own.
		const actorId = await insertSuperuser('Pengurus Pembatalan Dua Bagian');
		const unitId = await insertUnit();
		const older = await insertVerifiedPayment(unitId, rupiah(100_000), '2026-02-01');
		const newer = await insertVerifiedPayment(unitId, rupiah(100_000), '2026-02-05');
		const outcome = await refund(actorId, unitId, rupiah(150_000));
		const [first, second] = outcome.portions;
		expect(first.refund.paymentId).toBe(older);
		expect(second.refund.paymentId).toBe(newer);
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(50_000);

		await reverseRefund(testDb.db, new FakeClock(START), {
			actorId,
			refundId: second.refund.id,
			reason: REVERSE_REASON
		});

		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(100_000);
		expect(await remaindersOf(unitId)).toEqual([
			expect.objectContaining({ paymentId: older, remainder: 0 }),
			expect.objectContaining({ paymentId: newer, remainder: 100_000 })
		]);
		expect(await correctionsOf(first.cashTransaction.id)).toHaveLength(0);

		await reverseRefund(testDb.db, new FakeClock(START), {
			actorId,
			refundId: first.refund.id,
			reason: REVERSE_REASON
		});
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(200_000);
	});

	it('gives back money the next issuance may spend again', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Terbit');
		await testDb.db.insert(duesRates).values({
			amount: rupiah(250_000),
			effectiveFrom: '2026-01-01',
			createdAt: new Date(START)
		});

		await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: REVERSE_REASON
		});
		await issueInvoicesForPeriod(testDb.db, new FakeClock(START), '2026-04');

		// Rp300.000 back in the balance, so the Rp250.000 Tagihan is paid out of it whole. Without the
		// reversal only Rp180.000 would have been there.
		const [issued] = await testDb.db
			.select()
			.from(invoices)
			.where(and(eq(invoices.unitId, house.unitId), eq(invoices.period, '2026-04')));
		const absorbed = await testDb.db
			.select()
			.from(allocations)
			.where(eq(allocations.invoiceId, issued.id));
		expect(absorbed.reduce((total, row) => total + row.amount, 0)).toBe(250_000);
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(50_000);
	});

	it('records exactly one typed audit row, filed against the Pengembalian, that the history shows', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Catatan');

		// A minute after the refund, so the history has one order to show.
		const clock = new FakeClock(START);
		clock.advance(60_000);
		const reversed = await reverseRefund(testDb.db, clock, {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: `  ${REVERSE_REASON}  `
		});

		const entries = await auditEntriesFor(testDb.db, house.refundId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ actorId: house.actorId });
		expect(readDuesCorrectionRecord(entries[0])).toEqual({
			action: REFUND_REVERSED_ACTION,
			targetId: house.refundId,
			before: null,
			after: {
				unitId: house.unitId,
				reason: REVERSE_REASON,
				paymentId: house.paymentId,
				cashTransactionId: house.cashTransactionId,
				correctionId: reversed.correction.id,
				amount: rupiah(120_000),
				occurredOn: REFUND_DAY
			}
		} satisfies RefundReversedRecord);

		const history = await correctionsHistoryFor(testDb.db, house.actorId, house.unitId);
		expect(history.map((entry) => [entry.action, entry.amount, entry.reason])).toEqual([
			[REFUND_REVERSED_ACTION, 120_000, REVERSE_REASON],
			[CREDIT_REFUNDED_ACTION, 120_000, REFUND_REASON]
		]);
	});

	it('shows the Pengembalian on the finance screen model, in force before and reversed after', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Layar');
		const clock = new FakeClock(START);

		const before = await unitFinanceFor(testDb.db, clock, house.actorId, house.unitId);
		expect(before.refunds).toEqual([
			{
				refundId: house.refundId,
				paymentId: house.paymentId,
				amount: 120_000,
				occurredOn: REFUND_DAY,
				reason: REFUND_REASON,
				inForce: true,
				reversalReason: null
			}
		]);

		await reverseRefund(testDb.db, clock, {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: REVERSE_REASON
		});

		const after = await unitFinanceFor(testDb.db, clock, house.actorId, house.unitId);
		expect(after.creditBalance).toBe(300_000);
		expect(after.refunds).toEqual([
			expect.objectContaining({
				refundId: house.refundId,
				inForce: false,
				reversalReason: REVERSE_REASON
			})
		]);
	});

	it('refuses a second reversal of the same Pengembalian by name, and writes nothing', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Dua Kali');
		await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: REVERSE_REASON
		});
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: 'Sekali lagi.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ReverseRefundRuleError);
		expect(refusal).toMatchObject({ rule: REVERSE_REFUND_RULE.alreadyReversed });
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect(await auditEntriesFor(testDb.db, house.refundId)).toHaveLength(1);
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(300_000);
	});

	it('stays reversed: the Koreksi it wrote cannot be taken back by an ordinary Koreksi', async () => {
		// The permanence the balance argument relies on. The reversal's Koreksi is a line in "Iuran
		// warga", which the ordinary Koreksi refuses (#323); otherwise a Koreksi of the Koreksi would
		// put the refund back in force without the payment lock.
		const house = await refundedHouse('Pengurus Pembatalan Permanen');
		const reversed = await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: REVERSE_REASON
		});
		const adminId = await insertUserWithRole('Pengurus Harian Koreksi Balik', ROLE.admin);

		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: reversed.correction.id,
				reason: 'Mengembalikan pengembalian.'
			})
		).rejects.toThrow(CashCorrectionTargetError);
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(300_000);
	});

	it('refuses a Pengembalian dated in a locked Periode, naming the month, and writes nothing', async () => {
		// February is used so no other test in this file is reached by the lock.
		const house = await refundedHouse('Pengurus Pembatalan Terkunci', '2026-02-15');
		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId: house.actorId,
				year: 2026,
				month: 2,
				reason: 'Laporan bulan itu sudah terbit.'
			})
		);
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: REVERSE_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PeriodLockedError);
		expect(refusal).toMatchObject({ period: '2026-02', occurredOn: '2026-02-15' });
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect(await auditEntriesFor(testDb.db, house.refundId)).toHaveLength(0);
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(180_000);
	});

	it('refuses an admin who is not a superuser, and a resident, and writes nothing', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Hak');
		const adminId = await insertUserWithRole('Pengurus Harian Pembatalan', ROLE.admin);
		const residentId = await insertUser('Warga Biasa Pembatalan');
		const cashBefore = await testDb.db.select().from(cashTransactions);

		for (const actorId of [adminId, residentId]) {
			await expect(
				reverseRefund(testDb.db, new FakeClock(START), {
					actorId,
					refundId: house.refundId,
					reason: REVERSE_REASON
				})
			).rejects.toThrow(PermissionDeniedError);
		}

		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect(await auditEntriesFor(testDb.db, house.refundId)).toHaveLength(0);
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(180_000);
	});

	it('refuses an empty reason by its own rule', async () => {
		const house = await refundedHouse('Pengurus Pembatalan Tanpa Alasan');

		const refusal: unknown = await reverseRefund(testDb.db, new FakeClock(START), {
			actorId: house.actorId,
			refundId: house.refundId,
			reason: ' \t '
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ReverseRefundRuleError);
		expect(refusal).toMatchObject({ rule: REVERSE_REFUND_RULE.reasonMissing });
		expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);
	});

	it('refuses a Pengembalian that does not exist', async () => {
		const actorId = await insertSuperuser('Pengurus Pembatalan Hantu');

		await expect(
			reverseRefund(testDb.db, new FakeClock(START), {
				actorId,
				refundId: randomUUID(),
				reason: REVERSE_REASON
			})
		).rejects.toThrow(RefundNotFoundError);
	});
});

describe('the locks of a Pembatalan Pengembalian', () => {
	it('waits for the Pembayaran, then reads "already reversed" under its lock and refuses', async () => {
		// The second connection holds the refund's Pembayaran `for no key update`, which conflicts
		// with the reversal's `for update` on it. While the reversal is shown to be waiting there, the
		// holder writes a Koreksi of the refund's cash line (the shape of a reversal that won the
		// lock) and commits. The reversal must then see that committed Koreksi and refuse by name:
		// "already reversed" is read after the lock, in a fresh statement, not before it.
		const house = await refundedHouse('Pengurus Pembatalan Balapan');
		const categoryId = await duesCategoryId();

		const holder = await connectToSchema();
		try {
			await holder.client.query('begin');
			await holder.client.query('select id from payments where id = $1 for no key update', [
				house.paymentId
			]);

			const reversal = reverseRefund(testDb.db, new FakeClock(START), {
				actorId: house.actorId,
				refundId: house.refundId,
				reason: REVERSE_REASON
			}).catch((error: unknown) => error);
			await waitUntilWaitingOn(holder.pid);

			// Still waiting: it has written nothing.
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);

			await holder.client.query(
				`insert into cash_transactions
					(id, occurred_on, type, category_id, amount, description, attachment_key, recorded_by, correction_of, created_at)
				values ($1, $2, 'income', $3, 120000, 'Pembatalan yang menang.', null, $4, $5, $6)`,
				[randomUUID(), REFUND_DAY, categoryId, house.actorId, house.cashTransactionId, START]
			);
			await holder.client.query('commit');

			const refusal = await reversal;
			expect(refusal).toBeInstanceOf(ReverseRefundRuleError);
			expect(refusal).toMatchObject({ rule: REVERSE_REFUND_RULE.alreadyReversed });
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(1);
			expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(300_000);
		} finally {
			await holder.release();
		}
	});

	it('holds the Pembayaran while it waits for the cash line: the payment first, the line second', async () => {
		// The fixed order: the second connection holds the refund's cash line `for no key update`,
		// which the writer's `for update` on it conflicts with. While the reversal waits there, a
		// third connection finds the Pembayaran already locked, so the payment was taken first. Then
		// the holder lets go and the reversal commits as any other would.
		const house = await refundedHouse('Pengurus Pembatalan Urutan Kunci');

		const holder = await connectToSchema();
		const prober = await connectToSchema();
		try {
			await holder.client.query('begin');
			await holder.client.query(
				'select id from cash_transactions where id = $1 for no key update',
				[house.cashTransactionId]
			);

			const reversal = reverseRefund(testDb.db, new FakeClock(START), {
				actorId: house.actorId,
				refundId: house.refundId,
				reason: REVERSE_REASON
			}).catch((error: unknown) => error);
			await waitUntilWaitingOn(holder.pid);

			await expect(
				prober.client.query('select id from payments where id = $1 for update nowait', [
					house.paymentId
				])
			).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);

			await holder.client.query('rollback');
			const outcome = await reversal;

			expect(outcome).not.toBeInstanceOf(Error);
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(1);
			expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(300_000);
		} finally {
			await holder.release();
			await prober.release();
		}
	});
});
