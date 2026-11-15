import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { rupiah, type Rupiah } from '#lib/money.ts';
import type { DatabaseWriter, Transaction } from '../../authz';
import { allocations } from '../../db/schema/allocation';
import { cashTransactions } from '../../db/schema/cash-transaction';
import { PAYMENT_STATUS, payments } from '../../db/schema/payment';
import { refunds } from '../../db/schema/refund';

/**
 * Saldo Titipan: the part of a Unit's verified money that answers no Tagihan yet. `CONTEXT.md`
 * defines it — "bagian Pembayaran terverifikasi sebuah Unit yang belum dialokasikan ke Tagihan mana
 * pun. Milik Unit, bukan milik orang" — and `docs/spec-iuran-v1.md:138-142` settles the shape this
 * module exists to keep: **a number that is computed, never a column that is stored and updated**,
 * "sehingga tidak bisa melenceng dari transaksinya". The "Nama di kode" table says the same thing
 * from the schema's side: `CreditBalance` is "dihitung, tanpa tabel".
 *
 * ## The definition, stated once
 *
 * For one Unit:
 *
 * ```
 * saldo titipan = Σ amount of its verified payments
 *               − Σ amount of those payments' allocations
 *               − Σ amount of those payments' refunds in force
 * ```
 *
 * Three consequences, each of which some caller depends on:
 *
 * - **Only `verified` payments count.** A `pending` payment is money nobody has confirmed and a
 *   `rejected` one is money that never arrived; neither may lift a Unit's balance. A pending
 *   payment also never has allocations — verification is what creates them — so the subtraction
 *   cannot go negative through the status filter.
 * - **The sum runs over the payments' allocations, not over "allocations of this Unit's
 *   invoices".** The two differ, and the first is the definition: an allocation belongs to the
 *   payment it spends, and the payment belongs to a Unit through `payments.unitId`. Money paid by
 *   this Unit toward an invoice is this Unit's spending wherever the invoice lives.
 * - **Releasing an allocation (#30) restores the balance with no write here.** The row's deletion
 *   *is* the restoration, because the balance is this subtraction and nothing else.
 *
 * The refund term is user story 23's Pengembalian, landed by #30: `refunds` rows attribute
 * returned money to the Pembayaran whose remainder it consumed
 * (`src/lib/server/db/schema/refund.ts` records why per-payment attribution is the only shape that
 * works), so a refund reduces both this balance and the per-payment remainders below through the
 * very same subtraction that allocations use. That is what keeps
 * `verified = allocations + saldo titipan + refunds in force` — the invariant
 * `tests/unit/unit-money-invariant.test.ts` runs — true with no second bookkeeping: money a refund
 * returned is money `lockUnallocatedVerifiedPayments` no longer offers, so the next issuance
 * cannot spend it a second time.
 *
 * **"In force" is #329's Pembatalan Pengembalian** (spec #308 decision 6): a refund stops counting
 * the moment its cash expense row has a Koreksi, which is what `reverseRefund` in
 * `./dues-correction.ts` writes. There is no column for it; `refundInForce` below is the one
 * statement of the rule, used by both reads here and by the finance screen's list of Pengembalian
 * in `./corrections-history.ts`, so the balance and the list can never disagree about which refunds
 * still count. A reversed refund's money is therefore back in the balance and back in its
 * Pembayaran's remainder in the same commit as the Koreksi, through the same subtraction.
 *
 * ## Who writes, who reads
 *
 * Nothing here writes anything. `./allocation.ts` is the one writer of `allocations` rows, with
 * `./verification.ts` and `./issuance.ts` as its two callers, and `refundCredit` in
 * `./dues-correction.ts` is the one writer of `refunds` rows (`reverseRefund` beside it writes a
 * Koreksi, never a `refunds` row). The reads here take no `actorId` and
 * check no permission, the same shape `duesRateOn` and `isUnitExemptOn` have and for the same
 * reason: issuance calls them from a scheduled job that has no session, and every screen that shows
 * the number is guarded by its own action or by row ownership before it asks.
 */

/** One verified Pembayaran and the part of it that still answers nothing. */
export interface PaymentRemainder {
	readonly paymentId: string;
	/** The payment's full amount, in whole rupiah. */
	readonly amount: Rupiah;
	/**
	 * What is neither allocated nor refunded by a refund in force — its contribution to the Unit's
	 * saldo titipan.
	 */
	readonly remainder: Rupiah;
}

/**
 * One Unit's Saldo Titipan, computed from its rows at the moment of asking.
 *
 * A plain read with no lock: it is for screens and for assertions. A caller about to *spend* the
 * balance uses `lockUnallocatedVerifiedPayments` instead, because a number read without a lock is
 * stale the moment it is returned — the same rule `isDateInLockedPeriod` states about itself.
 */
export async function creditBalanceOfUnit(db: DatabaseWriter, unitId: string): Promise<Rupiah> {
	const [row] = await db
		.select({
			// `::text` and `coalesce`, the idiom `allocatedByInvoice` in `./invoice-standing.ts` records:
			// PostgreSQL widens `sum(bigint)` to `numeric`, and `sum` over no rows is `null`.
			verified: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
			allocated: sql<string>`coalesce((
				select sum(${allocations.amount})
				from ${allocations}
				where ${allocations.paymentId} in (
					select ${payments.id} from ${payments}
					where ${payments.unitId} = ${unitId} and ${payments.status} = ${PAYMENT_STATUS.verified}
				)
			), 0)::text`,
			refunded: sql<string>`coalesce((
				select sum(${refunds.amount})
				from ${refunds}
				where ${refunds.paymentId} in (
					select ${payments.id} from ${payments}
					where ${payments.unitId} = ${unitId} and ${payments.status} = ${PAYMENT_STATUS.verified}
				)
				and ${refundInForce()}
			), 0)::text`
		})
		.from(payments)
		.where(and(eq(payments.unitId, unitId), eq(payments.status, PAYMENT_STATUS.verified)));

	return rupiah(Number(row.verified) - Number(row.allocated) - Number(row.refunded));
}

/**
 * Every verified Pembayaran of `unitId`, **locked `for update` until the caller's transaction
 * ends**, each with the part of it that is still unallocated — oldest money first.
 *
 * This is the read a spender makes. `./allocation.ts` calls it when a freshly issued Tagihan
 * consumes the Unit's saldo titipan, and the lock is what makes "a payment is never over-spent"
 * true under READ COMMITTED: two concurrent spenders of one Unit's balance — two issuance runs for
 * different months, today — contend on these rows instead of both reading the same remainder and
 * both allocating it. It is the same lesson `lockOpeningBalanceCategory` and `lockTransaction` in
 * `src/lib/server/services/cash/` record; verification takes the same lock on its own payment row
 * before it allocates, so every writer of `allocations` holds the lock of every payment it spends.
 *
 * "Oldest money first" is `receivedOn`, then `createdAt`, then `id` — the day the money actually
 * changed hands, with the two tie-breakers making the order total so that two runs can never walk
 * the same rows in different orders. The rows come back in that order with their remainders, every
 * one of them, including remainders of zero: which ones to spend is the caller's decision, and
 * filtering here would hide rows the caller's arithmetic may still want to see.
 */
export async function lockUnallocatedVerifiedPayments(
	transaction: Transaction,
	unitId: string
): Promise<readonly PaymentRemainder[]> {
	// Two statements rather than one, because PostgreSQL refuses `FOR UPDATE` beside an aggregate:
	// the rows are locked first, then their allocation totals are read — inside the same
	// transaction, so the totals cannot move while the locks are held.
	const rows = await transaction
		.select({ paymentId: payments.id, amount: payments.amount })
		.from(payments)
		.where(and(eq(payments.unitId, unitId), eq(payments.status, PAYMENT_STATUS.verified)))
		.orderBy(asc(payments.receivedOn), asc(payments.createdAt), asc(payments.id))
		.for('update');
	if (rows.length === 0) {
		return [];
	}

	const paymentIds = rows.map((row) => row.paymentId);
	const allocated = await allocatedAmountsByPayment(transaction, paymentIds);
	const refunded = await refundedAmountsByPayment(transaction, paymentIds);

	return rows.map((row) => ({
		paymentId: row.paymentId,
		amount: row.amount,
		remainder: rupiah(
			row.amount - (allocated.get(row.paymentId) ?? 0) - (refunded.get(row.paymentId) ?? 0)
		)
	}));
}

/**
 * How much of each of `paymentIds` is already allocated, keyed by payment id and absent for one
 * with no allocation at all — the caller reads a missing entry as zero. A `Map`, never an object
 * literal, for the reason `transactionCountsByMonth` in
 * `src/lib/server/services/cash/period.ts` records.
 */
export async function allocatedAmountsByPayment(
	db: DatabaseWriter,
	paymentIds: readonly string[]
): Promise<ReadonlyMap<string, Rupiah>> {
	if (paymentIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			paymentId: allocations.paymentId,
			total: sql<string>`coalesce(sum(${allocations.amount}), 0)::text`
		})
		.from(allocations)
		.where(inArray(allocations.paymentId, paymentIds))
		.groupBy(allocations.paymentId);

	return new Map(rows.map((row) => [row.paymentId, rupiah(Number(row.total))]));
}

/**
 * How much of each of `paymentIds` has been refunded by refunds still in force, keyed by payment id
 * and absent for one with none — the exact counterpart of `allocatedAmountsByPayment`, because a
 * Pengembalian spends a payment's remainder the same way an Alokasi does and every reader of a
 * remainder must subtract both or over-count the money. A reversed refund (`refundInForce`) spends
 * nothing.
 */
export async function refundedAmountsByPayment(
	db: DatabaseWriter,
	paymentIds: readonly string[]
): Promise<ReadonlyMap<string, Rupiah>> {
	if (paymentIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			paymentId: refunds.paymentId,
			total: sql<string>`coalesce(sum(${refunds.amount}), 0)::text`
		})
		.from(refunds)
		.where(and(inArray(refunds.paymentId, paymentIds), refundInForce()))
		.groupBy(refunds.paymentId);

	return new Map(rows.map((row) => [row.paymentId, rupiah(Number(row.total))]));
}

/**
 * Whether the `refunds` row of the surrounding query is still in force: its cash expense row has no
 * Koreksi. A SQL condition over `refunds`, for a query that reads that table.
 *
 * Spec #308 decision 6 derives "sudah dibatalkan" from the Koreksi on the refund's cash row, with no
 * column of its own, and this is the one place the derivation is written. It counts any Koreksi,
 * whichever kind wrote it: since #323 only `reverseRefund` can write one on a Pengembalian's line,
 * and a Koreksi an Admin wrote there before #323 reverses the money in the buku kas all the same, so
 * the refund it reversed must stop counting too (the spec's "Risiko" section accepts exactly this).
 *
 * At most one Koreksi exists per line (the line lock in `writeCashTransaction`), so `not exists` and
 * a count agree; `not exists` is used because it cannot multiply rows.
 */
export function refundInForce(): SQL {
	return sql`not exists (
		select 1 from ${cashTransactions}
		where ${cashTransactions.correctionOf} = ${refunds.cashTransactionId}
	)`;
}
