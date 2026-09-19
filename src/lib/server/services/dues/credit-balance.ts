import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import type { DatabaseWriter, Transaction } from '../../authz';
import { allocations } from '../../db/schema/allocation';
import { PAYMENT_STATUS, payments } from '../../db/schema/payment';

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
 * saldo titipan = Σ amount of its verified payments − Σ amount of those payments' allocations
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
 * User story 23's pengembalian — a superuser returning a departing Unit's balance as a cash
 * expense — is not built yet by any ticket that has landed; when it lands, the returned money must
 * join this formula (verified = allocations + saldo titipan + pengembalian, the invariant
 * `tests/unit/unit-money-invariant.test.ts` states with pengembalian at zero). Until then there is
 * deliberately no term for it here rather than a guess at how it will be stored.
 *
 * ## Who writes, who reads
 *
 * Nothing here writes anything. `./allocation.ts` is the one writer of `allocations` rows, and
 * `./verification.ts` and `./issuance.ts` are its two callers. The reads here take no `actorId` and
 * check no permission, the same shape `duesRateOn` and `isUnitExemptOn` have and for the same
 * reason: issuance calls them from a scheduled job that has no session, and every screen that shows
 * the number is guarded by its own action or by row ownership before it asks.
 */

/** One verified Pembayaran and the part of it that still answers nothing. */
export interface PaymentRemainder {
	readonly paymentId: string;
	/** The payment's full amount, in whole rupiah. */
	readonly amount: Rupiah;
	/** How much of it is not yet allocated — its contribution to the Unit's saldo titipan. */
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
			// `::text` and `coalesce`, the idiom `allocatedAmountsByInvoice` in `./queries.ts` records:
			// PostgreSQL widens `sum(bigint)` to `numeric`, and `sum` over no rows is `null`.
			verified: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
			allocated: sql<string>`coalesce((
				select sum(${allocations.amount})
				from ${allocations}
				where ${allocations.paymentId} in (
					select ${payments.id} from ${payments}
					where ${payments.unitId} = ${unitId} and ${payments.status} = ${PAYMENT_STATUS.verified}
				)
			), 0)::text`
		})
		.from(payments)
		.where(and(eq(payments.unitId, unitId), eq(payments.status, PAYMENT_STATUS.verified)));

	return rupiah(Number(row.verified) - Number(row.allocated));
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

	const allocated = await allocatedAmountsByPayment(
		transaction,
		rows.map((row) => row.paymentId)
	);

	return rows.map((row) => ({
		paymentId: row.paymentId,
		amount: row.amount,
		remainder: rupiah(row.amount - (allocated.get(row.paymentId) ?? 0))
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
