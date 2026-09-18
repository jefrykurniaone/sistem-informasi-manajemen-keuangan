import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	date,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';
import { residents } from './resident';
import { units } from './unit';

/**
 * `invoices`: the Tagihan — one Unit's obligation for one Periode, with the amount frozen at the
 * moment it was issued. This is the table `docs/spec-iuran-v1.md`'s money invariants are written
 * around: a resident's total tunggakan, a payment's Alokasi, and a Unit's saldo titipan are all
 * read against the rows here.
 *
 * Decisions settled here:
 *
 * - **`period` is `text` in the shape `YYYY-MM`, not a foreign key and not a `date`.** Two things
 *   the ticket's dispatch-time correction settles first: the `periods` table belongs to spec
 *   kas-laporan and is built by #32, after this ticket, so a foreign key to it would block this
 *   migration from ever running; and even once #32 lands, "Periode pada Tagihan adalah nilai,
 *   bukan kunci asing" — a Tagihan's period is a fact about the Tagihan, not a pointer to a row
 *   that manages a cash book's open/locked state, and the two must stay independent so that
 *   locking a cash Period can never retroactively change which invoices exist.
 *
 *   `text` rather than `date` on the first of the month: a period is a calendar *month*, not a
 *   calendar *day*, and a `date` column can only state a month by picking one of its thirty-odd
 *   days to mean it, which invites a bug the moment something writes the 15th instead of the 1st.
 *   `YYYY-MM` says exactly what it means, needs no convention to decode, reads the same in a URL,
 *   a form value, a report heading and a test, and still sorts and range-compares correctly as
 *   plain text because it is fixed-width and zero-padded (`'2026-12' < '2027-01'`).
 *   `invoices_period_shape_check` is the database's own proof that every row holds that shape
 *   rather than trusting every future caller to type it correctly. The one thing `date` would have
 *   given away for free is month arithmetic in SQL; where a later ticket needs a real date out of
 *   a period it is `to_date(period || '-01', 'YYYY-MM-DD')`, written here so nobody invents
 *   something looser. This is the decision `docs/spec-iuran-v1.md` leaves open, and #26 (issuance)
 *   and #32 (kas-laporan) are the two tickets expected to read it.
 * - **`invoices_unit_id_period_unique` is the acceptance criteria's "pasangan unit dan periode pada
 *   tagihan unik, dipaksakan basis data" verbatim.** It is what makes running the issuance job
 *   twice for one month produce one Tagihan rather than two, per `docs/spec-iuran-v1.md`'s
 *   idempotence argument — the database refuses the second insert outright, so nothing between the
 *   job's two runs has to notice and skip it. It is also the only index this table needs for
 *   "every Tagihan of this house": `unit_id` is its leftmost column.
 * - **No `status` column.** `docs/spec-iuran-v1.md:163-165`: "Lunas, sebagian, atau belum bayar
 *   adalah perbandingan antara besaran Tagihan dan jumlah Alokasinya... Tidak ada kolom status yang
 *   bisa tertinggal dari kenyataan." A stored status is exactly the kind of column that can drift
 *   from the allocations that are supposed to justify it; there is nowhere for that drift to
 *   happen if the value is never stored. `allocations_invoice_id_idx` is what makes computing it
 *   cheap — see `allocation.ts`.
 * - **The cancellation marker is `voidedAt` / `voidReason` / `voidedBy`, all nullable, rather than
 *   a `status` value.** `docs/spec-iuran-v1.md:156-158`: cancelling marks the row `void` with a
 *   reason and an actor, and "barisnya tidak pernah dihapus" — there is no delete path for this
 *   table anywhere in this schema. A nullable `voidedAt` doubles as the marker and the instant, the
 *   same shape `posts.publishedAt` and `registrations.reviewedAt` already use in this schema: null
 *   means "not yet", non-null is both "yes" and "since when" in one column, so there is no separate
 *   boolean that could disagree with the timestamp next to it.
 * - **`invoices_void_check` is all-or-nothing across those three columns, which is deliberately
 *   stricter than `registrations_rejection_reason_check` and `complaints_rejection_reason_check`.**
 *   Those two guard a reason hanging off a `status` that already stands on its own, and both of
 *   their doc comments hand "must a reason be typed" to the form. Here the three columns *are* the
 *   marker: the spec defines the operation as marking the row `void` "beserta alasan dan pelakunya"
 *   and this ticket's acceptance criteria repeats it, so a row carrying `voidedAt` alone is not a
 *   cancellation missing some optional colour — it is an obligation that vanished with nothing on
 *   the row saying who removed it or why, on a row that is never deleted and can therefore never be
 *   re-examined any other way. The spec's own reason for refusing to void an invoice that has
 *   absorbed money ("membatalkan bersama alokasinya membuat uang lenyap dari sisi tagihan tanpa
 *   jejak") is the same argument one level down.
 *
 *   The asymmetry is also the cheaper mistake in the direction it can be wrong. Loosening a
 *   constraint later is one `alter table ... drop constraint`; tightening one later is that plus
 *   repairing every row already written that violates it, and there is no way to invent the missing
 *   reason for a cancellation nobody recorded.
 *
 *   Two orderings follow from it, and the ticket that builds cancellation has to know them: one
 *   `update` setting all three columns together satisfies the constraint, and so does clearing all
 *   three; setting `voidedAt` in one statement and the reason in a second does not.
 * - **This table does not enforce "a Tagihan with an Alokasi cannot be voided."**
 *   `docs/spec-iuran-v1.md:156-161` asks for that rule, and for the rejection to carry "a message
 *   naming the step that has to happen first" — wording for a specific caller-facing error, not a
 *   database-level fact. Whether an invoice has any allocations is a question about rows in
 *   `allocations`, a different table this one has no reference to in either direction, so nothing
 *   here can see the answer without a trigger reaching across tables to compute it. That is a
 *   heavier tool than a `CHECK` or a unique index, and the ticket that builds "cancel an invoice" —
 *   not this schema ticket — is where the transaction, the lock, and the exact wording of that
 *   error belong. What this schema *does* contribute is the foreign key in `allocation.ts`, which
 *   carries no `onDelete` and so stops a cancellation implemented as a delete from ever succeeding.
 * - **No aggregate check that the sum of an invoice's allocations never exceeds its `amount`.**
 *   `docs/spec-iuran-v1.md:131-136` asks for that invariant, but a `CHECK` constraint in PostgreSQL
 *   sees only the row it is attached to, never a sum across other rows; enforcing it here would
 *   need the same kind of trigger the previous point declines to add, for the same reason: the
 *   ticket that writes allocations (not this one, which only shapes the tables) is where that
 *   invariant's enforcement belongs.
 * - **`dueDate` is `date`, `issuedAt` is `timestamp` with time zone, and there is no separate
 *   `createdAt`.** `dueDate` is a calendar day — "jatuh tempo tanggal 5", never a time of day — the
 *   same choice `occupancies.startedOn` makes. `issuedAt` already answers "when did this row start
 *   existing": a Tagihan is created by being issued, there is no draft state the way a Post has
 *   one, so a second `createdAt` column would just be a second name for the same instant.
 * - **Nothing here ties `dueDate` to `period`.** "Jatuh tempo tanggal 5" is the issuance job's
 *   policy, not a property of the table: an invoice issued late for a past month, or a due date the
 *   pengurus later agree to move, are both things this shape should survive without a migration.
 *   A constraint saying the two agree could not be written anyway — it would need
 *   `to_char(due_date, 'YYYY-MM')`, and `to_char` is `STABLE` rather than `IMMUTABLE`, which
 *   PostgreSQL refuses inside a `CHECK`.
 * - **`unitId` and `voidedBy` carry no `onDelete`.** A unit is never deleted (see `units.ts`), and
 *   `voidedBy` names a Superuser whose action must keep meaning something even if that account is
 *   ever removed — the same reasoning `complaints.reporterId` and `occupancies.residentId` already
 *   settle in this schema.
 */

export const invoices = pgTable(
	'invoices',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The house this Tagihan is for. */
		unitId: uuid()
			.notNull()
			.references(() => units.id),
		/** The calendar month this Tagihan is for, as `YYYY-MM`. A value, never a foreign key. */
		period: text().notNull(),
		/** The amount owed, frozen at the moment this row was issued. Never changes afterward. */
		amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** The day payment is due. */
		dueDate: date({ mode: 'string' }).notNull(),
		/** When this Tagihan was issued. Also this row's creation instant — there is no draft state. */
		issuedAt: timestamp({ withTimezone: true }).notNull(),
		/** When this Tagihan was cancelled. Null while it stands. The row is never deleted. */
		voidedAt: timestamp({ withTimezone: true }),
		/** Why it was cancelled. Set exactly when `voidedAt` is. */
		voidReason: text(),
		/** Who cancelled it — a Superuser. Set exactly when `voidedAt` is. */
		voidedBy: uuid().references(() => residents.id)
	},
	(table) => [
		// "Pasangan unit dan periode pada tagihan unik" — the idempotence key for the issuance job,
		// and the index "every Tagihan of this house" reads through its leftmost column.
		uniqueIndex('invoices_unit_id_period_unique').on(table.unitId, table.period),
		check('invoices_amount_check', sql`amount >= 0`),
		check('invoices_period_shape_check', sql`period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
		// A cancellation is the whole triple or none of it. See the doc comment for why this is
		// stricter than the rejection-reason checks elsewhere in this schema.
		check(
			'invoices_void_check',
			sql`(voided_at is null and void_reason is null and voided_by is null) or (voided_at is not null and void_reason is not null and voided_by is not null)`
		)
	]
);

/** One row of `invoices`: one Unit's Tagihan for one Periode. */
export type Invoice = typeof invoices.$inferSelect;

/** A row on its way into `invoices`. */
export type NewInvoice = typeof invoices.$inferInsert;
