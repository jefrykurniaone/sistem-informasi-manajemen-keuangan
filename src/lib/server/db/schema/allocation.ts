import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';
import { invoices } from './invoice';
import { payments } from './payment';

/**
 * `allocations`: the Alokasi — how much of one Pembayaran answers one Tagihan. This is the join
 * that `docs/spec-iuran-v1.md:131-136` insists on keeping separate from the payment itself: one
 * deposit can pay several months, several deposits can chip away at one month, and money that
 * answers nothing yet simply has no row here and is therefore saldo titipan.
 *
 * Two derived numbers are read entirely out of this table, and neither is stored anywhere:
 *
 * - **A Tagihan's status** is its `amount` against the sum of its allocations
 *   (`docs/spec-iuran-v1.md:163-165`).
 * - **A Unit's saldo titipan** is the sum of its verified payments less the sum of their
 *   allocations (`docs/spec-iuran-v1.md:138-140`).
 *
 * Decisions settled here:
 *
 * - **`allocations_payment_id_invoice_id_unique` is the acceptance criteria's "pasangan pembayaran
 *   dan tagihan unik".** One payment answers one invoice in one row, so the amount that payment
 *   contributed to that invoice is a single number rather than something that has to be summed
 *   across rows that could disagree about what they are. Allocating more later is an update to the
 *   one row, not a second row beside it.
 * - **One extra index, on `invoiceId` alone.** The unique index above already serves every read
 *   that starts from a payment, `payment_id` being its leftmost column. It cannot serve the read
 *   that starts from an invoice, and that is the one the whole spec leans on: an invoice has no
 *   stored status, so *every* screen that shows whether a Tagihan is lunas sums this table by
 *   `invoice_id`. Leaving it out would make the choice not to store a status cost a sequential scan
 *   per invoice.
 * - **Neither foreign key carries `onDelete`, so PostgreSQL's `no action` applies, and that is the
 *   point rather than a default nobody picked.** This is the opposite choice from
 *   `complaint_attachments`, which cascades because an attachment means nothing without its
 *   complaint. An allocation is money. `docs/spec-iuran-v1.md:156-161` refuses to cancel a Tagihan
 *   that has absorbed a payment precisely because "membatalkan bersama alokasinya membuat uang
 *   lenyap dari sisi tagihan tanpa jejak, dan sejak saat itu saldo kas tidak lagi sama dengan
 *   jumlah alokasi" — a cascade from `invoices` would be that exact deletion, performed silently by
 *   the database. With `no action`, an attempt to delete an invoice that has allocations is refused
 *   by PostgreSQL itself, which is a second line behind the service-layer rule rather than a
 *   replacement for it: the service still owns the check, the transaction and the error message
 *   naming what has to be released first.
 *
 *   The same holds from the payment side, where it should never fire at all — a verified payment is
 *   never deleted, and a pending one has no allocations because allocations are created by
 *   verification.
 * - **Releasing an allocation is deleting the row, and that is deliberate.** User story 22 asks for
 *   released money to become saldo titipan again, and because saldo titipan is *defined* as the
 *   payments-minus-allocations difference, removing the row restores it exactly, with no second
 *   write that could be skipped and no compensating column that could be wrong. This is the one
 *   table in the iuran schema whose rows are deleted on purpose; every other table here marks
 *   instead. The difference is that the fact worth keeping about a release lives in the audit log
 *   (`docs/spec-iuran-v1.md:171-172` names "pelepasan alokasi" explicitly), while a released
 *   allocation left in place would have to be excluded by every one of the two sums above and would
 *   become wrong the first time one of them forgot.
 * - **Nothing here checks that an allocation fits inside its payment or its invoice.** Both are
 *   sums across other rows, and a PostgreSQL `CHECK` sees only the row it is attached to. Both
 *   invariants — an invoice never over-allocated, a payment never over-spent — belong to the
 *   verification transaction #28 builds, which is where the rows are locked and the arithmetic is
 *   done. The `CHECK` below is the part a single row can answer for: the amount is a whole number
 *   of rupiah and is not negative.
 * - **`createdAt` is on the row even though a payment already has `verifiedAt`.** The two are the
 *   same instant for allocations made by verification, and different ones for an allocation written
 *   later — a release followed by a re-allocation, or saldo titipan consumed by next month's
 *   issuance. User story 25 asks for a Tagihan's full history, and that history is wrong if every
 *   allocation is dated from its payment.
 */

export const allocations = pgTable(
	'allocations',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The Pembayaran this money came from. */
		paymentId: uuid()
			.notNull()
			.references(() => payments.id),
		/** The Tagihan it answers. */
		invoiceId: uuid()
			.notNull()
			.references(() => invoices.id),
		/** How much of the payment this allocation applies to the invoice, in whole rupiah. */
		amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// "Pasangan pembayaran dan tagihan unik". Its leftmost column also serves every read that
		// starts from a payment, which is why there is no separate index on `payment_id`.
		uniqueIndex('allocations_payment_id_invoice_id_unique').on(table.paymentId, table.invoiceId),
		// A Tagihan has no stored status, so every screen showing one sums this table by invoice.
		index('allocations_invoice_id_idx').on(table.invoiceId),
		check('allocations_amount_check', sql`amount >= 0`)
	]
);

/** One row of `allocations`: part of one Pembayaran answering one Tagihan. */
export type Allocation = typeof allocations.$inferSelect;

/** A row on its way into `allocations`. */
export type NewAllocation = typeof allocations.$inferInsert;
