import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { civilMonthOf } from '#lib/time.ts';
import type { DatabaseWriter } from '../../authz';
import type { Database } from '../../db';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	type CashCategoryType
} from '../../db/schema/cash-category';
import { cashTransactions } from '../../db/schema/cash-transaction';
import { invoices } from '../../db/schema/invoice';
import type { MonthlyReportCategoryLine } from '../../db/schema/monthly-report';
import type { Clock } from '../../ports/clock';
import { cashBalanceBefore, monthDayRange, type MonthDayRange } from '../cash/balance';
import { INVOICE_STATUS, invoiceStandings } from '../dues/invoice-standing';

/**
 * Working out what one Periode's Laporan Bulanan says, from the buku kas and the Tagihan of that
 * month — `docs/spec-kas-laporan-v1.md`'s "laporan bulanan dihasilkan dari buku kas, bukan
 * diketik". Nothing here writes, and nothing here is stored: this module answers the same question
 * for a preview an admin opens on the fifteenth (user story 12) and for the publication that freezes
 * the answer (user story 13), which is what makes a preview worth looking at.
 *
 * ## What is frozen at publication, and what is recomputed at read
 *
 * This is the decision the whole ticket turns on, so it is written once, here.
 *
 * **Frozen**: every figure `ReportFigures` carries — the four headline numbers, the three dues
 * numbers, and every per-category line with its `categoryId`, `name`, `type` and `total`.
 * `./publication.ts` copies the whole of it into one `monthly_reports` row at the instant it
 * publishes, and a published revision is rendered from that row and from nothing else, forever. No
 * screen recomputes a published figure, because a recomputed figure is a figure that can change
 * after somebody has read it, which is the exact failure `docs/spec-kas-laporan-v1.md`'s problem
 * statement describes ("laporan yang sudah dibagikan bisa diketik ulang dengan angka berbeda").
 *
 * **Recomputed**: two things, and only two.
 *
 * 1. **The admin preview.** It is not a report; it is this month as it stands right now. It is
 *    recomputed on every load precisely so that it is never mistaken for a publication.
 * 2. **The rows behind a category line, when a resident drills into one** (user story 20). They have
 *    to be live: `src/lib/server/db/schema/monthly-report.ts` records that nothing in
 *    `monthly_reports` references `cash_transactions` in either direction, "karena beku berarti
 *    beku", so a published revision holds a per-category *total* and no list of rows. A drill-down
 *    therefore shows the cash book as it is now, beside the frozen total the revision published. The
 *    two agree while the month stays locked, which is every moment except the window between a
 *    superuser reopening a month and the next revision going out — and in that window the
 *    disagreement is the true statement, not a bug: it is what "there is something in this month
 *    that the report you are reading does not have yet" looks like.
 *    `./resident-payload.ts` shows both numbers rather than picking one.
 *
 * Nothing else is recomputed. In particular `duesUnitsPaid` and `duesUnitsUnpaid` are frozen
 * although the underlying Tagihan go on being paid afterwards: a January report that silently
 * improved its own lunas count every time somebody paid in March would be a different document each
 * time it was opened.
 *
 * ## Which calendar the month boundary is read against — `Asia/Jakarta`
 *
 * Most of a report does not have the question at all:
 *
 * - **Which transactions fall inside the month is not a clock question.** `cash_transactions.occurredOn`
 *   is a `date`, and `monthDayRange` in `../cash/balance.ts` turns `YYYY-MM` into the first and last
 *   `YYYY-MM-DD` it spans. No instant is converted, so no zone can be wrong.
 * - **Which Tagihan belong to the Periode is not one either.** `invoices.period` is already `YYYY-MM`.
 *
 * What is left is the two places an *instant* becomes a civil date: "which month is the periode
 * berjalan an admin previews by default", and the day lunas or belum lunas is judged on. Both read
 * the complex's own calendar from `src/lib/time.ts`, the one every other screen reads too: the month
 * is `civilMonthOf(clock.now())`, and the day is the one `invoiceStandings` in
 * `../dues/invoice-standing.ts` reads from the same clock. The day written on a Transaksi Kas was
 * typed by an admin sitting in the complex, so the days this report adds up are already Jakarta days;
 * a due date was written in Jakarta's calendar by `dueDateOfPeriod`; and a default that read UTC
 * would, for the first seven hours of the first day of every month local, offer an admin the
 * *previous* month as "periode berjalan", at exactly the turn of the month, which is when a
 * publication is most likely to happen.
 *
 * ## What this module reads through `../cash/balance.ts`, and what it reads itself
 *
 * The two pieces of cash arithmetic a report shares with the buku kas come from the cash book's read
 * module, not from a copy here. `cashBalanceBefore` is the signed total that becomes a report's
 * opening balance, so the sign convention (income adds, everything else subtracts) is written once,
 * as `SIGNED_TOTAL` there. `monthDayRange` is the span of days a month covers, so a report and a
 * filtered buku kas select the same rows for the same month by construction. Until #315 both were
 * restated here, because the append-only test pinned that module's export list; it now pins the
 * writer's surface only (`../cash/writer.ts`).
 *
 * `cashBook` itself is still not called. It is an Admin's screen, guarded by
 * `ACTION.recordCashTransactions`, and a report is read by every Warga. What this module still
 * queries on its own are the shapes only a report has: one total per category per direction, and
 * the drill-down rows of one category. Neither carries sign arithmetic; each sums `amount` within one
 * direction. `tests/unit/report-composition.test.ts` keeps comparing those answers to `cashBook`'s
 * for the same month, so the day the two readers disagree about which rows a month holds, a test
 * says so by name.
 */

/**
 * Every figure a Laporan Bulanan carries, in the shape `monthly_reports` stores them — so that
 * publishing is one spread into one insert, and the row the database checks is the object this
 * module computed rather than a transcription of it.
 */
export interface ReportFigures {
	/** The cash balance at the start of the month: everything dated before it, signed and summed. */
	readonly openingBalance: Rupiah;
	/** Every `income` row dated inside the month. Never negative. */
	readonly totalIncome: Rupiah;
	/** Every `expense` row dated inside the month. Never negative. */
	readonly totalExpense: Rupiah;
	/** `openingBalance + totalIncome − totalExpense`, which `monthly_reports_balance_check` re-checks. */
	readonly closingBalance: Rupiah;
	/** Iuran allocated to *this Periode's* Tagihan, whenever the money arrived. See the doc comment. */
	readonly duesCollected: Rupiah;
	/** How many houses have fully paid this Periode's Tagihan. A count, never a name. */
	readonly duesUnitsPaid: number;
	/** How many have not. The whole tunggakan surface a warga ever sees on a report. */
	readonly duesUnitsUnpaid: number;
	/** One line per Kategori Kas per direction, ordered by name then direction. */
	readonly categoryBreakdown: readonly MonthlyReportCategoryLine[];
}

/**
 * The calendar month the complex is in right now, as `YYYY-MM` — the "periode berjalan" user story
 * 12 asks an admin to be able to preview. Read in the complex's own calendar by `civilMonthOf`; see
 * this module's doc comment.
 */
export function currentReportPeriod(clock: Clock): string {
	return civilMonthOf(clock.now());
}

/**
 * Every figure of one Periode's Laporan Bulanan, worked out from the buku kas and that month's
 * Tagihan as they stand at this instant.
 *
 * **Takes no caller and checks no permission**, the shape `listActiveCashCategories` and
 * `isDateInLockedPeriod` already have: the two callers are an admin preview guarded by
 * `ACTION.publishReports` and the publication itself, which has checked the same action before
 * opening its transaction.
 *
 * It takes a `DatabaseWriter` so that publication can compute inside the transaction holding the
 * Periode's row lock. That is not a convenience: `requireOpenPeriodFor` takes `for share` on the
 * same row, so once the publishing transaction holds `for update` no recording dated inside this
 * month can commit until the report is written — and every one that committed earlier is visible to
 * the statements below, because READ COMMITTED takes a fresh snapshot per statement. Computing
 * outside the transaction would leave exactly the gap the lock exists to close.
 *
 * The one gap the lock does **not** close is stated rather than hidden: a Transaksi Kas dated in an
 * *earlier, still open* month can commit while this runs, and it would move this report's
 * `openingBalance`. No lock in this design covers that, and none should — a frozen report is a
 * snapshot of the book at one instant by construction (`src/lib/server/db/schema/monthly-report.ts`),
 * and the answer to a month that changed after its report went out is a revision, which is the
 * mechanism this whole feature is.
 *
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 */
export async function composeReportFigures(
	writer: DatabaseWriter,
	clock: Clock,
	period: string
): Promise<ReportFigures> {
	const range = monthDayRange(period);
	// Sequential, not `Promise.all`: `writer` is the caller's own transaction client when publication
	// calls this (see the doc comment above), and `pg`'s deprecation warning is exactly what firing
	// more than one query at once on the same client does, removed outright in `pg@9`, per #231. The
	// order here is the order the three used to run in, so the figures they produce do not change.
	const openingBalance = await cashBalanceBefore(writer, range.from);
	const categoryBreakdown = await categoryLines(writer, range);
	const dues = await duesSummaryFor(writer, clock, period);

	const totalIncome = totalOfType(categoryBreakdown, CASH_CATEGORY_TYPE.income);
	const totalExpense = totalOfType(categoryBreakdown, CASH_CATEGORY_TYPE.expense);
	return {
		openingBalance,
		totalIncome,
		totalExpense,
		// Derived, never queried a second time. `monthly_reports_balance_check` re-states this
		// identity in SQL, so a row whose four headline numbers do not add up cannot be written — but
		// computing the closing balance from the other three is what makes the check a confirmation
		// rather than a trap the service has to hope it passes.
		closingBalance: rupiah(openingBalance + totalIncome - totalExpense),
		duesCollected: dues.collected,
		duesUnitsPaid: dues.unitsPaid,
		duesUnitsUnpaid: dues.unitsUnpaid,
		categoryBreakdown
	};
}

/** One transaction inside one Kategori Kas, as a resident drilling into a report line reads it. */
export interface CategoryTransaction {
	readonly id: string;
	/** The day money moved, as `YYYY-MM-DD`. */
	readonly occurredOn: string;
	/** `income` or `expense`. Opposes the category's own type exactly when this row is a Koreksi. */
	readonly type: CashCategoryType;
	/** The keterangan — or, on a Koreksi, the alasan. */
	readonly description: string;
	/** How much moved, always positive. */
	readonly amount: Rupiah;
	/** True when this row reverses an earlier one, which is what makes a Koreksi visible. */
	readonly isCorrection: boolean;
}

/** One Kategori Kas's month, and the two directions its rows add up to. */
export interface CategoryTransactions {
	/** Oldest first, in the same order `cashBook` returns lines in. */
	readonly entries: readonly CategoryTransaction[];
	/** The sum of the `income` rows above. Never negative. */
	readonly incomeTotal: Rupiah;
	/** The sum of the `expense` rows above. Never negative. */
	readonly expenseTotal: Rupiah;
}

/**
 * Every Transaksi Kas of one Kategori Kas dated inside one calendar month, with the two directional
 * totals a report's frozen breakdown lines are the published copy of — user story 20's drill-down.
 *
 * **It carries no person and no file.** `CashBookEntry` has `recordedByName` and `attachmentKey`;
 * this shape deliberately has neither. The recorder is an account, and a receipt photo is a picture
 * of a piece of paper that may well have somebody's name on it — both belong on the admin screen
 * that is already guarded by `ACTION.recordCashTransactions`, and neither is anything user story 20
 * asks a warga to see. What is left is the four facts that let a resident check a big number: when,
 * what for, how much, and which direction.
 *
 * There is no running balance either. A running total inside one category across one month is not a
 * balance anybody could reconcile against a bank statement — the two totals above are what a report
 * line is — and a column headed "saldo" meaning a third thing is exactly the drift
 * `../cash/balance.ts` refuses.
 *
 * **Takes no caller and checks no permission**, the shape `listActiveCashCategories` and
 * `isDateInLockedPeriod` already have: the screen around it is guarded by whatever it needs, and
 * **deciding who may see which category is the caller's job**, not this function's.
 * `./resident-payload.ts` is that caller, and it refuses the "Iuran warga" category before it ever
 * gets here.
 *
 * The ordering is `occurredOn`, then `createdAt`, then `id` — the same three `cashBook` documents,
 * so that a drill-down and the buku kas list one category's month in the same order.
 *
 * @throws {TypeError} when `month` is not a calendar month written as `YYYY-MM`.
 */
export async function transactionsInCategory(
	db: Database,
	month: string,
	categoryId: string
): Promise<CategoryTransactions> {
	const range = monthDayRange(month);
	const rows = await db
		.select({
			id: cashTransactions.id,
			occurredOn: cashTransactions.occurredOn,
			type: cashTransactions.type,
			description: cashTransactions.description,
			amount: cashTransactions.amount,
			correctionOf: cashTransactions.correctionOf
		})
		.from(cashTransactions)
		.where(
			and(
				eq(cashTransactions.categoryId, categoryId),
				gte(cashTransactions.occurredOn, range.from),
				lte(cashTransactions.occurredOn, range.to)
			)
		)
		.orderBy(
			asc(cashTransactions.occurredOn),
			asc(cashTransactions.createdAt),
			asc(cashTransactions.id)
		);

	const entries = rows.map((row): CategoryTransaction => ({
		id: row.id,
		occurredOn: row.occurredOn,
		type: row.type,
		description: row.description,
		amount: row.amount,
		isCorrection: row.correctionOf !== null
	}));
	return {
		entries,
		incomeTotal: directionTotal(entries, CASH_CATEGORY_TYPE.income),
		expenseTotal: directionTotal(entries, CASH_CATEGORY_TYPE.expense)
	};
}

/** The sum of every entry moving in one direction. Positive, because `amount` always is. */
function directionTotal(entries: readonly CategoryTransaction[], type: CashCategoryType): Rupiah {
	return rupiah(
		entries.reduce((total, entry) => (entry.type === type ? total + entry.amount : total), 0)
	);
}

/**
 * One line per Kategori Kas per direction, summed over the month.
 *
 * Grouped by the **transaction's** `type` rather than the category's, which is what makes a Koreksi
 * land in the opposite section of the same category instead of quietly netting the original away —
 * `src/lib/server/db/schema/monthly-report.ts` settles that, and the spec's "buku kas menampilkan
 * keduanya" is the sentence it carries up to the report. The name comes from `cash_categories` as it
 * reads right now and is frozen with the line, because a superuser may rename a category afterwards.
 *
 * The headline `totalIncome` and `totalExpense` are then sums of these lines rather than two more
 * aggregates over the same rows. One query, one set of rows: the breakdown and the totals cannot
 * disagree, whatever a filter or a join later gets wrong.
 */
async function categoryLines(
	writer: DatabaseWriter,
	range: MonthDayRange
): Promise<readonly MonthlyReportCategoryLine[]> {
	const rows = await writer
		.select({
			categoryId: cashTransactions.categoryId,
			name: cashCategories.name,
			type: cashTransactions.type,
			// `::text` and `coalesce` for the reason `SIGNED_TOTAL` in `../cash/balance.ts` gives:
			// PostgreSQL widens `sum(bigint)` to `numeric`, which the driver hands back as a string.
			total: sql<string>`coalesce(sum(${cashTransactions.amount}), 0)::text`
		})
		.from(cashTransactions)
		.innerJoin(cashCategories, eq(cashTransactions.categoryId, cashCategories.id))
		.where(
			and(gte(cashTransactions.occurredOn, range.from), lte(cashTransactions.occurredOn, range.to))
		)
		.groupBy(cashTransactions.categoryId, cashCategories.name, cashTransactions.type)
		.orderBy(asc(cashCategories.name), asc(cashTransactions.type));

	return rows.map((row) => ({
		categoryId: row.categoryId,
		name: row.name,
		type: row.type,
		total: rupiah(Number(row.total))
	}));
}

/** The sum of every breakdown line moving in one direction. Positive, because `amount` always is. */
function totalOfType(lines: readonly MonthlyReportCategoryLine[], type: CashCategoryType): Rupiah {
	return rupiah(
		lines.reduce((total, line) => (line.type === type ? total + line.total : total), 0)
	);
}

/** The three numbers user story 19 asks for, about this Periode's Tagihan rather than its cash. */
interface DuesSummary {
	readonly collected: Rupiah;
	readonly unitsPaid: number;
	readonly unitsUnpaid: number;
}

/**
 * This Periode's Tagihan, summarised: how much has been allocated to them, how many houses have
 * fully paid, and how many have not.
 *
 * **This is not the month's cash-in from iuran, and the difference is the spec's own "dua angka yang
 * berbeda".** A January Tagihan settled on 20 February raises *January's* `duesCollected` — the
 * money answers January's obligation whenever it arrived — while the cash itself appears as a
 * February `income` row in the `dues` category's breakdown line, because `occurredOn` is the day
 * money moved. `docs/spec-kas-laporan-v1.md` forbids hiding either, so a report carries both and
 * labels them apart.
 *
 * A voided Tagihan is left out of all three numbers. `invoiceStandings` calls it `void` rather
 * than any of the four ordinary states, and `src/lib/server/db/schema/allocation.ts` records that a
 * Tagihan that has absorbed a payment cannot be cancelled at all — so a cancelled one is neither
 * lunas nor belum lunas, and counting it either way would answer "berapa rumah" with a house that
 * owes nothing.
 *
 * The allocated sum and the lunas/belum-lunas split are both `invoiceStandings`'s, never a sum or a
 * comparison written again here. It is the one place `docs/spec-iuran-v1.md` allows that comparison
 * to live, and two screens that computed it separately would eventually disagree about one Tagihan.
 */
async function duesSummaryFor(
	writer: DatabaseWriter,
	clock: Clock,
	period: string
): Promise<DuesSummary> {
	const rows = await writer
		.select({
			invoiceId: invoices.id,
			unitId: invoices.unitId,
			period: invoices.period,
			amount: invoices.amount,
			dueDate: invoices.dueDate,
			voidedAt: invoices.voidedAt
		})
		.from(invoices)
		.where(and(eq(invoices.period, period), isNull(invoices.voidedAt)));

	let collected = 0;
	let unitsPaid = 0;
	for (const invoice of await invoiceStandings(writer, clock, rows)) {
		collected += invoice.allocatedAmount;
		if (invoice.status === INVOICE_STATUS.paid) {
			unitsPaid += 1;
		}
	}

	return {
		collected: rupiah(collected),
		unitsPaid,
		unitsUnpaid: rows.length - unitsPaid
	};
}
