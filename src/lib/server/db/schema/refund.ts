import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';
import { user } from './auth';
import { cashTransactions } from './cash-transaction';
import { payments } from './payment';

/**
 * `refunds`: the Pengembalian — money handed back out of a Unit's Saldo Titipan to the Warga it
 * belongs to, user story 23 of `docs/spec-iuran-v1.md`. `CONTEXT.md` defines it as "Pengeluaran kas
 * yang mengembalikan Saldo Titipan sebuah Unit kepada Warganya, sebagian atau seluruhnya", and this
 * table is where that expense is attributed to the money it consumed.
 *
 * ## Why the row points at a Pembayaran, and why that is the whole design
 *
 * Saldo titipan is not a number anything stores — it is Σ verified payments − Σ their allocations,
 * per `src/lib/server/services/dues/credit-balance.ts`, and every spender of it
 * (`applyCreditToInvoice`, run by issuance) spends **per-payment remainders**, drained oldest
 * first through `lockUnallocatedVerifiedPayments`. A refund that reduced only some unit-level
 * figure would be invisible to those remainders, and the next issuance would spend the refunded
 * rupiah a second time. So a refund is attributed exactly the way an Alokasi is: to the one
 * Pembayaran whose remainder it consumed, and a payment's remainder becomes
 * `amount − allocations − refunds`. One refund action that drains several payments writes one row
 * here per payment drained — the same shape one verification writing several `allocations` rows
 * already has.
 *
 * Decisions settled here:
 *
 * - **A flat table, not a parent row with a child attribution table.** A `refund_allocations`
 *   child table was considered and rejected: `CONTEXT.md`'s "Nama di kode" table is binding — "a
 *   ticket that uses an English name outside that table is inventing a concept and has to stop" —
 *   and the glossary maps Pengembalian to exactly one table, `refunds`. The flat shape needs no
 *   second name, and it loses nothing: the per-payment sums that `creditBalanceOfUnit` and
 *   `lockUnallocatedVerifiedPayments` subtract group this table by `payment_id` exactly as they
 *   group `allocations`.
 * - **`refunds_cash_transaction_id_unique` makes each refund one cash row, and each cash row one
 *   refund.** The money leaves the buku kas as an expense in the system category "Iuran warga"
 *   (`src/lib/server/services/cash/transaction.ts` owns that insert), one cash row per payment
 *   drained — the mirror of verification, which writes one income row per payment verified. The
 *   unique index is the row-local half the database can enforce of "setiap Pengembalian merujuk
 *   tepat satu baris kas keluar": no second refund can ever claim a cash row that is already
 *   spoken for. That the amounts agree is a cross-row fact, held by the one writer in
 *   `src/lib/server/services/dues/credit-refund.ts` and asserted in its tests.
 * - **No `unit_id` column, on purpose.** `cash_transactions` has no `unit_id`, so the attribution
 *   to a Unit lives here — through `payment_id`, whose row carries `payments.unitId`, exactly as an
 *   Alokasi is a Unit's through its payment. A second, direct `unit_id` column would be a copy the
 *   database could never check against the payment's, and a refund row whose two units disagreed
 *   would corrupt every balance read. The join is one indexed hop, and the sums already start from
 *   `payments`.
 * - **`refunds_amount_check` refuses zero, not just negatives** — `amount > 0`, the strictness of
 *   `cash_transactions_amount_check` rather than the `>= 0` of `allocations`: a refund is a
 *   movement of money, so a zero-rupiah row records nothing happening.
 * - **`reason` and `refundedBy` are `not null`.** Returning cash to a departing resident is exactly
 *   the kind of irreversible act the audit trail exists for; a refund with no reason or no actor is
 *   the silent payout this table must make unwritable, not merely discouraged.
 * - **`refundedBy` references `user.id`, not `residents.id`.** Who performed an action is an
 *   account — the decision `cash_transactions.recordedBy` landed, and the trap
 *   `src/lib/server/services/cash/period.ts` records about `exemptions.createdBy`: a superuser
 *   with no `residents` row must not be shut out of a superuser-only action. No `onDelete`; who
 *   returned money is attributed history.
 * - **Neither money foreign key carries `onDelete`**, so PostgreSQL's `no action` applies: a
 *   Pembayaran that has been partly refunded, and a cash row a refund points at, can never be
 *   deleted out from under this attribution — the same second line of defence
 *   `allocations` records.
 * - **Rows here are never updated and never deleted.** A refund is money that really left the
 *   kas; the compensating entry for a mistaken one is a Koreksi on its cash row plus whatever the
 *   pengurus decide about the money, never an edit here. There is deliberately no service function
 *   that updates or deletes a row of this table.
 * - **No `occurredOn` column.** The day the money moved lives on the one cash row this row points
 *   at, exactly once; `createdAt` here records when the row was typed, the same split every money
 *   table in this schema keeps.
 */

export const refunds = pgTable(
	'refunds',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The verified Pembayaran whose unallocated remainder this refund consumed. */
		paymentId: uuid()
			.notNull()
			.references(() => payments.id),
		/** The one cash expense row this refund is, in the system category "Iuran warga". */
		cashTransactionId: uuid()
			.notNull()
			.references(() => cashTransactions.id),
		/** How much of the payment's remainder was returned, in whole rupiah. Strictly positive. */
		amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** Why the money was returned. Required — a payout with no story is unauditable. */
		reason: text().notNull(),
		/** The superuser who returned it — an account, like `cash_transactions.recordedBy`. */
		refundedBy: text()
			.notNull()
			.references(() => user.id),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// One refund per cash row and one cash row per refund — the enforceable half of "setiap
		// Pengembalian merujuk tepat satu baris kas keluar".
		uniqueIndex('refunds_cash_transaction_id_unique').on(table.cashTransactionId),
		// Every balance read groups this table by payment, exactly as `allocations` is grouped.
		index('refunds_payment_id_idx').on(table.paymentId),
		// A refund is a movement of money: strictly positive, like `cash_transactions_amount_check`.
		check('refunds_amount_check', sql`amount > 0`)
	]
);

/** One row of `refunds`: part of one Pembayaran's remainder returned to its Warga. */
export type Refund = typeof refunds.$inferSelect;

/** A row on its way into `refunds`. */
export type NewRefund = typeof refunds.$inferInsert;
