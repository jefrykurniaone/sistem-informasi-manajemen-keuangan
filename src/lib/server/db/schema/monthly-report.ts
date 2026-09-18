import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';
import { user } from './auth';
import type { CashCategoryType } from './cash-category';
import { periods } from './period';

/**
 * `monthly_reports`: the Laporan Bulanan — one numbered publication of one Periode, with its
 * numbers frozen at the moment of publication so that revision 1 stays readable, unchanged, after
 * revision 2 exists. `docs/spec-kas-laporan-v1.md`: "kalau laporan ditimpa diam-diam, penguncian
 * periode kehilangan seluruh manfaatnya."
 *
 * Decisions settled here:
 *
 * - **The frozen numbers are typed columns for the eight fixed figures, plus one `jsonb` column
 *   for the per-category breakdown — not one `jsonb` snapshot, and not a child table.** This is
 *   the shape decision the ticket leaves to this file, and the argument runs in both directions:
 *
 *   *Against one all-`jsonb` snapshot*: the database could then guard nothing — no `NOT NULL` on
 *   any figure, no sign checks, no arithmetic identity — and this schema's whole discipline is
 *   that what the database can guard, it guards. The figures a report always carries are fixed by
 *   the spec (user stories 18 and 19: saldo awal, pemasukan, pengeluaran, saldo akhir, and the
 *   three dues-summary numbers), so columns lose no flexibility that actually exists. A `jsonb`
 *   number is also a weaker container for money than `bigint`: nothing stops a fraction or a
 *   float-shaped value getting in.
 *
 *   *Against a child table for the breakdown*: the per-category lines are the one genuinely
 *   variable-length part — categories are runtime master data (user story 1: a new category must
 *   not need a deploy) — so they cannot be columns; but a `monthly_report_lines` table would be a
 *   new table with no `CONTEXT.md` entry (the glossary says a Laporan Bulanan is one thing), and
 *   it would buy queryability nothing needs. Frozen numbers are a *document*: read back whole,
 *   rendered, never filtered or summed in SQL — every live figure is always recomputed from
 *   `cash_transactions`, and the frozen copy exists only so an already-published revision can be
 *   shown again exactly as residents first read it. Relational shape earns its cost when rows are
 *   queried against each other; a document that is only ever displayed does not pay that cost
 *   back, and `jsonb` states "this is a sealed payload" in the schema itself.
 *
 * - **`monthly_reports_balance_check` is the arithmetic identity `closing = opening + income −
 *   expense`.** It is the one cross-column fact of the frozen document the database can state, and
 *   it is worth stating: a published report whose own four headline numbers do not add up is wrong
 *   no matter what the service computed, and this check makes that row unwritable rather than
 *   discoverable. The totals also carry sign checks — `totalIncome` and `totalExpense` are each a
 *   sum of strictly-positive amounts (see `cash_transactions_amount_check`), so a negative total
 *   is impossible data, as is a negative count of houses or a negative collected sum. The two
 *   *balances* carry no sign check on purpose: an opening balance is a net position, and a history
 *   that records expenses dated before the opening-balance transaction's date is legal data that
 *   could make one negative; the identity check is the real guarantee.
 *
 * - **What one breakdown line freezes: `categoryId`, `name`, `type`, `total`.** The name, because
 *   a superuser may rename a category (user story 1) and the frozen report must keep showing what
 *   residents read at the time. The type, because a non-system category's type is editable, and
 *   the line's direction decides which section of the report it renders in. The id, so user story
 *   20's drill-down from a report line to the live transactions inside it still has its anchor.
 *   One line is one category in one direction: a Koreksi is an opposite-type row in the same
 *   category (see `cash-transaction.ts`), so a correction surfaces in the opposite section of the
 *   same category rather than silently netting away — the spec's "buku kas menampilkan keduanya"
 *   carried up to the report. Line totals are therefore sums of positive amounts.
 *
 * - **The spec's "dua angka yang berbeda" are both here, as different columns.** `duesCollected`
 *   (with `duesUnitsPaid` and `duesUnitsUnpaid`) is user story 19's summary of *this Periode's
 *   invoices* — how the month's billing stands, fed by allocations, regardless of when cash
 *   arrived. Cash that arrived *during* the month from dues is a different number, and it already
 *   has its place: the `dues` category's income line inside `categoryBreakdown`, dated by
 *   `occurredOn`. A January invoice paid on 20 February raises February's breakdown line and
 *   January's `duesCollected` on its *next* revision only — the published January report never
 *   moves. Hiding either number is what the spec forbids.
 *
 * - **`duesUnitsPaid` and `duesUnitsUnpaid` are `integer`, not `bigint`** — counts of houses, not
 *   money — and they are the *entire* dues privacy surface: three numbers, no names, no unit
 *   identifiers anywhere in this table's shape. The frozen payload structurally cannot violate
 *   "privasi penunggak"; the admin-only tunggakan list is a live screen, not a report column.
 *
 * - **`monthly_reports_revision_reason_check` is two-sided: a reason is required above revision 1
 *   and forbidden on it.** The required half is the ticket's own demand ("alasan revisi untuk
 *   revisi kedua dan seterusnya" — user story 16 shows it to every resident, so a revision without
 *   one is a hole in the public record, not missing colour; the same reasoning made
 *   `invoices_void_check` all-or-nothing). The forbidden half follows
 *   `payments_verification_check`: revision 1 revises nothing, so a reason on it is a statement
 *   about an event that never happened. Consequence for #35: publishing a revision is one insert
 *   carrying `revision` and `revisionReason` together.
 *
 * - **`revision` starts at 1 (`monthly_reports_revision_check`), and `(periodId, revision)` is
 *   unique** — the acceptance criteria's "pasangan periode dan nomor revisi unik", which also
 *   makes the unique index this table's read path: every revision of one Periode, leftmost column
 *   first. That revisions are *gapless and sequential* is a cross-row fact the database cannot see
 *   from one row; #35 owns it (and the unique index turns any race between two publishers into an
 *   error rather than a duplicate).
 *
 * - **`publishedBy` references `user.id`, not `residents.id`** — the orchestrator's landed
 *   decision, following `invitations.createdBy` and `audit_log.actorId`: an actor is an account,
 *   an admin need not be a resident. No `onDelete`, and none on `periodId` either: unlocking or
 *   even deleting nothing ever cascades into a publication residents have read.
 *
 * - **Nothing here references `cash_transactions`, in either direction.** Frozen means frozen: a
 *   report is derived from the cash book at one instant and then cut loose, so no foreign key ties
 *   it to rows whose later corrections must not touch it. That the stored totals agree with the
 *   breakdown lines, and both with the cash book as of publication, is #35's single computation —
 *   a `CHECK` cannot aggregate a `jsonb` array (set-returning functions are not allowed there),
 *   and a constraint reaching into another table is the trigger this schema declines everywhere.
 */

/**
 * One frozen line of a report's per-category breakdown: one Kategori Kas in one direction, summed
 * over the report's Periode as of publication. Stored inside `monthly_reports.categoryBreakdown`.
 */
export interface MonthlyReportCategoryLine {
	/** The `cash_categories.id` behind this line — user story 20's drill-down anchor. */
	readonly categoryId: string;
	/** The category's display name as it read at publication. Never updated on a later rename. */
	readonly name: string;
	/** The direction of the transactions summed here — which report section the line renders in. */
	readonly type: CashCategoryType;
	/** The sum of this category's transactions in this direction, in whole rupiah. Never negative. */
	readonly total: Rupiah;
}

export const monthlyReports = pgTable(
	'monthly_reports',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The Periode this report publishes. */
		periodId: uuid()
			.notNull()
			.references(() => periods.id),
		/** 1 for the first publication, 2 and up for revisions. Unique per Periode. */
		revision: integer().notNull(),
		/** When this revision was published — also the instant the frozen numbers were computed at. */
		publishedAt: timestamp({ withTimezone: true }).notNull(),
		/** The account that published it. */
		publishedBy: text()
			.notNull()
			.references(() => user.id),
		/** Why a revision exists, shown to every resident. Null on revision 1, required above it. */
		revisionReason: text(),
		/** The cash balance at the start of the month: everything dated before it, summed. */
		openingBalance: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** All income dated inside the month, frozen at publication. */
		totalIncome: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** All expenses dated inside the month, frozen at publication. */
		totalExpense: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** The balance at the end of the month. Always opening + income − expense, enforced below. */
		closingBalance: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** Iuran collected toward this Periode's invoices — not the month's cash-in. See doc comment. */
		duesCollected: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** How many houses had fully paid this Periode's invoice at publication. A count, never names. */
		duesUnitsPaid: integer().notNull(),
		/** How many houses had not. The whole tunggakan surface a resident ever sees: a number. */
		duesUnitsUnpaid: integer().notNull(),
		/** The frozen per-category lines. A sealed document payload — see the doc comment for shape. */
		categoryBreakdown: jsonb().$type<MonthlyReportCategoryLine[]>().notNull()
	},
	(table) => [
		// "Pasangan periode dan nomor revisi unik" — and the read path for one Periode's revisions.
		uniqueIndex('monthly_reports_period_id_revision_unique').on(table.periodId, table.revision),
		check('monthly_reports_revision_check', sql`revision >= 1`),
		// Two-sided: forbidden on revision 1, required above it. See the doc comment.
		check(
			'monthly_reports_revision_reason_check',
			sql`(revision = 1 and revision_reason is null) or (revision > 1 and revision_reason is not null)`
		),
		// The frozen headline numbers must add up, or the row is unwritable.
		check(
			'monthly_reports_balance_check',
			sql`closing_balance = opening_balance + total_income - total_expense`
		),
		check('monthly_reports_total_income_check', sql`total_income >= 0`),
		check('monthly_reports_total_expense_check', sql`total_expense >= 0`),
		check('monthly_reports_dues_collected_check', sql`dues_collected >= 0`),
		check('monthly_reports_dues_units_paid_check', sql`dues_units_paid >= 0`),
		check('monthly_reports_dues_units_unpaid_check', sql`dues_units_unpaid >= 0`)
	]
);

/** One row of `monthly_reports`: one published revision of one Periode's Laporan Bulanan. */
export type MonthlyReport = typeof monthlyReports.$inferSelect;

/** A row on its way into `monthly_reports`. */
export type NewMonthlyReport = typeof monthlyReports.$inferInsert;
