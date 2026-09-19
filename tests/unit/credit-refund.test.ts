import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY
} from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { duesRates } from '$lib/server/db/schema/dues-rate';
import { invoices } from '$lib/server/db/schema/invoice';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { refunds } from '$lib/server/db/schema/refund';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { lockPeriod } from '$lib/server/services/cash/period';
import { PeriodLockedError } from '$lib/server/services/cash/period';
import { lockUnallocatedVerifiedPayments } from '$lib/server/services/dues/credit-balance';
import { creditBalanceOfUnit } from '$lib/server/services/dues/credit-balance';
import {
	CREDIT_REFUNDED_ACTION,
	REFUND_RULE,
	RefundRuleError,
	refundCredit
} from '$lib/server/services/dues/credit-refund';
import { issueInvoicesForPeriod } from '$lib/server/services/dues/issuance';
import { UnitNotFoundError } from '$lib/server/services/dues/queries';

/**
 * Pengembalian — user story 23 of `docs/spec-iuran-v1.md`, and #30's third correction: part or
 * all of a Unit's saldo titipan returned as money out of the kas, attributed per Pembayaran so
 * that nothing can spend the returned rupiah a second time. Against a real PostgreSQL with a fake
 * clock, because every rule here is about committed rows and dated money.
 *
 * The two invariants this file pins, beyond the named refusals:
 *
 * - **Refunded money is money the next issuance cannot spend.** The refund lands in the same
 *   per-payment remainders `lockUnallocatedVerifiedPayments` hands to issuance's credit
 *   application, so the follow-up Tagihan stays unpaid — asserted end to end through the real
 *   `issueInvoicesForPeriod`.
 * - **Two spenders of one balance serialise on the payment row locks.** A refund racing a
 *   spender that already holds the locks waits, re-reads committed state, and is refused by name
 *   rather than doubled — asserted with a second connection holding an uncommitted claim.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. Its UTC day is 2026-03-10. */
const START = '2026-03-10T09:00:00.000Z';

/** The day the refunded money in this file was handed back. */
const REFUND_DAY = '2026-03-08';

const REFUND_REASON = 'Masa huninya berakhir dan saldo titipannya dikembalikan.';

/** Makes every house and every email in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
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

/** The superuser who returns money. No `residents` row: `refundedBy` references `user.id`. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** One house. Returns its id, block and number. */
async function insertUnit(): Promise<{ id: string; block: string; number: string }> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'CR', number: unique('1'), createdAt: new Date(START) })
		.returning();
	return { id: row.id, block: row.block, number: row.number };
}

/** One verified Pembayaran of `amount`, received on `receivedOn`. Returns its id. */
async function insertVerifiedPayment(
	unitId: string,
	amount: Rupiah,
	receivedOn: string = '2026-03-03'
): Promise<string> {
	const userId = await insertUser('Warga Pengembalian');
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

/** One standing Tagihan of `amount` for `period`. Returns its id. */
async function insertInvoice(unitId: string, amount: Rupiah, period: string): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({ unitId, period, amount, dueDate: `${period}-05`, issuedAt: new Date(START) })
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

/** Every refund row of `unitId`'s payments, oldest cash first. */
async function refundRowsOf(unitId: string) {
	const paymentRows = await testDb.db
		.select({ id: payments.id })
		.from(payments)
		.where(eq(payments.unitId, unitId));
	if (paymentRows.length === 0) {
		return [];
	}
	return testDb.db
		.select()
		.from(refunds)
		.where(
			inArray(
				refunds.paymentId,
				paymentRows.map((row) => row.id)
			)
		)
		.orderBy(asc(refunds.createdAt), asc(refunds.id));
}

describe('refundCredit', () => {
	it('drains the oldest money first, one cash expense and one refunds row per payment', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Penuh');
		const unit = await insertUnit();
		// Two verified payments: the older one partly allocated, the newer untouched.
		const older = await insertVerifiedPayment(unit.id, rupiah(300_000), '2026-03-01');
		const newer = await insertVerifiedPayment(unit.id, rupiah(150_000), '2026-03-05');
		const invoiceId = await insertInvoice(unit.id, rupiah(100_000), '2026-03');
		await testDb.db
			.insert(allocations)
			.values({ paymentId: older, invoiceId, amount: rupiah(100_000), createdAt: new Date(START) });
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(350_000);

		const outcome = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(350_000),
			occurredOn: REFUND_DAY,
			reason: REFUND_REASON
		});

		// Oldest money first: the older payment's remainder (200.000) before the newer's (150.000).
		expect(outcome.amount).toBe(350_000);
		expect(
			outcome.portions.map((portion) => ({
				paymentId: portion.refund.paymentId,
				amount: portion.refund.amount
			}))
		).toEqual([
			{ paymentId: older, amount: 200_000 },
			{ paymentId: newer, amount: 150_000 }
		]);

		// Each portion is one cash expense row in the system category "Iuran warga", 1:1 with its
		// refunds row, dated on the day the money was handed back, opposing the category's income
		// type, and never a Koreksi.
		const categoryId = await duesCategoryId();
		for (const portion of outcome.portions) {
			expect(portion.refund.cashTransactionId).toBe(portion.cashTransaction.id);
			expect(portion.refund.amount).toBe(portion.cashTransaction.amount);
			expect(portion.cashTransaction).toMatchObject({
				occurredOn: REFUND_DAY,
				type: CASH_CATEGORY_TYPE.expense,
				categoryId,
				recordedBy: actorId,
				attachmentKey: null,
				correctionOf: null
			});
			expect(portion.cashTransaction.description).toContain(`Blok ${unit.block} No ${unit.number}`);
			expect(portion.cashTransaction.description).toContain(portion.refund.paymentId);
		}

		// Every refunded rupiah left the balance and the per-payment remainders in the same stroke.
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(0);
		const remainders = await testDb.db.transaction(async (transaction) =>
			lockUnallocatedVerifiedPayments(transaction, unit.id)
		);
		expect(remainders.map((row) => row.remainder)).toEqual([0, 0]);
	});

	it('returns part of the balance, splitting across payments only as far as the money goes', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Sebagian');
		const unit = await insertUnit();
		const older = await insertVerifiedPayment(unit.id, rupiah(100_000), '2026-03-01');
		const newer = await insertVerifiedPayment(unit.id, rupiah(100_000), '2026-03-05');

		const outcome = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(130_000),
			occurredOn: REFUND_DAY,
			reason: REFUND_REASON
		});

		expect(
			outcome.portions.map((portion) => ({
				paymentId: portion.refund.paymentId,
				amount: portion.refund.amount
			}))
		).toEqual([
			{ paymentId: older, amount: 100_000 },
			{ paymentId: newer, amount: 30_000 }
		]);
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(70_000);
		const remainders = await testDb.db.transaction(async (transaction) =>
			lockUnallocatedVerifiedPayments(transaction, unit.id)
		);
		expect(remainders).toEqual([
			expect.objectContaining({ paymentId: older, remainder: 0 }),
			expect.objectContaining({ paymentId: newer, remainder: 70_000 })
		]);
	});

	it('records exactly one audit row, filed against the Unit, with the reason and every portion', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Audit');
		const unit = await insertUnit();
		const paymentId = await insertVerifiedPayment(unit.id, rupiah(150_000));

		const outcome = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(150_000),
			occurredOn: REFUND_DAY,
			reason: `  ${REFUND_REASON}  `
		});

		const entries = await auditEntriesFor(testDb.db, unit.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId,
			action: CREDIT_REFUNDED_ACTION,
			targetId: unit.id,
			after: {
				unitId: unit.id,
				amount: 150_000,
				occurredOn: REFUND_DAY,
				reason: REFUND_REASON,
				refunds: [
					{
						paymentId,
						cashTransactionId: outcome.portions[0].cashTransaction.id,
						amount: 150_000
					}
				]
			}
		});

		// One decision, one row: the cash rows carry no audit entries of their own.
		for (const portion of outcome.portions) {
			expect(await auditEntriesFor(testDb.db, portion.cashTransaction.id)).toHaveLength(0);
		}
	});

	it('is money the next issuance cannot spend — the refunded rupiah never come back', async () => {
		// The invariant the ticket exists for. Rp300.000 verified, Rp100.000 allocated, the
		// remaining Rp200.000 refunded: the next month's Tagihan must be issued unpaid, because the
		// remainders issuance drains already exclude the refunded money.
		const actorId = await insertSuperuser('Pengurus Pengembalian Terbit');
		const unit = await insertUnit();
		const paymentId = await insertVerifiedPayment(unit.id, rupiah(300_000));
		const invoiceId = await insertInvoice(unit.id, rupiah(100_000), '2026-03');
		await testDb.db.insert(allocations).values({
			paymentId,
			invoiceId,
			amount: rupiah(100_000),
			createdAt: new Date(START)
		});
		await testDb.db
			.insert(duesRates)
			.values({ amount: rupiah(150_000), effectiveFrom: '2026-01-01', createdAt: new Date(START) });

		await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(200_000),
			occurredOn: REFUND_DAY,
			reason: REFUND_REASON
		});
		await issueInvoicesForPeriod(testDb.db, new FakeClock(START), '2026-04');

		// The new Tagihan exists and absorbed nothing: no allocation was written onto it.
		const [issued] = await testDb.db
			.select()
			.from(invoices)
			.where(eq(invoices.unitId, unit.id))
			.then((rows) => rows.filter((row) => row.period === '2026-04'));
		expect(issued).toBeDefined();
		expect(
			await testDb.db.select().from(allocations).where(eq(allocations.invoiceId, issued.id))
		).toHaveLength(0);

		// And the payment was never spent past its amount: allocations plus refunds equal it.
		const allocationRows = await testDb.db
			.select()
			.from(allocations)
			.where(eq(allocations.paymentId, paymentId));
		const refundRows = await testDb.db
			.select()
			.from(refunds)
			.where(eq(refunds.paymentId, paymentId));
		const spent =
			allocationRows.reduce((total, row) => total + row.amount, 0) +
			refundRows.reduce((total, row) => total + row.amount, 0);
		expect(spent).toBe(300_000);
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(0);
	});

	it('refuses more than the balance, by name, and writes nothing', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Berlebih');
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));
		const cashBefore = await testDb.db.select().from(cashTransactions);

		const refusal: unknown = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(100_001),
			occurredOn: REFUND_DAY,
			reason: REFUND_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RefundRuleError);
		expect(refusal).toMatchObject({ rule: REFUND_RULE.amountAboveBalance });
		expect(await refundRowsOf(unit.id)).toHaveLength(0);
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect(await auditEntriesFor(testDb.db, unit.id)).toHaveLength(0);
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(100_000);
	});

	it.each([
		{ what: 'a zero amount', amount: rupiah(0), rule: REFUND_RULE.amountNotPositive },
		{ what: 'a negative amount', amount: rupiah(-1), rule: REFUND_RULE.amountNotPositive }
	])('refuses $what', async ({ amount, rule }) => {
		const actorId = await insertSuperuser(`Pengurus Pengembalian ${amount}`);
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));

		const refusal: unknown = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount,
			occurredOn: REFUND_DAY,
			reason: REFUND_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RefundRuleError);
		expect(refusal).toMatchObject({ rule });
	});

	it.each(['8 Maret 2026', '2026-02-31'])('refuses %s as a day', async (occurredOn) => {
		const actorId = await insertSuperuser(`Pengurus Pengembalian ${occurredOn}`);
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));

		const refusal: unknown = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(50_000),
			occurredOn,
			reason: REFUND_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RefundRuleError);
		expect(refusal).toMatchObject({ rule: REFUND_RULE.notACalendarDay });
	});

	it('refuses a day that has not arrived — money cannot already have been handed back', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Masa Depan');
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));

		const refusal: unknown = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(50_000),
			occurredOn: '2026-03-12',
			reason: REFUND_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RefundRuleError);
		expect(refusal).toMatchObject({ rule: REFUND_RULE.dayInTheFuture });
	});

	it('refuses an empty reason — pengembalian mencatat alasannya', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Tanpa Alasan');
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));

		const refusal: unknown = await refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(50_000),
			occurredOn: REFUND_DAY,
			reason: '   '
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RefundRuleError);
		expect(refusal).toMatchObject({ rule: REFUND_RULE.reasonMissing });
	});

	it('refuses a unit that does not exist', async () => {
		const actorId = await insertSuperuser('Pengurus Pengembalian Rumah Hantu');

		await expect(
			refundCredit(testDb.db, new FakeClock(START), {
				actorId,
				unitId: randomUUID(),
				amount: rupiah(50_000),
				occurredOn: REFUND_DAY,
				reason: REFUND_REASON
			})
		).rejects.toThrow(UnitNotFoundError);
	});

	it('refuses a day inside a locked Periode by name, and writes nothing', async () => {
		// The refund writes money, so it asks the Periode — after the payment locks, the fixed
		// order. February is used so no other test in this file is reached by the lock.
		const actorId = await insertSuperuser('Pengurus Pengembalian Terkunci');
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));
		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId,
				year: 2026,
				month: 2,
				reason: 'Laporan bulan itu sudah terbit.'
			})
		);
		const cashBefore = await testDb.db.select().from(cashTransactions);

		await expect(
			refundCredit(testDb.db, new FakeClock(START), {
				actorId,
				unitId: unit.id,
				amount: rupiah(50_000),
				occurredOn: '2026-02-15',
				reason: REFUND_REASON
			})
		).rejects.toThrow(PeriodLockedError);

		expect(await refundRowsOf(unit.id)).toHaveLength(0);
		expect(await testDb.db.select().from(cashTransactions)).toEqual(cashBefore);
		expect(await auditEntriesFor(testDb.db, unit.id)).toHaveLength(0);
	});

	it('refuses an admin who is not a superuser, and a resident, and writes nothing', async () => {
		const adminId = await insertUserWithRole('Pengurus Harian Pengembalian', ROLE.admin);
		const residentId = await insertUser('Warga Biasa Pengembalian');
		const unit = await insertUnit();
		await insertVerifiedPayment(unit.id, rupiah(100_000));

		for (const actorId of [adminId, residentId]) {
			await expect(
				refundCredit(testDb.db, new FakeClock(START), {
					actorId,
					unitId: unit.id,
					amount: rupiah(50_000),
					occurredOn: REFUND_DAY,
					reason: REFUND_REASON
				})
			).rejects.toThrow(PermissionDeniedError);
		}

		expect(await refundRowsOf(unit.id)).toHaveLength(0);
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(100_000);
	});

	it('serialises against a concurrent spender holding the payment locks, and is refused, never doubled', async () => {
		// The interleaving the module's doc comment promises: a spender — the shape of issuance's
		// credit application — takes the same `for update` locks first and spends the whole balance
		// without committing. The refund, started only after those locks are held, must wait, read
		// the winner's committed rows in fresh statements, and refuse by name.
		const actorId = await insertSuperuser('Pengurus Pengembalian Balapan');
		const unit = await insertUnit();
		const paymentId = await insertVerifiedPayment(unit.id, rupiah(100_000));
		const invoiceId = await insertInvoice(unit.id, rupiah(100_000), '2026-03');

		let spenderHoldsLocks!: () => void;
		const locksHeld = new Promise<void>((resolve) => {
			spenderHoldsLocks = resolve;
		});
		let spenderMayCommit!: () => void;
		const mayCommit = new Promise<void>((resolve) => {
			spenderMayCommit = resolve;
		});

		const spender = testDb.db.transaction(async (transaction) => {
			const remainders = await lockUnallocatedVerifiedPayments(transaction, unit.id);
			expect(remainders).toEqual([expect.objectContaining({ paymentId, remainder: 100_000 })]);
			spenderHoldsLocks();
			await mayCommit;
			await transaction.insert(allocations).values({
				paymentId,
				invoiceId,
				amount: rupiah(100_000),
				createdAt: new Date(START)
			});
		});

		await locksHeld;
		// The refund starts while the locks are held, so its own locking read queues behind them.
		const refund = refundCredit(testDb.db, new FakeClock(START), {
			actorId,
			unitId: unit.id,
			amount: rupiah(100_000),
			occurredOn: REFUND_DAY,
			reason: REFUND_REASON
		}).catch((error: unknown) => error);
		spenderMayCommit();
		await spender;

		const refusal = await refund;
		expect(refusal).toBeInstanceOf(RefundRuleError);
		expect(refusal).toMatchObject({ rule: REFUND_RULE.amountAboveBalance });

		// The money was spent exactly once: the allocation stands, no refund row exists, and the
		// payment is not overspent.
		expect(await refundRowsOf(unit.id)).toHaveLength(0);
		expect(
			await testDb.db.select().from(allocations).where(eq(allocations.paymentId, paymentId))
		).toHaveLength(1);
		expect(await creditBalanceOfUnit(testDb.db, unit.id)).toBe(0);
	});
});
