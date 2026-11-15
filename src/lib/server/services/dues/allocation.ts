import { and, asc, eq, isNull } from 'drizzle-orm';
import { rupiah, type Rupiah } from '#lib/money.ts';
import type { DatabaseWriter, Transaction } from '../../authz';
import { allocations, type Allocation } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import type { Clock } from '../../ports/clock';
import { lockUnallocatedVerifiedPayments, type PaymentRemainder } from './credit-balance';
import { allocatedAmountsOf } from './invoice-standing';

/**
 * Alokasi: how much of one Pembayaran answers one Tagihan — and this module is the **only writer of
 * `allocations` rows in this codebase**. `docs/spec-iuran-v1.md:131-136` keeps payments and
 * allocations apart so that money can exist before anything it pays for does; this module is the
 * other half of that split, the one place the mapping is created.
 *
 * ## The two invariants, and where each is held
 *
 * `src/lib/server/db/schema/allocation.ts` assigns both money invariants to "the verification
 * transaction … where the rows are locked and the arithmetic is done". They are held here, one by
 * arithmetic and one by locks:
 *
 * - **A payment is never over-spent.** Two planners decide every amount, and each plans out of a
 *   fixed budget: `planAllocations` never plans more than the one payment's full amount
 *   verification hands it, and `planCreditSpend` never takes more from a payment than the remainder
 *   `lockUnallocatedVerifiedPayments` read for it under that payment's lock (issuance, and the
 *   Pengembalian). Nothing upstream can hand either more money than exists.
 * - **An invoice is never over-allocated.** Each target carries its *remaining* amount and the
 *   planner never allocates past it — and the remaining amounts are read under locks, so two
 *   concurrent writers cannot both see the same headroom. Verification locks the Unit's open
 *   invoices `for update` through `lockOpenInvoicesOfUnit` before planning; issuance's credit
 *   application writes onto an invoice its own transaction just inserted, which no concurrent
 *   reader can see at all.
 *
 * Neither invariant lives in the database, and the schema says why: a `CHECK` sees one row, and
 * both of these are sums across rows. The lock discipline is the enforcement.
 *
 * ## Lock order
 *
 * Everywhere allocations are written, payment rows are locked before invoice rows:
 * verification takes `for update` on its own payment first and the Unit's open invoices second;
 * issuance's credit application locks the Unit's verified payments (through
 * `lockUnallocatedVerifiedPayments`) and touches no existing invoice at all. One order means no
 * pair of writers can wait on each other in a cycle.
 *
 * ## Spending the Saldo Titipan, oldest money first
 *
 * Two things spend a Unit's Saldo Titipan: issuance's credit application below, onto a Tagihan it
 * just issued, and the Pengembalian (`refundCredit` in `./dues-correction.ts`), out of the kas. Both
 * lock the Unit's verified payments through `lockUnallocatedVerifiedPayments` and then walk the
 * per-payment remainders it hands back with `planCreditSpend`, the one walk of those remainders in
 * this codebase, so the two can never disagree about which payment's money goes first.
 *
 * ## What deliberately is not here
 *
 * - **No release.** Deleting an allocation is `releaseAllocation` in `./dues-correction.ts`. It
 *   takes the same payment row lock every writer here takes, because otherwise its read of "what
 *   this payment still covers" would race the writers above.
 * - **No permission checks and no audit rows.** Every function takes a `Transaction` and runs
 *   inside a caller that already checked its own action and writes its own single audit row — the
 *   same shape `lockPeriod` and `recordDuesIncome` have, for the same reasons.
 */

/** One Tagihan as a planner sees it: what it is owed, in the order it should be served. */
export interface AllocationTarget {
	readonly invoiceId: string;
	/** What the Tagihan is still owed — its amount less what is already allocated to it. */
	readonly remaining: Rupiah;
}

/** One planned write: this much of the money answers this Tagihan. Always strictly positive. */
export interface PlannedAllocation {
	readonly invoiceId: string;
	readonly amount: Rupiah;
}

/**
 * Decides how `available` money lands on `targets`, walking them **in the order given** and filling
 * each up to its remaining amount until the money runs out. Pure, so
 * `tests/unit/allocation.test.ts` walks its arithmetic without a database.
 *
 * The order of `targets` is the caller's whole policy and is deliberately not re-decided here:
 * verification passes the Warga's explicitly chosen Tagihan first and the rest oldest-first —
 * "tagihan yang dipilih warga secara eksplisit dihormati lebih dulu" — and issuance passes exactly
 * one target, the Tagihan it just issued. A target already fully paid (`remaining` zero) is passed
 * over rather than refused, and a duplicate target id is served only once, so a caller's list needs
 * no pre-cleaning to stay inside `allocations_payment_id_invoice_id_unique`.
 *
 * What is left of `available` after the last target is **not** in the answer, on purpose: it is the
 * saldo titipan, which is defined as the difference the rows leave behind
 * (`./credit-balance.ts`), never as a number something computed and stored.
 */
export function planAllocations(
	available: Rupiah,
	targets: readonly AllocationTarget[]
): readonly PlannedAllocation[] {
	const planned: PlannedAllocation[] = [];
	const served = new Set<string>();
	let left: number = available;

	for (const target of targets) {
		if (left <= 0) {
			break;
		}
		if (target.remaining <= 0 || served.has(target.invoiceId)) {
			continue;
		}
		served.add(target.invoiceId);
		const amount = Math.min(left, target.remaining);
		planned.push({ invoiceId: target.invoiceId, amount: rupiah(amount) });
		left -= amount;
	}

	return planned;
}

/** One planned draw on the Saldo Titipan: this much of this Pembayaran's remainder is spent. */
export interface PlannedSpend {
	readonly paymentId: string;
	/** Strictly positive, and never more than the payment's remainder. */
	readonly amount: Rupiah;
}

/**
 * Decides which Pembayaran's remainders pay for `wanted`, walking `remainders` **in the order
 * given** and taking from each, up to its remainder, until `wanted` is covered or the money runs
 * out. Pure, so `tests/unit/allocation.test.ts` walks it without a database.
 *
 * The one walk of a Unit's per-payment remainders, shared by both spenders of the Saldo Titipan:
 * `applyCreditToInvoice` below and `refundCredit` in `./dues-correction.ts`. Each hands it the
 * rows `lockUnallocatedVerifiedPayments` returned, already locked and already oldest money first,
 * so "oldest first" is that read's order and is not re-decided here, the same division
 * `planAllocations` keeps with its targets. A remainder of zero is passed over.
 *
 * The answer never totals more than `wanted` nor more than the remainders hold. When the money runs
 * out first it totals less: issuance leaves the Tagihan partly paid, and a Pengembalian refuses an
 * amount above the balance before it asks.
 */
export function planCreditSpend(
	remainders: readonly Pick<PaymentRemainder, 'paymentId' | 'remainder'>[],
	wanted: Rupiah
): readonly PlannedSpend[] {
	const planned: PlannedSpend[] = [];
	let left: number = wanted;

	for (const payment of remainders) {
		if (left <= 0) {
			break;
		}
		if (payment.remainder <= 0) {
			continue;
		}
		const amount = Math.min(left, payment.remainder);
		planned.push({ paymentId: payment.paymentId, amount: rupiah(amount) });
		left -= amount;
	}

	return planned;
}

/** One Tagihan that could still absorb money, as the verification screen and planner both read it. */
export interface OpenInvoice {
	readonly invoiceId: string;
	/** The calendar month it is for, as `YYYY-MM`. */
	readonly period: string;
	readonly amount: Rupiah;
	/** What is already allocated to it, from every payment there is. */
	readonly allocatedAmount: Rupiah;
	/** `amount` less `allocatedAmount`. */
	readonly remainingAmount: Rupiah;
	/** The day it falls due, as `YYYY-MM-DD`. */
	readonly dueDate: string;
}

/**
 * Every Tagihan of `unitId` that still stands — not cancelled — with what is already allocated to
 * it, oldest Periode first, **including the fully paid ones** (their `remainingAmount` is zero, and
 * a screen deciding what to offer wants to know they exist). Fixed-width `YYYY-MM` periods make
 * "oldest first" a plain text sort, and `id` breaks a tie between two rows of one period, which the
 * unique pair `(unit, period)` prevents anyway. The allocated and remaining amounts come from
 * `allocatedAmountsOf` in `./invoice-standing.ts`; this module sums no Alokasi of its own.
 *
 * No lock and no caller: this is the read for a screen. The write path uses
 * `lockOpenInvoicesOfUnit` below, because a remaining amount read without a lock is stale the
 * moment it is returned.
 */
export async function openInvoicesOfUnit(
	db: DatabaseWriter,
	unitId: string
): Promise<readonly OpenInvoice[]> {
	const rows = await db
		.select({
			invoiceId: invoices.id,
			period: invoices.period,
			amount: invoices.amount,
			dueDate: invoices.dueDate
		})
		.from(invoices)
		.where(and(eq(invoices.unitId, unitId), isNull(invoices.voidedAt)))
		.orderBy(asc(invoices.period), asc(invoices.id));

	return allocatedAmountsOf(db, rows);
}

/**
 * The same rows as `openInvoicesOfUnit`, with every one of them locked `for update` until the
 * caller's transaction ends — the read the verification transaction makes before it plans.
 *
 * The lock is what makes "an invoice is never over-allocated" hold across two concurrent
 * verifications of one Unit: without it, both read the same remaining amount under READ COMMITTED
 * and both fill it. Both callers lock the same set in the same order (period, then id), so two
 * verifications contend in one direction rather than deadlocking.
 */
export async function lockOpenInvoicesOfUnit(
	transaction: Transaction,
	unitId: string
): Promise<readonly OpenInvoice[]> {
	// Locked first, aggregated second: PostgreSQL refuses `FOR UPDATE` beside an aggregate, and the
	// totals cannot move once the row locks are held. The sum is `allocatedAmountsOf`'s, the second
	// door of `./invoice-standing.ts`, run in this same transaction after these locks.
	const rows = await transaction
		.select({
			invoiceId: invoices.id,
			period: invoices.period,
			amount: invoices.amount,
			dueDate: invoices.dueDate
		})
		.from(invoices)
		.where(and(eq(invoices.unitId, unitId), isNull(invoices.voidedAt)))
		.orderBy(asc(invoices.period), asc(invoices.id))
		.for('update');

	return allocatedAmountsOf(transaction, rows);
}

/**
 * Writes one payment's planned allocations, dated on the clock's instant.
 *
 * The caller — verification, and nobody else today — already holds the payment's row lock and the
 * target invoices' row locks, and its plan came out of `planAllocations` over remaining amounts
 * read under those locks; this function only turns the plan into rows.
 */
export async function allocatePaymentToInvoices(
	transaction: Transaction,
	clock: Clock,
	paymentId: string,
	plan: readonly PlannedAllocation[]
): Promise<readonly Allocation[]> {
	if (plan.length === 0) {
		return [];
	}
	return transaction
		.insert(allocations)
		.values(
			plan.map((planned) => ({
				paymentId,
				invoiceId: planned.invoiceId,
				amount: planned.amount,
				createdAt: clock.now()
			}))
		)
		.returning();
}

/** The one Tagihan issuance just created, as its credit application needs to see it. */
export interface CreditableInvoice {
	readonly id: string;
	readonly unitId: string;
	readonly amount: Rupiah;
}

/**
 * Pays a freshly issued Tagihan out of its Unit's saldo titipan, oldest money first — the
 * acceptance criterion "saat tagihan baru terbit, saldo titipan unit dipakai otomatis untuk
 * melunasinya", run by `./issuance.ts` inside the same per-Unit transaction that inserted the row.
 *
 * The Unit's verified payments are locked through `lockUnallocatedVerifiedPayments`, and
 * `planCreditSpend` drains each payment's remainder in turn until the Tagihan is covered or the
 * balance runs out; a partial balance leaves a partial allocation, which `invoiceStandings` in
 * `./invoice-standing.ts` reads as `partial`. One allocation row per payment drained, written in
 * the order planned, because a row maps one payment to one invoice.
 *
 * **No cash transaction is written and no Periode is consulted.** The money being spent here
 * entered the cash book when its payment was verified, dated on its own `receivedOn`; consuming it
 * moves no cash, so there is nothing for a locked month to refuse. And **no audit row**:
 * `docs/spec-iuran-v1.md:171-172` lists what is audited, and issuance's automatic use of the
 * balance is not on the list — the allocations' own `createdAt` records when it happened.
 *
 * @returns how much of the Tagihan the balance covered, possibly zero.
 */
export async function applyCreditToInvoice(
	transaction: Transaction,
	clock: Clock,
	invoice: CreditableInvoice
): Promise<Rupiah> {
	const remainders = await lockUnallocatedVerifiedPayments(transaction, invoice.unitId);
	const planned = planCreditSpend(remainders, invoice.amount);

	for (const spend of planned) {
		await allocatePaymentToInvoices(transaction, clock, spend.paymentId, [
			{ invoiceId: invoice.id, amount: spend.amount }
		]);
	}

	return rupiah(planned.reduce((total, spend) => total + spend.amount, 0));
}
