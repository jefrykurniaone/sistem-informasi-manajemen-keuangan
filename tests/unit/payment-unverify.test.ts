import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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
import { emailQueue } from '#lib/server/db/schema/email.ts';
import { invoices } from '#lib/server/db/schema/invoice.ts';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '#lib/server/db/schema/payment.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { units } from '#lib/server/db/schema/unit.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { PAYMENT_REJECTED_KIND } from '#lib/server/email/templates/payment-rejected.ts';
import type { Clock } from '#lib/server/ports/clock.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import {
	CashCorrectionTargetError,
	recordCashCorrection
} from '#lib/server/services/cash/correction.ts';
import { lockPeriod, PeriodLockedError } from '#lib/server/services/cash/period.ts';
import { CashTransactionAlreadyCorrectedError } from '#lib/server/services/cash/writer.ts';
import { creditBalanceOfUnit } from '#lib/server/services/dues/credit-balance.ts';
import {
	correctionsHistoryFor,
	unitFinanceFor
} from '#lib/server/services/dues/corrections-history.ts';
import {
	PAYMENT_UNVERIFIED_ACTION,
	REFUND_RULE,
	RefundRuleError,
	UNVERIFY_RULE,
	UnverifyRefusedRefundedError,
	UnverifyRuleError,
	readDuesCorrectionRecord,
	refundCredit,
	reverseRefund,
	unverifyPayment,
	type PaymentUnverifiedRecord
} from '#lib/server/services/dues/dues-correction.ts';
import { INVOICE_STATUS } from '#lib/server/services/dues/invoice-standing.ts';
import { issueInvoicesForPeriod } from '#lib/server/services/dues/issuance.ts';
import {
	PaymentNotFoundError,
	VERIFICATION_RULE,
	VerificationRuleError,
	verifyPayment
} from '#lib/server/services/dues/verification.ts';

/**
 * Pembatalan verifikasi (#331, spec #308 decision 5): a verified Pembayaran turned rejected, every
 * Alokasi of it released (the verification's and the issuance's alike), its income line reversed by
 * one Koreksi on its own day through the writer's `unverifyCorrection` kind, found through the
 * verification's Audit Log record, and the `payment-rejected` email queued after the commit. Against
 * a real PostgreSQL with a fake clock, because every rule here is about committed rows, dated money
 * and row locks.
 *
 * Every Pembayaran here is verified through the real `verifyPayment`, so its `payment_verified`
 * record is the one production writes; the one test that needs a Pembayaran without it says so.
 *
 * The locks are proven the way the repository asks: a second connection holds a row
 * `for no key update`, the action is shown to be waiting on it through `pg_blocking_pids`, and what
 * the action does once the holder lets go is asserted. `Promise.allSettled` proves nothing here.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at: 2026-11-12 in WIB, a day in an open month. */
const START = '2026-11-12T03:00:00.000Z';

/** The day the money of most Pembayaran in this file was said to arrive. */
const RECEIVED_ON = '2026-10-03';

/** The Periode of the Tagihan most houses here owe. */
const OCTOBER = '2026-10';

const UNVERIFY_REASON = 'Uangnya ternyata tidak pernah masuk ke rekening komplek.';
const REFUND_REASON = 'Masa huninya berakhir dan saldo titipannya dikembalikan.';
const REVERSE_REASON = 'Pengembalian salah catat: uangnya tidak jadi diserahkan.';

/** PostgreSQL's `lock_not_available`, raised by a `nowait` lock that would have to wait. */
const LOCK_NOT_AVAILABLE = '55P03';

/** How long a lock test waits for the action to start waiting before it gives up. */
const WAIT_TIMEOUT_MILLISECONDS = 10_000;

/** How often it looks. */
const POLL_MILLISECONDS = 20;

/** The message the failure-injecting clock throws, so a test can tell its failure from a real one. */
const CLOCK_FAILURE = 'Injected clock failure, on purpose, from the Pembatalan verifikasi test.';

/**
 * A clock that works `failAt - 1` times and then throws once: the move `FailingClock` in
 * `tests/unit/payment-verification.test.ts` makes. Every write inside the action reads the clock,
 * and so does queueing the email after it, so walking `failAt` upward drives the failure through
 * every seam of the transaction and then into the email.
 */
class FailingClock implements Clock {
	#calls = 0;
	readonly #failAt: number;

	constructor(failAt: number) {
		this.#failAt = failAt;
	}

	now(): Date {
		this.#calls += 1;
		if (this.#calls === this.#failAt) {
			throw new Error(CLOCK_FAILURE);
		}
		return new Date(START);
	}
}

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

/** The backends waiting on a lock the backend `blockerPid` holds. */
async function backendsWaitingOn(blockerPid: number): Promise<readonly number[]> {
	const result = await testDb.db.execute<{ pid: number }>(
		sql`select activity.pid as pid from pg_stat_activity activity
			where ${blockerPid}::int = any(pg_blocking_pids(activity.pid))`
	);
	return result.rows.map((row) => row.pid);
}

/**
 * Waits until some backend is waiting on a lock the backend `blockerPid` holds, and answers it.
 * Polled, because PostgreSQL announces no event for a statement starting to wait.
 */
async function waitUntilWaitingOn(blockerPid: number): Promise<number> {
	const deadline = Date.now() + WAIT_TIMEOUT_MILLISECONDS;
	while (Date.now() < deadline) {
		const [waiting] = await backendsWaitingOn(blockerPid);
		if (waiting !== undefined) {
			return waiting;
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

/** A `residents` row for `userId`. Returns its id. */
async function insertResident(userId: string): Promise<string> {
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** The verifying admin: the role, and the `residents` row `payments.verifiedBy` needs. */
async function insertAdmin(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = await insertUserWithRole(name, ROLE.admin);
	return { userId, residentId: await insertResident(userId) };
}

/** One house. Returns its id. */
async function insertUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'UV', number: unique('1'), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One standing Tagihan, written directly as domain set-up. Returns its id. */
async function insertInvoice(unitId: string, period: string, amount: Rupiah): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({ unitId, period, amount, dueDate: `${period}-10`, issuedAt: new Date(START) })
		.returning();
	return row.id;
}

/** A pending Pembayaran, shaped exactly as #28 leaves one for verification. Returns its id. */
async function insertPendingPayment(
	unitId: string,
	recordedBy: string,
	amount: Rupiah,
	receivedOn: string = RECEIVED_ON
): Promise<string> {
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy,
			amount,
			receivedOn,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: `payments/${randomUUID()}/proof.jpg`,
			status: PAYMENT_STATUS.pending,
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** The address the email to `residentId` goes to. */
async function emailOfResident(residentId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ email: user.email })
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(residents.id, residentId));
	return row.email;
}

/** Every queued email of `kind` to `recipient`. Scoped, because the file shares one queue. */
async function emailsTo(recipient: string, kind: string) {
	return testDb.db
		.select()
		.from(emailQueue)
		.where(and(eq(emailQueue.recipient, recipient), eq(emailQueue.kind, kind)))
		.orderBy(asc(emailQueue.createdAt), asc(emailQueue.id));
}

/** The seeded system category "Iuran warga". */
async function duesCategoryId(): Promise<string> {
	const [row] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	return row.id;
}

async function paymentRow(paymentId: string) {
	const [row] = await testDb.db.select().from(payments).where(eq(payments.id, paymentId));
	return row;
}

async function allocationsOf(paymentId: string) {
	return testDb.db.select().from(allocations).where(eq(allocations.paymentId, paymentId));
}

/** Every Koreksi filed against `cashTransactionId`. */
async function correctionsOf(cashTransactionId: string) {
	return testDb.db
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.correctionOf, cashTransactionId));
}

/** The `payment_unverified` rows filed against `paymentId`. */
async function unverifiedRecordsOf(paymentId: string) {
	return (await auditEntriesFor(testDb.db, paymentId)).filter(
		(entry) => entry.action === PAYMENT_UNVERIFIED_ACTION
	);
}

/** The signed total of the given "Iuran warga" lines and every Koreksi of them. */
async function duesNetOf(lineIds: readonly string[]): Promise<number> {
	const categoryId = await duesCategoryId();
	const rows = await testDb.db
		.select()
		.from(cashTransactions)
		.where(
			and(
				eq(cashTransactions.categoryId, categoryId),
				or(
					inArray(cashTransactions.id, [...lineIds]),
					inArray(cashTransactions.correctionOf, [...lineIds])
				)
			)
		);
	return rows.reduce(
		(total, row) => total + (row.type === CASH_CATEGORY_TYPE.income ? row.amount : -row.amount),
		0
	);
}

/**
 * One house with a Rp400.000 Pembayaran verified through the real service: Rp250.000 of it paid the
 * October Tagihan, Rp150.000 is the Unit's Saldo Titipan.
 */
async function verifiedHouse(name: string, receivedOn: string = RECEIVED_ON) {
	const superuserId = await insertUserWithRole(`Pengurus ${name}`, ROLE.superuser);
	const admin = await insertAdmin(`Admin ${name}`);
	const payerUserId = await insertUser(`Warga ${name}`);
	const payerResidentId = await insertResident(payerUserId);
	const unitId = await insertUnit();
	const period = receivedOn.slice(0, 7);
	const invoiceId = await insertInvoice(unitId, period, rupiah(250_000));
	const paymentId = await insertPendingPayment(
		unitId,
		payerResidentId,
		rupiah(400_000),
		receivedOn
	);
	const verified = await verifyPayment(testDb.db, new FakeClock(START), {
		actorId: admin.userId,
		paymentId
	});
	expect(verified.allocations).toHaveLength(1);
	expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(150_000);
	return {
		superuserId,
		admin,
		payerName: `Warga ${name}`,
		payerResidentId,
		unitId,
		period,
		invoiceId,
		paymentId,
		cashTransactionId: verified.cashTransaction.id,
		allocationId: verified.allocations[0].id
	};
}

type House = Awaited<ReturnType<typeof verifiedHouse>>;

/** Asserts that `house` is exactly as `verifiedHouse` left it: nothing was written. */
async function expectUntouched(house: House): Promise<void> {
	const payment = await paymentRow(house.paymentId);
	expect(payment.status).toBe(PAYMENT_STATUS.verified);
	expect(payment.rejectionReason).toBeNull();
	expect(payment.verifiedBy).toBe(house.admin.residentId);
	expect((await allocationsOf(house.paymentId)).map((row) => row.id)).toEqual([house.allocationId]);
	expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);
	expect(await unverifiedRecordsOf(house.paymentId)).toHaveLength(0);
	expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(150_000);
}

async function unverify(house: House, reason: string = UNVERIFY_REASON, clock?: Clock) {
	return unverifyPayment(testDb.db, clock ?? new FakeClock(START), {
		actorId: house.superuserId,
		paymentId: house.paymentId,
		reason
	});
}

describe('the scenario spec #308 was grilled on', () => {
	// First in the file: it runs issuance, which bills every house that exists at that moment, and
	// no house a later test makes.
	it('refuses while the Pengembalian is in force, then succeeds once it is reversed, leaving every book balanced', async () => {
		// Rp600.000 pays October's Rp250.000 Tagihan on verification; November's issuance pays its
		// Tagihan out of the remaining Rp350.000; Rp100.000 of what is left is returned.
		const superuserId = await insertUserWithRole('Pengurus Skenario', ROLE.superuser);
		const admin = await insertAdmin('Admin Skenario');
		const payerResidentId = await insertResident(await insertUser('Warga Skenario'));
		const unitId = await insertUnit();
		await testDb.db
			.insert(duesRates)
			.values({ amount: rupiah(250_000), effectiveFrom: '2026-01-01', createdAt: new Date(START) });
		const clock = new FakeClock(START);

		await issueInvoicesForPeriod(testDb.db, clock, OCTOBER);
		const paymentId = await insertPendingPayment(unitId, payerResidentId, rupiah(600_000));
		const verified = await verifyPayment(testDb.db, clock, { actorId: admin.userId, paymentId });
		await issueInvoicesForPeriod(testDb.db, clock, '2026-11');
		const refunded = await refundCredit(testDb.db, clock, {
			actorId: superuserId,
			unitId,
			amount: rupiah(100_000),
			occurredOn: '2026-11-05',
			reason: REFUND_REASON
		});
		const [portion] = refunded.portions;

		const invoiceRows = await testDb.db
			.select()
			.from(invoices)
			.where(eq(invoices.unitId, unitId))
			.orderBy(asc(invoices.period));
		expect(invoiceRows.map((row) => row.period)).toEqual([OCTOBER, '2026-11']);
		const allocated = await allocationsOf(paymentId);
		// One Alokasi from the verification, one from the issuance.
		expect(allocated.map((row) => [row.invoiceId, row.amount]).sort()).toEqual(
			invoiceRows.map((row) => [row.id, 250_000]).sort()
		);
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);

		// While the Pengembalian is in force: refused, naming it, and nothing written.
		const refusal: unknown = await unverifyPayment(testDb.db, clock, {
			actorId: superuserId,
			paymentId,
			reason: UNVERIFY_REASON
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(UnverifyRefusedRefundedError);
		expect(refusal).toMatchObject({
			paymentId,
			refunds: [{ refundId: portion.refund.id, amount: 100_000, occurredOn: '2026-11-05' }]
		});
		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.verified);
		expect(await allocationsOf(paymentId)).toHaveLength(2);
		expect(await correctionsOf(verified.cashTransaction.id)).toHaveLength(0);

		// The Pengembalian reversed first, then the verification undone.
		await reverseRefund(testDb.db, clock, {
			actorId: superuserId,
			refundId: portion.refund.id,
			reason: REVERSE_REASON
		});
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(100_000);
		const outcome = await unverifyPayment(testDb.db, clock, {
			actorId: superuserId,
			paymentId,
			reason: UNVERIFY_REASON
		});

		// Both Tagihan are unpaid again, each with nothing allocated.
		expect(outcome.releasedAllocations).toHaveLength(2);
		const finance = await unitFinanceFor(testDb.db, clock, superuserId, unitId);
		expect(
			finance.invoices.map((invoice) => [invoice.period, invoice.allocatedAmount, invoice.status])
		).toEqual([
			// November's falls due on its tenth, so on 2026-11-12 both are past due: menunggak.
			['2026-11', 0, INVOICE_STATUS.overdue],
			[OCTOBER, 0, INVOICE_STATUS.overdue]
		]);
		expect(finance.verifiedPayments).toEqual([]);

		// The Saldo Titipan is right: no verified money, nothing allocated, no Pengembalian in force.
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);
		expect(finance.creditBalance).toBe(0);

		// The buku kas balances: the income line and its Koreksi, the Pengembalian's expense and its
		// Koreksi, all in "Iuran warga", net to the Unit's verified money less its Pengembalian in
		// force, which is now nothing.
		expect(await duesNetOf([verified.cashTransaction.id, portion.cashTransaction.id])).toBe(0);
		expect(await correctionsOf(verified.cashTransaction.id)).toEqual([outcome.correction]);
	});
});

describe('unverifyPayment', () => {
	it('rejects the Pembayaran with the reason, releases its Alokasi and reverses its income line on its own day', async () => {
		const house = await verifiedHouse('Pembatalan Utama');

		const outcome = await unverify(house, `  ${UNVERIFY_REASON}  `);

		// The row: rejected, the trimmed reason its rejection reason, the verifier and instant cleared.
		const payment = await paymentRow(house.paymentId);
		expect(payment).toMatchObject({
			status: PAYMENT_STATUS.rejected,
			rejectionReason: UNVERIFY_REASON,
			verifiedBy: null,
			verifiedAt: null
		});
		expect(outcome.payment).toEqual(payment);
		expect(outcome.unitId).toBe(house.unitId);

		// Every Alokasi gone, the Tagihan unpaid again, and the Saldo Titipan of nothing verified is 0.
		expect(await allocationsOf(house.paymentId)).toEqual([]);
		expect(outcome.releasedAllocations.map((row) => row.id)).toEqual([house.allocationId]);
		const finance = await unitFinanceFor(
			testDb.db,
			new FakeClock(START),
			house.superuserId,
			house.unitId
		);
		expect(finance.invoices).toEqual([
			expect.objectContaining({
				invoiceId: house.invoiceId,
				allocatedAmount: 0,
				remainingAmount: 250_000,
				allocations: []
			})
		]);
		expect(finance.invoices[0].status).not.toBe(INVOICE_STATUS.paid);
		expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(0);

		// One Koreksi: expense, the same amount, day and category as the income line, pointing at it.
		expect(outcome.correction).toMatchObject({
			occurredOn: RECEIVED_ON,
			type: CASH_CATEGORY_TYPE.expense,
			categoryId: await duesCategoryId(),
			amount: 400_000,
			description: UNVERIFY_REASON,
			recordedBy: house.superuserId,
			attachmentKey: null,
			correctionOf: house.cashTransactionId
		});
		expect(await correctionsOf(house.cashTransactionId)).toEqual([outcome.correction]);
		expect(await duesNetOf([house.cashTransactionId])).toBe(0);
	});

	it('records exactly one typed audit row, filed against the Pembayaran, that the history shows', async () => {
		const house = await verifiedHouse('Pembatalan Catatan');
		const clock = new FakeClock(START);
		clock.advance(60_000);

		const outcome = await unverify(house, `  ${UNVERIFY_REASON}  `, clock);

		const records = await unverifiedRecordsOf(house.paymentId);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ actorId: house.superuserId });
		expect(readDuesCorrectionRecord(records[0])).toEqual({
			action: PAYMENT_UNVERIFIED_ACTION,
			targetId: house.paymentId,
			before: {
				status: PAYMENT_STATUS.verified,
				verifiedBy: house.admin.residentId,
				verifiedAt: START
			},
			after: {
				unitId: house.unitId,
				reason: UNVERIFY_REASON,
				status: PAYMENT_STATUS.rejected,
				amount: rupiah(400_000),
				receivedOn: RECEIVED_ON,
				cashTransactionId: house.cashTransactionId,
				correctionId: outcome.correction.id,
				allocations: [
					{
						allocationId: house.allocationId,
						invoiceId: house.invoiceId,
						amount: rupiah(250_000),
						createdAt: START
					}
				]
			}
		} satisfies PaymentUnverifiedRecord);

		const history = await correctionsHistoryFor(testDb.db, house.superuserId, house.unitId);
		expect(
			history.map((entry) => [entry.action, entry.amount, entry.period, entry.reason])
		).toEqual([[PAYMENT_UNVERIFIED_ACTION, 400_000, null, UNVERIFY_REASON]]);
		expect(history[0].id).toBe(records[0].id);
	});

	it('lists the verified Pembayaran on the finance screen model, and no longer once it is unverified', async () => {
		const house = await verifiedHouse('Pembatalan Layar');
		const clock = new FakeClock(START);

		const before = await unitFinanceFor(testDb.db, clock, house.superuserId, house.unitId);
		expect(before.verifiedPayments).toEqual([
			{
				paymentId: house.paymentId,
				amount: 400_000,
				receivedOn: RECEIVED_ON,
				method: PAYMENT_METHOD.transfer,
				recordedByName: house.payerName,
				allocations: [
					{
						allocationId: house.allocationId,
						invoiceId: house.invoiceId,
						period: house.period,
						amount: 250_000
					}
				]
			}
		]);

		await unverify(house);

		const after = await unitFinanceFor(testDb.db, clock, house.superuserId, house.unitId);
		expect(after.verifiedPayments).toEqual([]);
	});

	it('undoes a Pembayaran that was all Saldo Titipan, releasing nothing', async () => {
		const superuserId = await insertUserWithRole('Pengurus Tanpa Alokasi', ROLE.superuser);
		const admin = await insertAdmin('Admin Tanpa Alokasi');
		const payerResidentId = await insertResident(await insertUser('Warga Tanpa Alokasi'));
		const unitId = await insertUnit();
		const paymentId = await insertPendingPayment(unitId, payerResidentId, rupiah(170_000));
		await verifyPayment(testDb.db, new FakeClock(START), { actorId: admin.userId, paymentId });
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(170_000);

		const outcome = await unverifyPayment(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			paymentId,
			reason: UNVERIFY_REASON
		});

		expect(outcome.releasedAllocations).toEqual([]);
		expect(outcome.correction.amount).toBe(170_000);
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);
		const [record] = await unverifiedRecordsOf(paymentId);
		expect(readDuesCorrectionRecord(record)).toMatchObject({ after: { allocations: [] } });
	});

	it('stays undone: the Pembayaran is never verified again, and its Koreksi cannot be taken back', async () => {
		const house = await verifiedHouse('Pembatalan Permanen');
		const outcome = await unverify(house);

		// Spec #308: a rejected Pembayaran is not verified again; the Warga records a new one.
		const again: unknown = await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: house.admin.userId,
			paymentId: house.paymentId
		}).catch((error: unknown) => error);
		expect(again).toBeInstanceOf(VerificationRuleError);
		expect(again).toMatchObject({ rule: VERIFICATION_RULE.alreadyDecided });

		// The Koreksi is a line in "Iuran warga", which the ordinary Koreksi refuses (#323).
		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: house.admin.userId,
				transactionId: outcome.correction.id,
				reason: 'Mengembalikan pemasukan.'
			})
		).rejects.toThrow(CashCorrectionTargetError);
		expect(await correctionsOf(outcome.correction.id)).toHaveLength(0);
	});

	it('refuses a Pembayaran still pending, and writes nothing', async () => {
		const superuserId = await insertUserWithRole('Pengurus Masih Menunggu', ROLE.superuser);
		const payerResidentId = await insertResident(await insertUser('Warga Masih Menunggu'));
		const unitId = await insertUnit();
		const paymentId = await insertPendingPayment(unitId, payerResidentId, rupiah(100_000));

		const refusal: unknown = await unverifyPayment(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			paymentId,
			reason: UNVERIFY_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(UnverifyRuleError);
		expect(refusal).toMatchObject({ rule: UNVERIFY_RULE.notVerified });
		expect(await paymentRow(paymentId)).toMatchObject({
			status: PAYMENT_STATUS.pending,
			rejectionReason: null
		});
		expect(await unverifiedRecordsOf(paymentId)).toHaveLength(0);
	});

	it('refuses a second undo of the same Pembayaran by name, and writes and sends nothing more', async () => {
		const house = await verifiedHouse('Pembatalan Dua Kali');
		await unverify(house);
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await unverify(house, 'Sekali lagi.').catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(UnverifyRuleError);
		expect(refusal).toMatchObject({ rule: UNVERIFY_RULE.notVerified });
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect(await unverifiedRecordsOf(house.paymentId)).toHaveLength(1);
		expect((await paymentRow(house.paymentId)).rejectionReason).toBe(UNVERIFY_REASON);
		const recipient = await emailOfResident(house.payerResidentId);
		expect(await emailsTo(recipient, PAYMENT_REJECTED_KIND)).toHaveLength(1);
	});

	it('refuses a Pembayaran whose income line falls in a locked Periode, naming the month, and writes nothing', async () => {
		// September, so no other test in this file is reached by the lock.
		const house = await verifiedHouse('Pembatalan Terkunci', '2026-09-20');
		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId: house.superuserId,
				year: 2026,
				month: 9,
				reason: 'Laporan bulan itu sudah terbit.'
			})
		);
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await unverify(house).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PeriodLockedError);
		expect(refusal).toMatchObject({ period: '2026-09', occurredOn: '2026-09-20' });
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		await expectUntouched(house);
		const recipient = await emailOfResident(house.payerResidentId);
		expect(await emailsTo(recipient, PAYMENT_REJECTED_KIND)).toHaveLength(0);
	});

	it('refuses an admin who is not a superuser, and a resident, and writes nothing', async () => {
		const house = await verifiedHouse('Pembatalan Hak');
		const residentId = await insertUser('Warga Biasa Pembatalan');

		for (const actorId of [house.admin.userId, residentId]) {
			await expect(
				unverifyPayment(testDb.db, new FakeClock(START), {
					actorId,
					paymentId: house.paymentId,
					reason: UNVERIFY_REASON
				})
			).rejects.toThrow(PermissionDeniedError);
		}

		await expectUntouched(house);
	});

	it('refuses an empty reason by its own rule', async () => {
		const house = await verifiedHouse('Pembatalan Tanpa Alasan');

		const refusal: unknown = await unverify(house, ' \t ').catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(UnverifyRuleError);
		expect(refusal).toMatchObject({ rule: UNVERIFY_RULE.reasonMissing });
		await expectUntouched(house);
	});

	it('refuses a Pembayaran that does not exist', async () => {
		const superuserId = await insertUserWithRole('Pengurus Pembayaran Hantu', ROLE.superuser);

		await expect(
			unverifyPayment(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				paymentId: randomUUID(),
				reason: UNVERIFY_REASON
			})
		).rejects.toThrow(PaymentNotFoundError);
	});

	it('refuses a Pembayaran whose income line already carries a Koreksi from before #323, and writes nothing', async () => {
		// Before #323 an Admin's ordinary Koreksi could reverse a dues income line; it no longer can, so
		// that Koreksi is written straight in, the way the shared-run table in
		// `tests/unit/dues-correction.test.ts` arranges a Pengembalian. The writer refuses a second
		// Koreksi of one line, and the whole undo rolls back with it: the Alokasi it had already
		// deleted are back. The finance route answers this class with `unverifyPayment_cashLineCorrected`.
		const house = await verifiedHouse('Pembatalan Koreksi Lama');
		const [oldKoreksi] = await testDb.db
			.insert(cashTransactions)
			.values({
				id: randomUUID(),
				occurredOn: RECEIVED_ON,
				type: CASH_CATEGORY_TYPE.expense,
				categoryId: await duesCategoryId(),
				amount: rupiah(400_000),
				description: 'Koreksi Admin sebelum #323.',
				attachmentKey: null,
				recordedBy: house.admin.userId,
				correctionOf: house.cashTransactionId,
				createdAt: new Date(START)
			})
			.returning();
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await unverify(house).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(CashTransactionAlreadyCorrectedError);
		expect(refusal).toMatchObject({
			transactionId: house.cashTransactionId,
			correctionId: oldKoreksi.id
		});
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		const payment = await paymentRow(house.paymentId);
		expect(payment).toMatchObject({
			status: PAYMENT_STATUS.verified,
			rejectionReason: null,
			verifiedBy: house.admin.residentId
		});
		expect((await allocationsOf(house.paymentId)).map((row) => row.id)).toEqual([
			house.allocationId
		]);
		expect(await unverifiedRecordsOf(house.paymentId)).toHaveLength(0);
		const recipient = await emailOfResident(house.payerResidentId);
		expect(await emailsTo(recipient, PAYMENT_REJECTED_KIND)).toHaveLength(0);
	});

	it('refuses a verified Pembayaran with no verification record, rather than guess its cash line, and writes nothing', async () => {
		// Written straight into `payments` as verified, with an Alokasi, and no `payment_verified`
		// record: the one shape here that does not come from the real verification.
		const superuserId = await insertUserWithRole('Pengurus Tanpa Catatan', ROLE.superuser);
		const residentId = await insertResident(await insertUser('Warga Tanpa Catatan'));
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId, OCTOBER, rupiah(100_000));
		const [payment] = await testDb.db
			.insert(payments)
			.values({
				unitId,
				recordedBy: residentId,
				amount: rupiah(100_000),
				receivedOn: RECEIVED_ON,
				method: PAYMENT_METHOD.cash,
				proofFileKey: null,
				status: PAYMENT_STATUS.verified,
				verifiedBy: residentId,
				verifiedAt: new Date(START),
				createdAt: new Date(START)
			})
			.returning();
		await testDb.db.insert(allocations).values({
			paymentId: payment.id,
			invoiceId,
			amount: rupiah(100_000),
			createdAt: new Date(START)
		});
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await unverifyPayment(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			paymentId: payment.id,
			reason: UNVERIFY_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(UnverifyRuleError);
		expect(refusal).toMatchObject({ rule: UNVERIFY_RULE.verificationRecordMissing });
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect((await paymentRow(payment.id)).status).toBe(PAYMENT_STATUS.verified);
		// The Alokasi deleted earlier in the transaction is back: the refusal rolled it all back.
		expect(await allocationsOf(payment.id)).toHaveLength(1);
		expect(await unverifiedRecordsOf(payment.id)).toHaveLength(0);
	});
});

describe('the payment-rejected email of a Pembatalan verifikasi', () => {
	it('is queued once, to the recorder, naming the reason, after the change is saved', async () => {
		const house = await verifiedHouse('Pembatalan Email');

		await unverify(house);

		const recipient = await emailOfResident(house.payerResidentId);
		const rows = await emailsTo(recipient, PAYMENT_REJECTED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: PAYMENT_REJECTED_KIND,
			payload: { amount: 400_000, reason: UNVERIFY_REASON, locale: 'id' }
		});
		// Never to the superuser who undid it, nor to the admin who verified it.
		expect(
			await emailsTo(await emailOfResident(house.admin.residentId), PAYMENT_REJECTED_KIND)
		).toEqual([]);
	});

	it('rolls back whole wherever a failure lands inside, and a failure in the email fails nothing', async () => {
		// Failing the clock's n-th read in turn walks a failure through every seam of the transaction
		// (the Koreksi, the Periode, the audit row), each of which must leave the house untouched, and
		// then, once n is past the transaction, into the email queued after the commit. That attempt
		// must resolve: the correction committed, no email queued, the failure logged.
		const house = await verifiedHouse('Pembatalan Email Gagal');
		const recipient = await emailOfResident(house.payerResidentId);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const logged: string[] = [];

		let failuresInside = 0;
		let resolved = false;
		try {
			// More attempts than the transaction has clock reads, so the loop always reaches success.
			for (let failAt = 1; failAt <= 20 && !resolved; failAt += 1) {
				try {
					await unverify(house, UNVERIFY_REASON, new FailingClock(failAt));
					resolved = true;
				} catch (caught) {
					expect((caught as Error).message).toBe(CLOCK_FAILURE);
					failuresInside += 1;
					await expectUntouched(house);
				}
			}
		} finally {
			logged.push(...error.mock.calls.map((call: unknown[]) => String(call[0])));
			error.mockRestore();
		}

		expect(failuresInside).toBeGreaterThan(0);
		expect(resolved).toBe(true);
		// The first attempt that resolved is the one whose failure landed after the commit.
		expect((await paymentRow(house.paymentId)).status).toBe(PAYMENT_STATUS.rejected);
		expect(await correctionsOf(house.cashTransactionId)).toHaveLength(1);
		expect(await emailsTo(recipient, PAYMENT_REJECTED_KIND)).toEqual([]);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain(PAYMENT_REJECTED_KIND);
		expect(logged[0]).toContain(house.paymentId);
	});
});

describe('the locks of a Pembatalan verifikasi', () => {
	it('waits for the Pembayaran, then reads the Pengembalian in force under its lock and refuses', async () => {
		// The second connection holds the Pembayaran `for no key update`, which conflicts with the
		// action's `for update`. While the action waits there, the holder writes a Pengembalian of the
		// payment's remainder (the shape of a refund that won the lock) and commits. The action must
		// then see it and refuse by name: the Pengembalian are read after the lock, not before it.
		const house = await verifiedHouse('Pembatalan Balapan Pengembalian');
		const categoryId = await duesCategoryId();
		const refundId = randomUUID();

		const holder = await connectToSchema();
		try {
			await holder.client.query('begin');
			await holder.client.query('select id from payments where id = $1 for no key update', [
				house.paymentId
			]);

			const attempt = unverify(house).catch((error: unknown) => error);
			await waitUntilWaitingOn(holder.pid);

			// Still waiting: it has written nothing.
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);
			expect(await allocationsOf(house.paymentId)).toHaveLength(1);

			const lineId = randomUUID();
			await holder.client.query(
				`insert into cash_transactions
					(id, occurred_on, type, category_id, amount, description, attachment_key, recorded_by, correction_of, created_at)
				values ($1, '2026-11-05', 'expense', $2, 100000, 'Pengembalian yang menang.', null, $3, null, $4)`,
				[lineId, categoryId, house.superuserId, START]
			);
			await holder.client.query(
				`insert into refunds (id, payment_id, cash_transaction_id, amount, reason, refunded_by, created_at)
				values ($1, $2, $3, 100000, 'Pengembalian yang menang.', $4, $5)`,
				[refundId, house.paymentId, lineId, house.superuserId, START]
			);
			await holder.client.query('commit');

			const refusal = await attempt;
			expect(refusal).toBeInstanceOf(UnverifyRefusedRefundedError);
			expect(refusal).toMatchObject({
				refunds: [{ refundId, amount: 100_000, occurredOn: '2026-11-05' }]
			});
			expect((await paymentRow(house.paymentId)).status).toBe(PAYMENT_STATUS.verified);
			expect(await allocationsOf(house.paymentId)).toHaveLength(1);
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);
		} finally {
			await holder.release();
		}
	});

	it('holds the Pembayaran while it waits for the Tagihan: the payment first, the invoice second', async () => {
		const house = await verifiedHouse('Pembatalan Urutan Tagihan');

		const holder = await connectToSchema();
		const prober = await connectToSchema();
		try {
			await holder.client.query('begin');
			await holder.client.query('select id from invoices where id = $1 for no key update', [
				house.invoiceId
			]);

			const attempt = unverify(house).catch((error: unknown) => error);
			await waitUntilWaitingOn(holder.pid);

			await expect(
				prober.client.query('select id from payments where id = $1 for update nowait', [
					house.paymentId
				])
			).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
			expect(await allocationsOf(house.paymentId)).toHaveLength(1);
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);

			await holder.client.query('rollback');
			const outcome = await attempt;

			expect(outcome).not.toBeInstanceOf(Error);
			expect(await allocationsOf(house.paymentId)).toEqual([]);
			expect((await paymentRow(house.paymentId)).status).toBe(PAYMENT_STATUS.rejected);
		} finally {
			await holder.release();
			await prober.release();
		}
	});

	it('holds the Pembayaran and the Tagihan while it waits for the cash line, then commits', async () => {
		const house = await verifiedHouse('Pembatalan Urutan Kas');

		const holder = await connectToSchema();
		const prober = await connectToSchema();
		try {
			await holder.client.query('begin');
			await holder.client.query(
				'select id from cash_transactions where id = $1 for no key update',
				[house.cashTransactionId]
			);

			const attempt = unverify(house).catch((error: unknown) => error);
			await waitUntilWaitingOn(holder.pid);

			await expect(
				prober.client.query('select id from payments where id = $1 for update nowait', [
					house.paymentId
				])
			).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
			await expect(
				prober.client.query('select id from invoices where id = $1 for update nowait', [
					house.invoiceId
				])
			).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(0);

			await holder.client.query('rollback');
			const outcome = await attempt;

			expect(outcome).not.toBeInstanceOf(Error);
			expect(await correctionsOf(house.cashTransactionId)).toHaveLength(1);
		} finally {
			await holder.release();
			await prober.release();
		}
	});

	it('makes a Pengembalian that waited behind it find the money gone, never pay it out', async () => {
		// The direction the refusal above cannot cover: the Pembatalan verifikasi holds the
		// Pembayaran (kept waiting on the cash line by the holder) while a real Pengembalian of the
		// Unit's balance arrives and waits behind it. Once the undo commits, the Pengembalian's locking
		// read re-checks `status = 'verified'` on the committed row, no longer sees the Pembayaran, and
		// finds no balance to return: refused, not paid out of money that is no longer verified.
		const house = await verifiedHouse('Pembatalan Balapan Spender');

		const holder = await connectToSchema();
		try {
			await holder.client.query('begin');
			await holder.client.query(
				'select id from cash_transactions where id = $1 for no key update',
				[house.cashTransactionId]
			);

			const attempt = unverify(house).catch((error: unknown) => error);
			const undoPid = await waitUntilWaitingOn(holder.pid);

			const refund = refundCredit(testDb.db, new FakeClock(START), {
				actorId: house.superuserId,
				unitId: house.unitId,
				amount: rupiah(150_000),
				occurredOn: '2026-11-05',
				reason: REFUND_REASON
			}).catch((error: unknown) => error);
			await waitUntilWaitingOn(undoPid);

			await holder.client.query('rollback');
			expect(await attempt).not.toBeInstanceOf(Error);

			const refusal = await refund;
			expect(refusal).toBeInstanceOf(RefundRuleError);
			expect(refusal).toMatchObject({ rule: REFUND_RULE.amountAboveBalance });
			expect(await creditBalanceOfUnit(testDb.db, house.unitId)).toBe(0);
		} finally {
			await holder.release();
		}
	});
});
