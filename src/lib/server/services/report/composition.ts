import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import type { DatabaseWriter } from '../../authz';
import type { Database } from '../../db';
import { allocations } from '../../db/schema/allocation';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	type CashCategoryType
} from '../../db/schema/cash-category';
import { cashTransactions } from '../../db/schema/cash-transaction';
import { invoices } from '../../db/schema/invoice';
import type { MonthlyReportCategoryLine } from '../../db/schema/monthly-report';
import type { Clock } from '../../ports/clock';
import { CASH_BOOK_MONTH_PATTERN } from '../cash/balance';
import { COMPLEX_TIME_ZONE } from '../dues/issuance';
import { INVOICE_STATUS, invoiceStatus } from '../dues/queries';

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
 * ## Which calendar the month boundary is read against — `Asia/Jakarta`, deliberately
 *
 * Two conventions live in this repository today and their unification is not yet ticketed:
 * `currentDay(clock)` in `../occupancy/visibility.ts` reads a **UTC** civil day, while Tagihan
 * issuance and `../dues/queries.ts` read one in **`COMPLEX_TIME_ZONE` (`Asia/Jakarta`)**. This
 * module chooses Jakarta, and the choice is narrower than it looks — most of a report does not have
 * the question at all:
 *
 * - **Which transactions fall inside the month is not a clock question.** `cash_transactions.occurredOn`
 *   is a `date`, and `monthRange` turns `YYYY-MM` into the two `YYYY-MM-DD` it spans by string
 *   arithmetic. No instant is converted, so no zone can be wrong.
 * - **Which Tagihan belong to the Periode is not one either.** `invoices.period` is already `YYYY-MM`.
 *
 * What is left is the two places an *instant* becomes a civil date: "which month is the periode
 * berjalan an admin previews by default", and the `today` `invoiceStatus` decides "sudah lewat jatuh
 * tempo" against. Both are Jakarta here, for three reasons that point the same way. The day written
 * on a Transaksi Kas was typed by an admin sitting in the complex, so the days this report adds up
 * are already Jakarta days and reading their boundary in UTC would make the application disagree
 * with the dates its own users entered. `invoiceStatus`'s due dates were written in Jakarta's
 * calendar by `dueDateOfPeriod`, and `../dues/queries.ts` already documents at length why comparing
 * them to a UTC "today" is a seven-hour error twice a day rather than a harmless simplification.
 * And a default that reads UTC would, for the first seven hours of the first day of every month
 * local, offer an admin the *previous* month as "periode berjalan" — at exactly the turn of the
 * month, which is when a publication is most likely to happen.
 *
 * The UTC reading stays where it is. `currentDay` documents its own skew as accepted for screens
 * that decide visibility; this module's number is a document residents read and cannot be quietly
 * corrected afterwards, so it does not inherit that tolerance.
 *
 * ## Why this module reads `cash_transactions` itself instead of calling `../cash/balance.ts`
 *
 * This is the second reader of the buku kas, and it exists for a reason that is worth writing down
 * rather than shrugging at, because duplicating cash arithmetic is normally a mistake.
 *
 * `cashBook` is the natural home for both reads below, and it is not reachable. It is guarded by
 * `ACTION.recordCashTransactions`, which is `admin`'s — a Warga opening a report is answered 403 —
 * and the guard may not be loosened, because `/admin/cash/+page.server.ts` depends on it. The
 * obvious fix is to add two unguarded read-only exports beside it, and that is not available either:
 * **`tests/unit/cash-transaction.test.ts:148` asserts `Object.keys` of that module equals exactly
 * `['CASH_BOOK_MONTH_PATTERN', 'cashBook']`**, as the append-only guarantee's own surface test, and
 * that file is outside this ticket's `writes:`. Any new export there fails a test this ticket may
 * not edit. So the read lives here, where the report owns it.
 *
 * What is duplicated is kept to the smallest possible thing, and each piece is pinned by a test that
 * compares this module's answer to `cashBook`'s:
 *
 * - **The month boundary is not duplicated, it is avoided.** `cashBook` spans a month as the
 *   inclusive `[first day, last day]`, which needs to know that February has 28 days or 29. This
 *   module uses the half-open `[first day of the month, first day of the next month)`, which needs
 *   no such knowledge at all — so there is no leap-year rule written twice to drift apart. The two
 *   select the same civil days, and `tests/unit/report-composition.test.ts` proves it on February
 *   in particular by checking this module's answer against `cashBook`'s for the same month.
 * - **The sign convention is duplicated**, once, in `OPENING_BALANCE_TOTAL` below: income adds and
 *   everything else subtracts, the same rule `SIGNED_TOTAL` in `../cash/balance.ts` states. There is
 *   no way to share it across a module boundary that refuses new exports. The mitigation is a test
 *   rather than a comment: the opening balance a report freezes is asserted equal to the balance
 *   `cashBook` carries into the same month, so the day the two conventions disagree, that test says
 *   so by name.
 *
 * If `tests/unit/cash-transaction.test.ts` is ever widened to allow read-only exports on
 * `../cash/balance.ts`, both reads below should move there and this section should go with them.
 */

/** How many characters `YYYY-MM` takes, so the slice below is not a bare number. */
const MONTH_LENGTH = 'YYYY-MM'.length;

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
 * 12 asks an admin to be able to preview. Read in `COMPLEX_TIME_ZONE`; see this module's doc comment.
 */
export function currentReportPeriod(clock: Clock): string {
	return todayInComplexZone(clock).slice(0, MONTH_LENGTH);
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
	const range = monthRange(period);
	// Sequential, not `Promise.all`: `writer` is the caller's own transaction client when publication
	// calls this (see the doc comment above), and `pg`'s deprecation warning is exactly what firing
	// more than one query at once on the same client does, removed outright in `pg@9`, per #231. The
	// order here is the order the three used to run in, so the figures they produce do not change.
	const openingBalance = await openingBalanceOn(writer, range.from);
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

/** The half-open stretch of days one calendar month covers. See this module's doc comment. */
interface MonthRange {
	/** The first day of the month, as `YYYY-MM-DD`. Included. */
	readonly from: string;
	/** The first day of the *next* month. Excluded, which is what avoids a leap-year rule. */
	readonly before: string;
}

/**
 * `YYYY-MM` as the half-open range of days it covers: from its first day, up to but not including
 * the first day of the month after it.
 *
 * Half-open on purpose. The inclusive form `../cash/balance.ts` uses has to work out the last day of
 * the month, which is a leap-year rule; this form never asks. December rolls to January of the next
 * year, which is the only case worth looking at twice.
 *
 * @throws {TypeError} when `month` is not a calendar month written as `YYYY-MM`.
 */
function monthRange(month: string): MonthRange {
	if (!CASH_BOOK_MONTH_PATTERN.test(month)) {
		throw new TypeError(`"${month}" is not a calendar month written as YYYY-MM.`);
	}
	const year = Number(month.slice(0, YEAR_LENGTH));
	const number = Number(month.slice(YEAR_LENGTH + 1));
	const nextYear = number === MONTHS_IN_YEAR ? year + 1 : year;
	const nextMonth = number === MONTHS_IN_YEAR ? 1 : number + 1;
	return {
		from: `${month}-01`,
		before: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
	};
}

/** Where the year ends in a `YYYY-MM`, which is also how many characters it takes. */
const YEAR_LENGTH = 4;

/** How many months a year has, so that "December rolls over" is written once. */
const MONTHS_IN_YEAR = 12;

/**
 * The signed total of the rows a query selects, as text — income adds, everything else subtracts.
 *
 * The one piece of `../cash/balance.ts`'s arithmetic this module really does restate; see the "Why
 * this module reads `cash_transactions` itself" section above for why it cannot be shared, and for
 * the test that keeps the two honest. `::text` and `coalesce` for the reason that module records:
 * PostgreSQL widens `sum(bigint)` to `numeric`, which the driver hands back as a string, and `sum`
 * over an empty set is `null`.
 */
const OPENING_BALANCE_TOTAL = sql<string>`coalesce(sum(case when ${cashTransactions.type} = ${CASH_CATEGORY_TYPE.income} then ${cashTransactions.amount} else -${cashTransactions.amount} end), 0)::text`;

/**
 * The cash balance the month opens on: every Transaksi Kas dated strictly before `day`, signed and
 * summed.
 *
 * Read inside the caller's transaction when there is one, so that the figure frozen into a
 * publication is the one that was true while the Periode's row lock was held.
 */
async function openingBalanceOn(writer: DatabaseWriter, day: string): Promise<Rupiah> {
	const [row] = await writer
		.select({ total: OPENING_BALANCE_TOTAL })
		.from(cashTransactions)
		.where(lt(cashTransactions.occurredOn, day));
	return rupiah(Number(row?.total ?? '0'));
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
	const range = monthRange(month);
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
				lt(cashTransactions.occurredOn, range.before)
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
	range: MonthRange
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
			and(
				gte(cashTransactions.occurredOn, range.from),
				lt(cashTransactions.occurredOn, range.before)
			)
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
 * A voided Tagihan is left out of all three numbers. `invoiceStatus` calls it `void` rather than any
 * of the four ordinary states, and `src/lib/server/db/schema/allocation.ts` records that a Tagihan
 * that has absorbed a payment cannot be cancelled at all — so a cancelled one is neither lunas nor
 * belum lunas, and counting it either way would answer "berapa rumah" with a house that owes
 * nothing.
 *
 * The lunas/belum-lunas split is `invoiceStatus`'s, never a comparison written again here. It is the
 * one place `docs/spec-iuran-v1.md` allows that comparison to live, and two screens that computed it
 * separately would eventually disagree about one Tagihan.
 */
async function duesSummaryFor(
	writer: DatabaseWriter,
	clock: Clock,
	period: string
): Promise<DuesSummary> {
	const rows = await writer
		.select({
			id: invoices.id,
			amount: invoices.amount,
			dueDate: invoices.dueDate,
			voidedAt: invoices.voidedAt
		})
		.from(invoices)
		.where(and(eq(invoices.period, period), isNull(invoices.voidedAt)));
	if (rows.length === 0) {
		return { collected: rupiah(0), unitsPaid: 0, unitsUnpaid: 0 };
	}

	const allocated = await allocatedAmountsByInvoice(
		writer,
		rows.map((row) => row.id)
	);
	const today = todayInComplexZone(clock);

	let collected = 0;
	let unitsPaid = 0;
	for (const row of rows) {
		const allocatedAmount = allocated.get(row.id) ?? rupiah(0);
		collected += allocatedAmount;
		const status = invoiceStatus(
			{
				amount: row.amount,
				allocatedAmount,
				dueDate: row.dueDate,
				voidedAt: row.voidedAt
			},
			today
		);
		if (status === INVOICE_STATUS.paid) {
			unitsPaid += 1;
		}
	}

	return {
		collected: rupiah(collected),
		unitsPaid,
		unitsUnpaid: rows.length - unitsPaid
	};
}

/**
 * How much has been allocated to each of `invoiceIds`, keyed by invoice id and absent for one with
 * no allocation — the caller reads a missing entry as zero.
 *
 * A `Map`, never an object literal: the keys are invoice ids that reach this module from a request,
 * and a lookup in an object literal answers for names nobody put in it.
 */
async function allocatedAmountsByInvoice(
	writer: DatabaseWriter,
	invoiceIds: readonly string[]
): Promise<ReadonlyMap<string, Rupiah>> {
	const rows = await writer
		.select({
			invoiceId: allocations.invoiceId,
			total: sql<string>`coalesce(sum(${allocations.amount}), 0)::text`
		})
		.from(allocations)
		.where(inArray(allocations.invoiceId, [...invoiceIds]))
		.groupBy(allocations.invoiceId);

	return new Map(rows.map((row) => [row.invoiceId, rupiah(Number(row.total))]));
}

/**
 * A formatter that renders an instant as the calendar day it falls on in `COMPLEX_TIME_ZONE`. Built
 * once and reused, the same shape `../dues/queries.ts` and `src/lib/server/scheduler/registry.ts`
 * both already use — a fresh `Intl.DateTimeFormat` is not free to construct.
 */
const COMPLEX_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
	timeZone: COMPLEX_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/**
 * `YYYY-MM-DD` for the day `clock.now()` falls on in `COMPLEX_TIME_ZONE`, built from the parts so
 * the order never depends on locale. See this module's doc comment for why this zone and not UTC.
 */
function todayInComplexZone(clock: Clock): string {
	const parts = COMPLEX_DAY_FORMATTER.formatToParts(clock.now());
	const partOfType = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${partOfType('year')}-${partOfType('month')}-${partOfType('day')}`;
}
