import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * `periods`: the Periode — one calendar month of the cash book, either open or locked. Locking is
 * what gives a published Laporan Bulanan its meaning: once residents have read numbers for a
 * month, no transaction dated inside it may appear until a superuser unlocks it with a reason.
 *
 * Decisions settled here:
 *
 * - **`year` and `month` are two integer columns, not a `YYYY-MM` text and not a `date`.** The
 *   acceptance criteria names them ("tahun, bulan... pasangan tahun dan bulan unik"), and the
 *   operations this table exists for are month arithmetic: the previous period whose closing
 *   balance opens this one, the next month the report job runs for. Those are integer steps on
 *   `(year, month)`, not string surgery. Storing the `YYYY-MM` text as well would be the same fact
 *   in a second representation on the same row, free to disagree with the first; it is derived
 *   instead, below. (`invoice.ts` chose `YYYY-MM` text for `invoices.period` for its own reasons —
 *   a Tagihan's period is a value, a fact about the document — and that decision stands untouched.)
 * - **How `invoices.period` matches a `periods` row — the bridge #36 must copy, not reinvent.**
 *   `invoices.period` is `text` shaped `YYYY-MM`, zero-padded, enforced by
 *   `invoices_period_shape_check`, and it is a value, never a foreign key to this table: locking a
 *   cash Periode must never retroactively change which invoices exist. The two meet by derivation,
 *   in whichever direction the caller stands:
 *
 *   - TypeScript, from a row here: `` `${year}-${String(month).padStart(2, '0')}` ``.
 *   - SQL, from a row here: `format('%s-%s', year, to_char(month, 'FM00'))` — or, matching the
 *     other way, `periods.year = split_part(invoices.period, '-', 1)::int and
 *     periods.month = split_part(invoices.period, '-', 2)::int`, which is safe precisely because
 *     the shape check guarantees zero-padding and range.
 * - **`status` is text with a check constraint, not an enum** — `payments.status` and
 *   `posts.status` give the reason. The two values (`open`, `locked`) are the glossary's, set by
 *   the orchestrator's wave-11 correction in `CONTEXT.md`.
 * - **No `lockedAt`, `lockedBy` or unlock reason columns.** The status is the only fact other
 *   rules read (may this transaction be inserted, may this report publish). Who locked, who
 *   unlocked, when and why are history of *operations*, and
 *   `docs/spec-kas-laporan-v1.md` routes them to the audit log explicitly ("penerbitan laporan,
 *   pembukaan kunci periode ... masuk audit log"); the publication instant additionally lives on
 *   the report row itself (`monthly_reports.publishedAt`). A status column plus its own private
 *   history would be a second audit log with one table's scope.
 * - **No check on `year`.** The criteria constrains `month` (1..12) and `status`; inventing a year
 *   range here would be a rule this ticket was not asked for, the same restraint
 *   `dues_rates_amount_check` shows about a zero Tarif.
 * - **No seed rows and no "create twelve months ahead" job.** A Periode row comes into being when
 *   something first needs it — recording a transaction in a new month, publishing its report —
 *   and which service creates it (and races for it) is #34/#35's decision, made where the
 *   transaction boundary is.
 * - **Refusing transactions in a locked period is a service rule.** A `CHECK` on
 *   `cash_transactions` cannot see this table's rows; see `cash-transaction.ts`, which settles
 *   that jointly with this file.
 */

/**
 * What can be true of a Periode. Set by the orchestrator's glossary correction on this ticket —
 * see the "kata yang bukan benda dan tidak punya tabel" table in `CONTEXT.md`.
 *
 * - `open`: transactions dated inside the month are accepted.
 * - `locked`: they are refused, because a Laporan Bulanan for the month has been published. Only a
 *   superuser may reopen it, with a reason that goes to the audit log.
 */
export const PERIOD_STATUS = {
	open: 'open',
	locked: 'locked'
} as const;

/** The status of one Periode. */
export type PeriodStatus = (typeof PERIOD_STATUS)[keyof typeof PERIOD_STATUS];

/** Every period status there is, for a test — or a screen — that wants to walk them. */
export const PERIOD_STATUSES: readonly PeriodStatus[] = Object.values(PERIOD_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = PERIOD_STATUSES.map((status) => `'${status}'`).join(', ');

export const periods = pgTable(
	'periods',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The calendar year, as a plain integer such as 2026. */
		year: integer().notNull(),
		/** The calendar month, 1 through 12, enforced below. */
		month: integer().notNull(),
		status: text().$type<PeriodStatus>().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// "Pasangan tahun dan bulan unik" — one Periode per calendar month, ever.
		uniqueIndex('periods_year_month_unique').on(table.year, table.month),
		check('periods_month_check', sql`month between 1 and 12`),
		check('periods_status_check', sql.raw(`status in (${STATUS_LIST})`))
	]
);

/** One row of `periods`: one calendar month of the cash book. */
export type Period = typeof periods.$inferSelect;

/** A row on its way into `periods`. */
export type NewPeriod = typeof periods.$inferInsert;
