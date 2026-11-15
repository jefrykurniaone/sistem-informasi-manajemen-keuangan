import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { allocations } from '#lib/server/db/schema/allocation.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles } from '#lib/server/db/schema/authz.ts';
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
import { FakeClock, FakeFileStore } from '#lib/server/ports/fakes.ts';
import { creditBalanceOfUnit } from '#lib/server/services/dues/credit-balance.ts';
import { refundCredit } from '#lib/server/services/dues/credit-refund.ts';
import {
	reverseRefund,
	UnverifyRefusedRefundedError,
	unverifyPayment
} from '#lib/server/services/dues/dues-correction.ts';
import { issueInvoicesForPeriod } from '#lib/server/services/dues/issuance.ts';
import { cancelOwnPayment } from '#lib/server/services/dues/payment.ts';
import { openInvoicesOfUnit } from '#lib/server/services/dues/allocation.ts';
import {
	recordCashPayment,
	rejectPayment,
	verifyPayment
} from '#lib/server/services/dues/verification.ts';

/**
 * The unit money invariant, run the way the spec asks — "diuji sebagai pernyataan yang dijalankan
 * setelah rangkaian aksi acak yang panjang, bukan hanya pada satu skenario yang dipilih tangan":
 *
 * ```
 * Σ verified payments of a Unit = Σ allocations of those payments + saldo titipan
 *                                 + Σ pengembalian in force
 * ```
 *
 * The refund term is real since #30 landed Pengembalian (user story 23): the sequence below
 * returns random parts of a Unit's balance through the real `refundCredit`, and the sum of its
 * `refunds` rows is the term the equation carries — no longer identically zero. Since #329 the
 * sequence also reverses random Pengembalian through the real `reverseRefund` (Pembatalan
 * Pengembalian), and the term counts only the Pengembalian in force: those whose cash row has no
 * Koreksi, recomputed here from raw rows rather than through the production predicate. Since #331 it
 * also undoes the verification of random verified Pembayaran through the real `unverifyPayment`
 * (Pembatalan verifikasi): the Pembayaran leaves the verified sum, its Alokasi leave the allocated
 * sum, and its income line gets a Koreksi, so every equation below must still close. A pick that
 * still has a Pengembalian in force must be refused by name, and that refusal is asserted too.
 *
 * The action sequence is driven by a **seeded** linear congruential generator, so a failure replays
 * exactly by re-running the file — a random sequence that cannot be reproduced proves nothing about
 * the run that failed. The seed alone is not enough for that: every pick and every service walks
 * rows in some order, and an order that ties falls back to a random id. So the clock moves one
 * minute before every step and every payment is stamped from it, so no two payments share a
 * `createdAt` and every oldest-first order (`pendingPaymentsOf`, the undo's pick, and
 * `lockUnallocatedVerifiedPayments` in the service) is total; and the reversal's pick is ordered by
 * a key that tells apart the portions of one refund, which share an instant. The actions are the real service calls, never direct writes: verification
 * with and without explicit invoice choices, rejection, an admin's cash payment, the payer's own
 * cancellation, a superuser's refund of part of the balance, a superuser's reversal of one
 * Pengembalian, a superuser's Pembatalan verifikasi, and monthly issuance with its automatic saldo
 * titipan consumption. Each of the three corrections must really run at least
 * `MINIMUM_RUNS_PER_CORRECTION` times, so a seed that rarely reaches one of them fails loudly
 * instead of proving nothing about it.
 *
 * Beyond the headline equation, four supporting invariants are asserted after every action,
 * because each is a way the equation could hold while the books were still wrong:
 *
 * - no payment is over-spent: its allocations **plus its refunds in force** never sum past its
 *   amount;
 * - no invoice is over-allocated: its allocations never sum past its amount;
 * - every allocation joins a *verified* payment to a *standing* invoice **of the same Unit**;
 * - **the buku kas agrees with the dues side** (#329): the signed total of the system category
 *   "Iuran warga", Koreksi included, is the verified money of every Unit less every Pengembalian in
 *   force. A reversal that moved the balance without its Koreksi, or wrote a Koreksi without moving
 *   the balance, breaks this one even when the per-Unit equation still holds.
 */

const testDb = testDatabase();

/** The instant every clock starts at. Its Jakarta day sits in February 2026, an open month. */
const START = '2026-02-10T00:00:00.000Z';

/**
 * The seed. Change it only on purpose: it is what makes a failure replayable. #331 changed it from
 * 20260929, together with `ACTION_TABLE`, to a sequence in which every correction clears
 * `MINIMUM_RUNS_PER_CORRECTION` with room to spare: 10 refunds, 13 reversals, 9 Pembatalan
 * verifikasi and 3 refused ones, the same counts on every run.
 */
const SEED = 20261101;

/** How many random actions the sequence runs. */
const ACTION_COUNT = 120;

/**
 * The actions a step picks from, each listed as many times as its weight. The numbers are the cases
 * of the `switch` below. Without the weights the Pembatalan verifikasi (8) drains the verified money
 * the refund (5) needs, and a seed could run the sequence with no Pengembalian at all: so the money
 * flows in (0, 1, 2, 4) and the two Pengembalian actions (5, 6) carry twice the weight of the
 * rejection (3), the issuance (7) and the undo (8).
 */
const ACTION_TABLE = [0, 0, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 7, 8] as const;

/** How far the sequence's clock moves before each step. */
const STEP_MILLISECONDS = 60_000;

/**
 * How many times each correction (refund, reversal, Pembatalan verifikasi) must have succeeded by the
 * end of the sequence, so the run is evidence about each of them rather than about one lucky step.
 */
const MINIMUM_RUNS_PER_CORRECTION = 3;

/** The monthly rate the issuance actions bill at. */
const MONTHLY_RATE = rupiah(150_000);

/** Amounts the payers pick from — odd figures included, so partial allocations really happen. */
const AMOUNTS = [50_000, 100_000, 150_000, 170_000, 300_000, 450_000] as const;

/** Days in February 2026 money can have arrived on. */
const RECEIPT_DAYS = ['2026-02-01', '2026-02-03', '2026-02-05', '2026-02-08'] as const;

/**
 * A linear congruential generator over the classic Numerical Recipes constants. Deterministic and
 * seedable, which `Math.random` is not — and this is a test about money, so the sequence that broke
 * has to be the sequence that reruns.
 */
function createRandom(seed: number): () => number {
	const modulus = 4_294_967_296;
	let state = seed % modulus;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) % modulus;
		return state / modulus;
	};
}

/** One household the sequence acts on. */
interface Household {
	readonly unitId: string;
	readonly payerUserId: string;
	readonly payerResidentId: string;
}

/** Inserts a bare `user` row. */
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

/** The verifying admin: role, and the residents row `payments.verifiedBy` needs. */
async function insertAdmin(): Promise<string> {
	const userId = await insertUser('Pengurus Invarian');
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.admin, createdAt: new Date(START) });
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

/** The refunding superuser. No residents row: `refunds.refundedBy` references `user.id`. */
async function insertSuperuser(): Promise<string> {
	const userId = await insertUser('Pengurus Invarian Pengembalian');
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.superuser, createdAt: new Date(START) });
	return userId;
}

/** One house with one payer living in it. */
async function insertHousehold(number: string): Promise<Household> {
	const payerUserId = await insertUser(`Warga Invarian ${number}`);
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId: payerUserId, createdAt: new Date(START) })
		.returning();
	const [unit] = await testDb.db
		.insert(units)
		.values({ block: 'INV', number, createdAt: new Date(START) })
		.returning();
	return { unitId: unit.id, payerUserId, payerResidentId: resident.id };
}

/**
 * A pending payment, shaped exactly as #28 leaves one for verification, stamped from the sequence's
 * clock: the clock moves on every step, so no two payments share a `createdAt`, and every
 * oldest-first order over them (here and in the services) is decided by time, never by a random id.
 */
async function insertPendingPayment(
	household: Household,
	amount: Rupiah,
	receivedOn: string,
	clock: FakeClock
): Promise<string> {
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId: household.unitId,
			recordedBy: household.payerResidentId,
			amount,
			receivedOn,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: `payments/${randomUUID()}/proof.jpg`,
			status: PAYMENT_STATUS.pending,
			createdAt: clock.now()
		})
		.returning();
	return row.id;
}

/** The pending payments of one unit, oldest first. */
async function pendingPaymentsOf(unitId: string): Promise<readonly string[]> {
	const rows = await testDb.db
		.select({ id: payments.id })
		.from(payments)
		.where(and(eq(payments.unitId, unitId), eq(payments.status, PAYMENT_STATUS.pending)))
		.orderBy(asc(payments.createdAt), asc(payments.id));
	return rows.map((row) => row.id);
}

/**
 * Asserts the headline equation and the three supporting invariants for one Unit, from raw rows —
 * the verified and allocated sums are recomputed here in plain JavaScript, so agreeing with
 * `creditBalanceOfUnit` is a check of the production SQL rather than of itself.
 */
/**
 * The refunds of `rows` still in force: those whose cash row no Koreksi points at. Recomputed from
 * the cash book here, independently of `refundInForce` in the production module.
 */
async function inForce<T extends { readonly cashTransactionId: string }>(
	rows: readonly T[]
): Promise<readonly T[]> {
	if (rows.length === 0) {
		return [];
	}
	const koreksi = await testDb.db
		.select({ correctionOf: cashTransactions.correctionOf })
		.from(cashTransactions)
		.where(
			inArray(
				cashTransactions.correctionOf,
				rows.map((row) => row.cashTransactionId)
			)
		);
	const reversed = new Set(koreksi.map((row) => row.correctionOf));
	return rows.filter((row) => !reversed.has(row.cashTransactionId));
}

/**
 * The buku kas side: the signed total of "Iuran warga", every row and every Koreksi in it, equals
 * the verified money of every Unit less every Pengembalian in force. This file's schema is its own,
 * so the category holds only what the sequence below wrote.
 */
async function assertCashBookAgrees(step: string): Promise<void> {
	const [category] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	const duesRows = await testDb.db
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.categoryId, category.id));
	const net = duesRows.reduce(
		(sum, row) => sum + (row.type === CASH_CATEGORY_TYPE.income ? row.amount : -row.amount),
		0
	);

	const verifiedSum = (
		await testDb.db.select().from(payments).where(eq(payments.status, PAYMENT_STATUS.verified))
	).reduce((sum, row) => sum + row.amount, 0);
	const refundedSum = (await inForce(await testDb.db.select().from(refunds))).reduce(
		(sum, row) => sum + row.amount,
		0
	);

	expect(net, step).toBe(verifiedSum - refundedSum);
}

async function assertInvariants(unitId: string, step: string): Promise<void> {
	const paymentRows = await testDb.db.select().from(payments).where(eq(payments.unitId, unitId));
	const invoiceRows = await testDb.db.select().from(invoices).where(eq(invoices.unitId, unitId));
	const allocationRows =
		paymentRows.length === 0
			? []
			: await testDb.db
					.select()
					.from(allocations)
					.where(
						inArray(
							allocations.paymentId,
							paymentRows.map((row) => row.id)
						)
					);
	const allRefundRows =
		paymentRows.length === 0
			? []
			: await testDb.db
					.select()
					.from(refunds)
					.where(
						inArray(
							refunds.paymentId,
							paymentRows.map((row) => row.id)
						)
					);
	const refundRows = await inForce(allRefundRows);

	const verifiedSum = paymentRows
		.filter((row) => row.status === PAYMENT_STATUS.verified)
		.reduce((sum, row) => sum + row.amount, 0);
	const allocatedSum = allocationRows.reduce((sum, row) => sum + row.amount, 0);
	const credit = await creditBalanceOfUnit(testDb.db, unitId);
	// The real Pengembalian term, summed from the rows #30's refund action writes below, less the
	// ones #329's reversal reversed.
	const refundedSum = refundRows.reduce((sum, row) => sum + row.amount, 0);

	expect(verifiedSum, step).toBe(allocatedSum + credit + refundedSum);
	expect(credit, step).toBeGreaterThanOrEqual(0);

	const paymentById = new Map(paymentRows.map((row) => [row.id, row]));
	const allocatedByPayment = new Map<string, number>();
	const allocatedByInvoice = new Map<string, number>();
	for (const allocation of allocationRows) {
		allocatedByPayment.set(
			allocation.paymentId,
			(allocatedByPayment.get(allocation.paymentId) ?? 0) + allocation.amount
		);
		allocatedByInvoice.set(
			allocation.invoiceId,
			(allocatedByInvoice.get(allocation.invoiceId) ?? 0) + allocation.amount
		);
	}
	const refundedByPayment = new Map<string, number>();
	for (const refund of refundRows) {
		refundedByPayment.set(
			refund.paymentId,
			(refundedByPayment.get(refund.paymentId) ?? 0) + refund.amount
		);
		// A refund only ever consumes verified money.
		expect(paymentById.get(refund.paymentId)?.status, step).toBe(PAYMENT_STATUS.verified);
	}
	for (const [paymentId, total] of allocatedByPayment) {
		const payment = paymentById.get(paymentId);
		expect(payment, step).toBeDefined();
		expect(payment?.status, step).toBe(PAYMENT_STATUS.verified);
		expect(total, step).toBeLessThanOrEqual(payment?.amount ?? 0);
	}
	// No payment is over-spent by its two spenders together: allocations plus refunds never
	// exceed the payment's amount.
	for (const [paymentId, payment] of paymentById) {
		const spent =
			(allocatedByPayment.get(paymentId) ?? 0) + (refundedByPayment.get(paymentId) ?? 0);
		expect(spent, step).toBeLessThanOrEqual(payment.amount);
	}
	const invoiceById = new Map(invoiceRows.map((row) => [row.id, row]));
	for (const [invoiceId, total] of allocatedByInvoice) {
		const invoice = invoiceById.get(invoiceId);
		expect(invoice, step).toBeDefined();
		expect(invoice?.voidedAt, step).toBeNull();
		expect(total, step).toBeLessThanOrEqual(invoice?.amount ?? 0);
	}
}

describe('the unit money invariant, over a long random action sequence', () => {
	it('holds for every unit after every one of the actions', async () => {
		const random = createRandom(SEED);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

		const adminId = await insertAdmin();
		const superuserId = await insertSuperuser();
		const households = [await insertHousehold('1'), await insertHousehold('2')];
		await testDb.db
			.insert(duesRates)
			.values({ amount: MONTHLY_RATE, effectiveFrom: '2026-01-01', createdAt: new Date(START) });

		const clock = new FakeClock(START);
		const fileStore = new FakeFileStore(clock);
		let nextMonth = 3; // Issuance walks 2026-03 onward, one new Periode per issuance action.
		let refundsMade = 0;
		let reversals = 0;
		let unverified = 0;
		let unverifyRefusals = 0;

		for (let step = 1; step <= ACTION_COUNT; step += 1) {
			// One minute per step, so every row a step stamps (a payment, a refund, an Alokasi) is later
			// than every row an earlier step stamped. The rows one step writes together (the portions of
			// one refund) are told apart by the order keys below, never by their random ids.
			clock.advance(STEP_MILLISECONDS);
			const household = pick(households);
			const action = pick(ACTION_TABLE);
			const label = `step ${step}, action ${action}, unit ${household.unitId}`;

			switch (action) {
				case 0: {
					// A resident records a transfer.
					await insertPendingPayment(household, rupiah(pick(AMOUNTS)), pick(RECEIPT_DAYS), clock);
					break;
				}
				case 1: {
					// The admin verifies the oldest pending payment, automatic allocation.
					const pending = await pendingPaymentsOf(household.unitId);
					if (pending.length > 0) {
						await verifyPayment(testDb.db, clock, { actorId: adminId, paymentId: pending[0] });
					}
					break;
				}
				case 2: {
					// The admin verifies with an explicit choice: a random open invoice served first.
					const pending = await pendingPaymentsOf(household.unitId);
					const open = await openInvoicesOfUnit(testDb.db, household.unitId);
					if (pending.length > 0) {
						await verifyPayment(testDb.db, clock, {
							actorId: adminId,
							paymentId: pick(pending),
							invoiceIds: open.length > 0 ? [pick(open).invoiceId] : []
						});
					}
					break;
				}
				case 3: {
					// The admin rejects a pending payment.
					const pending = await pendingPaymentsOf(household.unitId);
					if (pending.length > 0) {
						await rejectPayment(testDb.db, clock, {
							actorId: adminId,
							paymentId: pick(pending),
							reason: 'Nominal tidak cocok dengan mutasi bank.'
						});
					}
					break;
				}
				case 4: {
					// The payer withdraws a pending payment of their own; or, when there is none, the
					// admin takes a cash payment — both are real flows and both must keep the equation.
					const pending = await pendingPaymentsOf(household.unitId);
					if (pending.length > 0) {
						await cancelOwnPayment(testDb.db, clock, fileStore, {
							actorUserId: household.payerUserId,
							paymentId: pick(pending)
						});
					} else {
						await recordCashPayment(testDb.db, clock, {
							actorId: adminId,
							unitId: household.unitId,
							amount: rupiah(pick(AMOUNTS)),
							receivedOn: pick(RECEIPT_DAYS)
						});
					}
					break;
				}
				case 5: {
					// #30: the superuser returns a random part of the unit's saldo titipan. The real
					// service, under the same payment locks every spender takes; skipped while the
					// balance is empty, because a refund of nothing is refused by name.
					const balance = await creditBalanceOfUnit(testDb.db, household.unitId);
					if (balance > 0) {
						await refundCredit(testDb.db, clock, {
							actorId: superuserId,
							unitId: household.unitId,
							amount: rupiah(Math.floor(random() * balance) + 1),
							occurredOn: pick(RECEIPT_DAYS),
							reason: 'Sebagian saldo titipan dikembalikan kepada warganya.'
						});
						refundsMade += 1;
					}
					break;
				}
				case 6: {
					// #329: the superuser reverses one Pengembalian of the unit still in force, picked at
					// random. The real service, under the payment lock; skipped while there is none.
					// Ordered by a total key: the portions of one refund share its instant but each
					// drains another Pembayaran, and no two Pembayaran share a `createdAt`.
					const standing = await inForce(
						(
							await testDb.db
								.select({ refund: refunds })
								.from(refunds)
								.innerJoin(payments, eq(payments.id, refunds.paymentId))
								.where(eq(payments.unitId, household.unitId))
								.orderBy(
									asc(refunds.createdAt),
									asc(payments.receivedOn),
									asc(payments.createdAt),
									asc(refunds.id)
								)
						).map((row) => row.refund)
					);
					if (standing.length > 0) {
						await reverseRefund(testDb.db, clock, {
							actorId: superuserId,
							refundId: pick(standing).id,
							reason: 'Pengembalian salah catat, dibatalkan.'
						});
						reversals += 1;
					}
					break;
				}
				case 8: {
					// #331: the superuser undoes the verification of one verified payment of the unit,
					// picked at random. The real service, under the payment lock. A pick that still has a
					// Pengembalian in force must be refused by name and change nothing; any other pick
					// must succeed. Skipped while the unit has no verified payment.
					const verified = await testDb.db
						.select({ id: payments.id })
						.from(payments)
						.where(
							and(
								eq(payments.unitId, household.unitId),
								eq(payments.status, PAYMENT_STATUS.verified)
							)
						)
						.orderBy(asc(payments.createdAt), asc(payments.id));
					if (verified.length > 0) {
						const paymentId = pick(verified).id;
						const blocking = await inForce(
							await testDb.db.select().from(refunds).where(eq(refunds.paymentId, paymentId))
						);
						const request = {
							actorId: superuserId,
							paymentId,
							reason: 'Uangnya ternyata tidak pernah masuk, verifikasi dibatalkan.'
						};
						if (blocking.length > 0) {
							await expect(unverifyPayment(testDb.db, clock, request), label).rejects.toThrow(
								UnverifyRefusedRefundedError
							);
							unverifyRefusals += 1;
						} else {
							await unverifyPayment(testDb.db, clock, request);
							unverified += 1;
						}
					}
					break;
				}
				default: {
					// A new month's issuance, which also consumes saldo titipan — for every unit at once.
					if (nextMonth <= 12) {
						await issueInvoicesForPeriod(
							testDb.db,
							clock,
							`2026-${String(nextMonth).padStart(2, '0')}`
						);
						nextMonth += 1;
					}
					break;
				}
			}

			for (const each of households) {
				await assertInvariants(each.unitId, label);
			}
			await assertCashBookAgrees(label);
		}

		// The sequence really exercised the books: money moved, obligations were issued.
		const paymentCount = await testDb.db.select({ id: payments.id }).from(payments);
		const invoiceCount = await testDb.db.select({ id: invoices.id }).from(invoices);
		expect(paymentCount.length).toBeGreaterThan(0);
		expect(invoiceCount.length).toBeGreaterThan(0);
		// Printed before the floors below, so a sequence that misses one still says what it did.
		console.info(
			`unit money invariant: ${refundsMade} refunds, ${reversals} reversals, ${unverified} verification undos, ${unverifyRefusals} undo refusals`
		);
		// And every correction really ran, enough times to be evidence: the in-force term and the
		// verified sum were each moved by the corrections rather than left vacuous.
		expect(refundsMade).toBeGreaterThanOrEqual(MINIMUM_RUNS_PER_CORRECTION);
		expect(reversals).toBeGreaterThanOrEqual(MINIMUM_RUNS_PER_CORRECTION);
		expect(unverified).toBeGreaterThanOrEqual(MINIMUM_RUNS_PER_CORRECTION);
		// And the refusal of an undo while a Pengembalian is in force was really met, not only skipped.
		expect(unverifyRefusals).toBeGreaterThanOrEqual(1);
	}, 120_000);
});
