import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import type { DatabaseWriter, Transaction } from '../../authz';
import { allocations, type Allocation } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import type { Clock } from '../../ports/clock';
import { lockUnallocatedVerifiedPayments } from './credit-balance';

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
 * - **A payment is never over-spent.** `planAllocations` is the only arithmetic that decides
 *   amounts, and it allocates out of a fixed budget: the sum of what it plans can never exceed the
 *   money it was given. Every caller hands it either one payment's full amount (verification) or
 *   the locked remainders of a Unit's verified payments (issuance), so nothing upstream can hand it
 *   more money than exists.
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
 * ## What deliberately is not here
 *
 * - **No release.** Deleting an allocation is user story 22, superuser's, and #30's ticket. When it
 *   arrives it must take the same payment row lock every writer here takes, or its read of "what
 *   this payment still covers" races the writers above.
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
 * unique pair `(unit, period)` prevents anyway.
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

	return withAllocatedAmounts(db, rows);
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
	// totals cannot move once the row locks are held.
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

	return withAllocatedAmounts(transaction, rows);
}

/** The raw invoice rows both reads above select, before their allocated sums are attached. */
interface OpenInvoiceRow {
	readonly invoiceId: string;
	readonly period: string;
	readonly amount: Rupiah;
	readonly dueDate: string;
}

/** Attaches each row's allocated total and the remainder computed from it. */
async function withAllocatedAmounts(
	db: DatabaseWriter,
	rows: readonly OpenInvoiceRow[]
): Promise<readonly OpenInvoice[]> {
	if (rows.length === 0) {
		return [];
	}

	const totals = await db
		.select({
			invoiceId: allocations.invoiceId,
			total: sql<string>`coalesce(sum(${allocations.amount}), 0)::text`
		})
		.from(allocations)
		.where(
			inArray(
				allocations.invoiceId,
				rows.map((row) => row.invoiceId)
			)
		)
		.groupBy(allocations.invoiceId);
	const allocatedByInvoice = new Map(totals.map((row) => [row.invoiceId, Number(row.total)]));

	return rows.map((row) => {
		const allocatedAmount = rupiah(allocatedByInvoice.get(row.invoiceId) ?? 0);
		return {
			...row,
			allocatedAmount,
			remainingAmount: rupiah(row.amount - allocatedAmount)
		};
	});
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
 * The Unit's verified payments are locked through `lockUnallocatedVerifiedPayments`, and each
 * payment's remainder is drained in turn until the Tagihan is covered or the balance runs out; a
 * partial balance leaves a partial allocation, which #27's `invoiceStatus` reads as `partial`. One
 * allocation row per payment drained, because a row maps one payment to one invoice.
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

	let stillOwed: number = invoice.amount;
	let applied = 0;
	for (const payment of remainders) {
		if (stillOwed <= 0 || payment.remainder <= 0) {
			continue;
		}
		const amount = Math.min(stillOwed, payment.remainder);
		await allocatePaymentToInvoices(transaction, clock, payment.paymentId, [
			{ invoiceId: invoice.id, amount: rupiah(amount) }
		]);
		stillOwed -= amount;
		applied += amount;
	}

	return rupiah(applied);
}
