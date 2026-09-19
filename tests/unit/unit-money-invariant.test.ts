import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { duesRates } from '$lib/server/db/schema/dues-rate';
import { invoices } from '$lib/server/db/schema/invoice';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { creditBalanceOfUnit } from '$lib/server/services/dues/credit-balance';
import { issueInvoicesForPeriod } from '$lib/server/services/dues/issuance';
import { cancelOwnPayment } from '$lib/server/services/dues/payment';
import { openInvoicesOfUnit } from '$lib/server/services/dues/allocation';
import {
	recordCashPayment,
	rejectPayment,
	verifyPayment
} from '$lib/server/services/dues/verification';

/**
 * The unit money invariant, run the way the spec asks — "diuji sebagai pernyataan yang dijalankan
 * setelah rangkaian aksi acak yang panjang, bukan hanya pada satu skenario yang dipilih tangan":
 *
 * ```
 * Σ verified payments of a Unit = Σ allocations of those payments + saldo titipan (+ pengembalian)
 * ```
 *
 * Pengembalian (user story 23) has no landed implementation, so its term is identically zero here;
 * the ticket that builds it extends this file's `invariantHoldsFor` with the refund sum.
 *
 * The action sequence is driven by a **seeded** linear congruential generator, so a failure replays
 * exactly by re-running the file — a random sequence that cannot be reproduced proves nothing about
 * the run that failed. The actions are the real service calls, never direct writes: verification
 * with and without explicit invoice choices, rejection, an admin's cash payment, the payer's own
 * cancellation, and monthly issuance with its automatic saldo titipan consumption.
 *
 * Beyond the headline equation, three supporting invariants are asserted after every action,
 * because each is a way the equation could hold while the books were still wrong:
 *
 * - no payment is over-spent: its allocations never sum past its amount;
 * - no invoice is over-allocated: its allocations never sum past its amount;
 * - every allocation joins a *verified* payment to a *standing* invoice **of the same Unit**.
 */

const testDb = testDatabase();

/** The instant every clock starts at. Its Jakarta day sits in February 2026, an open month. */
const START = '2026-02-10T00:00:00.000Z';

/** The seed. Change it only on purpose: it is what makes a failure replayable. */
const SEED = 20260929;

/** How many random actions the sequence runs. */
const ACTION_COUNT = 90;

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

/** A pending payment, shaped exactly as #28 leaves one for verification. */
async function insertPendingPayment(
	household: Household,
	amount: Rupiah,
	receivedOn: string
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
			createdAt: new Date(START)
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

	const verifiedSum = paymentRows
		.filter((row) => row.status === PAYMENT_STATUS.verified)
		.reduce((sum, row) => sum + row.amount, 0);
	const allocatedSum = allocationRows.reduce((sum, row) => sum + row.amount, 0);
	const credit = await creditBalanceOfUnit(testDb.db, unitId);
	const refunds = 0; // Pengembalian has no implementation yet; see this file's doc comment.

	expect(verifiedSum, step).toBe(allocatedSum + credit + refunds);
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
	for (const [paymentId, total] of allocatedByPayment) {
		const payment = paymentById.get(paymentId);
		expect(payment, step).toBeDefined();
		expect(payment?.status, step).toBe(PAYMENT_STATUS.verified);
		expect(total, step).toBeLessThanOrEqual(payment?.amount ?? 0);
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
		const households = [await insertHousehold('1'), await insertHousehold('2')];
		await testDb.db
			.insert(duesRates)
			.values({ amount: MONTHLY_RATE, effectiveFrom: '2026-01-01', createdAt: new Date(START) });

		const clock = new FakeClock(START);
		const fileStore = new FakeFileStore(clock);
		let nextMonth = 3; // Issuance walks 2026-03 onward, one new Periode per issuance action.

		for (let step = 1; step <= ACTION_COUNT; step += 1) {
			const household = pick(households);
			const action = Math.floor(random() * 6);
			const label = `step ${step}, action ${action}, unit ${household.unitId}`;

			switch (action) {
				case 0: {
					// A resident records a transfer.
					await insertPendingPayment(household, rupiah(pick(AMOUNTS)), pick(RECEIPT_DAYS));
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
		}

		// The sequence really exercised the books: money moved, obligations were issued.
		const paymentCount = await testDb.db.select({ id: payments.id }).from(payments);
		const invoiceCount = await testDb.db.select({ id: invoices.id }).from(invoices);
		expect(paymentCount.length).toBeGreaterThan(0);
		expect(invoiceCount.length).toBeGreaterThan(0);
	}, 120_000);
});
