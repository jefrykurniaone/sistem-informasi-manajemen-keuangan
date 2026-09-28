import { eq } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import type { Database } from '../../db';
import {
	CASH_CATEGORY_TYPE,
	SYSTEM_CATEGORY_KEY,
	cashCategories,
	type CashCategoryType
} from '../../db/schema/cash-category';
import type { MonthlyReportCategoryLine } from '../../db/schema/monthly-report';
import {
	transactionsInCategory,
	type CategoryTransaction,
	type CategoryTransactions
} from './composition';
import { publishedReport, type PublishedReportRevision } from './publication';

/**
 * What a Warga is handed when they open a Laporan Bulanan: the frozen figures of one published
 * revision, and — when they drill into a category — the transactions inside it.
 *
 * ## Privacy is enforced here, in the payload, and not in the template
 *
 * `docs/spec-kas-laporan-v1.md` is explicit: "Laporan yang dilihat warga menampilkan jumlah rumah
 * yang lunas dan belum lunas serta total terkumpul — tidak pernah nama." A rule kept in a `.svelte`
 * file is a rule that holds only for as long as nobody writes a second `.svelte` file, adds a JSON
 * endpoint, or renders the same data into an email. So the guarantee is made a property of the
 * object: **nothing this module returns has a field that can hold a person or a house.** There is
 * one payload, the same one for every role, and `tests/unit/report-privacy.test.ts` walks it as a
 * parameterised sweep over roles rather than reading any HTML.
 *
 * Three things are therefore deliberately absent, each of which the underlying data has:
 *
 * - **Who published it.** `monthly_reports.publishedBy` is on the row and stays there for the audit
 *   log and for admin screens. A publisher is an Admin, and an Admin is usually a Warga of the
 *   complex, so carrying their name here would put a resident's name into the resident payload —
 *   the criterion this ticket is tested against says never, without an exemption for pengurus.
 * - **Who recorded a transaction, and the receipt photo attached to it.** `transactionsInCategory`
 *   in `./composition.ts` leaves both out by construction; see its own doc comment. A nota is a
 *   photograph of a piece of paper and nobody can promise what is written on it.
 * - **Every row of the "Iuran warga" category.** See the next section — this is the one that is a
 *   decision rather than an omission.
 *
 * What a free-text keterangan says is the admin's responsibility and not something a payload shape
 * can promise: an admin who types a neighbour's name into the description of a pengeluaran has
 * published that name, exactly as they would have on the buku kas screen. The structural claim this
 * module makes is narrower and checkable — no *field* here is a name or a unit identifier.
 *
 * ## The drill-down refuses the `dues` system category, and that is not an oversight
 *
 * User story 20 asks for a drill-down into "satu kategori **pengeluaran**", so that a big number can
 * be checked. Every category answers that, with one exception. "Iuran warga" is the system category
 * whose only writer is payment verification, so one row in it is one house's payment on one day for
 * one amount. Listing them is a per-house payment ledger, and a per-house payment ledger read
 * against the count of houses that have not paid is the daftar penunggak the spec puts behind
 * `ACTION.readOverdue` and calls "layar terpisah yang hanya bisa dibuka admin" — arrived at by
 * subtraction instead of by a column. Whoever is missing from the list is who did not pay.
 *
 * So the report shows the `dues` line's **total** like any other line, and refuses to open it. The
 * refusal is uniform across roles rather than hidden from warga only: there is one payload, an admin
 * who wants those rows has `/admin/cash` filtered by category, and a second payload shape that
 * differed by role would be a second thing to get right.
 *
 * ## What the drill-down is allowed to reach at all
 *
 * Only a category line that appears in *this revision's frozen breakdown*, and only inside the month
 * that revision publishes. A `categoryId` that is not on the report, or a direction it has no line
 * in, answers with no drill-down, which keeps a report page from becoming a general reader of the
 * buku kas that happens to need no permission. What opens is one line, one direction: the rows
 * behind the figure the reader clicked, and not the category's other direction mixed in.
 *
 * ## The frozen total and the live rows, shown side by side
 *
 * The rows are live and the line total is frozen — `./composition.ts` records why that split is
 * forced by the schema — so the two can disagree, in exactly one situation: a superuser has reopened
 * the month and something has been recorded into it since this revision went out. The payload
 * carries both numbers rather than picking one, and the screen says so. Hiding the difference would
 * make a resident's own addition come out wrong with nothing to explain it, which is the complaint
 * this spec's problem statement opens with.
 */

/** The four headline figures of a report, frozen at publication. */
export interface ReportHeadline {
	readonly openingBalance: Rupiah;
	readonly totalIncome: Rupiah;
	readonly totalExpense: Rupiah;
	readonly closingBalance: Rupiah;
}

/**
 * The iuran summary, with the spec's "dua angka yang berbeda" both present and named apart.
 *
 * `collected` is about this Periode's *Tagihan* — how the month's billing stands, whenever the money
 * arrived. `cashIn` is about this month's *kas* — what the `dues` category received between the
 * first and the last day of it. A January Tagihan settled on 20 February raises January's
 * `collected` at January's next revision and February's `cashIn` at February's. Showing one and not
 * the other is what `docs/spec-kas-laporan-v1.md` forbids.
 */
export interface ReportDuesSummary {
	/** Iuran allocated to this Periode's Tagihan. Frozen at publication. */
	readonly collected: Rupiah;
	/** Kas masuk in the "Iuran warga" category dated inside this month. Frozen at publication. */
	readonly cashIn: Rupiah;
	/** How many houses had fully paid this Periode's Tagihan. A count, never a name. */
	readonly unitsPaid: number;
	/** How many had not. */
	readonly unitsUnpaid: number;
}

/** One category line of a report, as a reader sees it. */
export interface ReportCategoryRow {
	/** The drill-down anchor `src/lib/server/db/schema/monthly-report.ts` froze it for. */
	readonly categoryId: string;
	/** The category's name as it read at publication, never as it reads now. */
	readonly name: string;
	/** The frozen sum of this category's transactions in this direction. Never negative. */
	readonly total: Rupiah;
	/** False for the "Iuran warga" system category — see this module's doc comment. */
	readonly mayDrillDown: boolean;
}

/**
 * One set of category lines arranged for reading: split by direction, with the iuran line's total
 * pulled out and every line told whether it opens.
 */
export interface ReportBreakdownView {
	/** The "Iuran warga" income line's total — kas masuk iuran inside this month. Zero when absent. */
	readonly duesCashIn: Rupiah;
	/** The `income` lines, in the order the breakdown carries them. */
	readonly income: readonly ReportCategoryRow[];
	/** The `expense` lines, in the same order. */
	readonly expense: readonly ReportCategoryRow[];
}

/**
 * Arranges a breakdown for a screen: which lines go in which section, which one is the iuran
 * category, and what its income line came to.
 *
 * Exported because the admin preview needs exactly this arrangement of figures that are not yet a
 * publication, and rendering a preview through a second arrangement of the same numbers is how a
 * preview stops being worth looking at — what an admin approved would no longer be what a warga
 * reads. `reportForPeriod` below applies it to a frozen breakdown; `/admin/reports` applies it to a
 * freshly composed one.
 *
 * @throws {Error} when the migration's "Iuran warga" seed row is missing. See `duesCategory`.
 */
export async function presentBreakdown(
	db: Database,
	lines: readonly MonthlyReportCategoryLine[]
): Promise<ReportBreakdownView> {
	return breakdownView(lines, await duesCategory(db));
}

/** The arrangement above, once the iuran category is already known. */
function breakdownView(
	lines: readonly MonthlyReportCategoryLine[],
	duesCategoryId: string
): ReportBreakdownView {
	return {
		duesCashIn: frozenTotalOf(lines, duesCategoryId, CASH_CATEGORY_TYPE.income),
		income: categoryRows(lines, CASH_CATEGORY_TYPE.income, duesCategoryId),
		expense: categoryRows(lines, CASH_CATEGORY_TYPE.expense, duesCategoryId)
	};
}

/** One published revision of one Periode, as a Warga reads it. */
export interface ReportPayload {
	readonly period: string;
	readonly revision: number;
	readonly publishedAt: Date;
	/** Why this revision exists, shown to every warga. Null on revision 1. */
	readonly revisionReason: string | null;
	/** Whether this is the newest revision — a reader looking at an older one is told so. */
	readonly isLatest: boolean;
	readonly headline: ReportHeadline;
	readonly dues: ReportDuesSummary;
	/** The `income` lines, ordered by name. */
	readonly income: readonly ReportCategoryRow[];
	/** The `expense` lines, ordered by name. */
	readonly expense: readonly ReportCategoryRow[];
	/** Every revision of this Periode, newest first, so an older one stays readable. */
	readonly revisions: readonly PublishedReportRevision[];
}

/**
 * Whether the category being drilled into also has something on its *other* direction this month,
 * so a reader who opened one side is told a Koreksi (or an ordinary transaction) is not hidden from
 * them by having landed on the wrong table.
 *
 * - `published`: this revision froze a line for the other direction too. `total` is that frozen
 *   figure, not the live one, for the same reason `frozenTotal` above is frozen: the sentence built
 *   from it points at a row printed in the other table, and that row shows the published figure.
 * - `sinceRevision`: no line for the other direction on this revision, but the buku kas records one
 *   now. `total` is the live figure, because there is no published one to show instead.
 * - `none`: neither of the above — the other direction has nothing to say this month.
 */
export type ReportOtherDirection =
	| { readonly kind: 'published'; readonly total: Rupiah }
	| { readonly kind: 'sinceRevision'; readonly total: Rupiah }
	| { readonly kind: 'none' };

/**
 * One category opened out into the transactions behind **one** of its lines.
 *
 * A category can have two lines on one report, because a Koreksi moves the opposite way to its
 * Kategori Kas and the breakdown groups by the transaction's direction; see `categoryLines` in
 * `./composition.ts`. The detail answers for one line at a time, so its `entries` add up to the
 * figure printed on the row it was opened from, and a Koreksi never hides inside the ordinary side.
 * `otherDirection` is what tells the reader that other side exists at all.
 */
export interface ReportCategoryDrilldown {
	readonly categoryId: string;
	/** The name as this revision froze it. */
	readonly name: string;
	/** Which of the category's lines this is: the direction every entry below moves in. */
	readonly direction: CashCategoryType;
	/**
	 * True when `direction` is the Kategori Kas's own type, the ordinary side. False on the side its
	 * Koreksi land in. Read from `cash_categories`, because a frozen line carries its direction but not
	 * the category's.
	 */
	readonly isOwnDirection: boolean;
	/** The figure this revision published on that line. */
	readonly frozenTotal: Rupiah;
	/** What the same direction's rows add up to in the buku kas right now. */
	readonly liveTotal: Rupiah;
	/**
	 * True when the two disagree, which means this direction changed after this revision went out.
	 * A change on the category's other direction does not count: it is not on this line.
	 */
	readonly changedSincePublication: boolean;
	/** The rows moving in `direction`, oldest first. Carries no person and no file. */
	readonly entries: readonly CategoryTransaction[];
	/** Whether the category's other direction has anything to show this month, and if so what. */
	readonly otherDirection: ReportOtherDirection;
}

/** Which report to read, which revision of it, and which category to open in which direction. */
export interface ReportViewRequest {
	/** The Periode, as `YYYY-MM`. */
	readonly period: string;
	/** Which revision, or absent for the newest there is. */
	readonly revision?: number;
	/** Which category to drill into, or absent for none. */
	readonly categoryId?: string;
	/**
	 * Which of that category's lines to open. Absent means the category's own type, falling back to
	 * the direction that has a line when its own type has none on this revision.
	 */
	readonly direction?: CashCategoryType;
}

/** A report page's whole answer. */
export interface ReportView {
	readonly report: ReportPayload;
	/** The opened category, or null when none was asked for or the one asked for is refused. */
	readonly drilldown: ReportCategoryDrilldown | null;
}

/**
 * One published Laporan Bulanan as a Warga reads it, with an optional category opened out.
 *
 * **Takes no caller and checks no permission.** A published report is readable by every signed-in
 * Warga — `docs/spec-kas-laporan-v1.md`'s whole point is that the complex's money is not a secret
 * from the people whose money it is — so there is no action a reader could hold or fail to hold, and
 * inventing one would be a permission nobody is ever refused. What the acceptance criteria does ask
 * for, "pengunjung tanpa akun ditolak", is a question about a *session* rather than about roles, and
 * a service that is handed a database has no session to inspect: the redirect in
 * `src/routes/(app)/reports/[period]/+page.server.ts` is the guard, and `tests/e2e/reports.spec.ts`
 * is what proves it from a browser with no cookie. The same reasoning `invoicesForUser` and
 * `listActiveCashCategories` already record.
 *
 * @returns `undefined` when that Periode has no published report, or when `revision` names one that
 *   was never published.
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 */
export async function reportForPeriod(
	db: Database,
	request: ReportViewRequest
): Promise<ReportView | undefined> {
	const published = await publishedReport(db, request.period, request.revision);
	if (!published) {
		return undefined;
	}

	const duesCategoryId = await duesCategory(db);
	const lines = published.figures.categoryBreakdown;
	const breakdown = breakdownView(lines, duesCategoryId);
	const report: ReportPayload = {
		period: published.period,
		revision: published.revision,
		publishedAt: published.publishedAt,
		revisionReason: published.revisionReason,
		isLatest: published.isLatest,
		headline: {
			openingBalance: published.figures.openingBalance,
			totalIncome: published.figures.totalIncome,
			totalExpense: published.figures.totalExpense,
			closingBalance: published.figures.closingBalance
		},
		dues: {
			collected: published.figures.duesCollected,
			cashIn: breakdown.duesCashIn,
			unitsPaid: published.figures.duesUnitsPaid,
			unitsUnpaid: published.figures.duesUnitsUnpaid
		},
		income: breakdown.income,
		expense: breakdown.expense,
		revisions: published.revisions
	};

	return {
		report,
		drilldown: await drilldownFor(db, published.period, lines, duesCategoryId, request)
	};
}

/**
 * The opened line of a category, or null when there is nothing to open.
 *
 * Null for four different reasons, all of which a page renders the same way: no category asked
 * for, a category that is not on this revision, the `dues` category the report never opens (in
 * either direction), and a direction the category has no line for on this revision. They are one
 * answer on purpose. Distinguishing "that category is not on this report" from "you may not see that
 * one" would tell a reader which category ids exist, which is a fact the report did not publish. A
 * direction with no line is the same case: that line is not on this revision, and answering it
 * differently from an unknown category would say which categories exist all the same.
 */
async function drilldownFor(
	db: Database,
	period: string,
	lines: readonly MonthlyReportCategoryLine[],
	duesCategoryId: string,
	request: ReportViewRequest
): Promise<ReportCategoryDrilldown | null> {
	const { categoryId } = request;
	if (categoryId === undefined || categoryId === duesCategoryId) {
		return null;
	}
	const categoryLines = lines.filter((candidate) => candidate.categoryId === categoryId);
	if (categoryLines.length === 0) {
		return null;
	}

	// Only after the id has been found on the frozen report, so an arbitrary string from the address
	// bar never reaches a query.
	const ownType = await categoryType(db, categoryId);
	if (ownType === undefined) {
		return null;
	}
	const line = openedLine(categoryLines, ownType, request.direction);
	if (!line) {
		return null;
	}

	const live = await transactionsInCategory(db, period, categoryId);
	const liveTotal = line.type === CASH_CATEGORY_TYPE.income ? live.incomeTotal : live.expenseTotal;
	return {
		categoryId,
		name: line.name,
		direction: line.type,
		isOwnDirection: line.type === ownType,
		frozenTotal: line.total,
		liveTotal,
		changedSincePublication: liveTotal !== line.total,
		entries: live.entries.filter((entry) => entry.type === line.type),
		otherDirection: otherDirectionOf(categoryLines, line, live)
	};
}

/** The `income`/`expense` type opposite the one given. */
function opposite(type: CashCategoryType): CashCategoryType {
	return type === CASH_CATEGORY_TYPE.income
		? CASH_CATEGORY_TYPE.expense
		: CASH_CATEGORY_TYPE.income;
}

/**
 * What the category's other direction — the type opposite `line`'s — has to show this month: a
 * frozen line on this same revision, a live total with no frozen line yet, or nothing at all. See
 * `ReportOtherDirection` for why `published` carries the frozen figure and `sinceRevision` the live
 * one.
 */
function otherDirectionOf(
	categoryLines: readonly MonthlyReportCategoryLine[],
	line: MonthlyReportCategoryLine,
	live: CategoryTransactions
): ReportOtherDirection {
	const otherType = opposite(line.type);
	const otherLine = categoryLines.find((candidate) => candidate.type === otherType);
	if (otherLine) {
		return { kind: 'published', total: otherLine.total };
	}
	const otherLiveTotal =
		otherType === CASH_CATEGORY_TYPE.income ? live.incomeTotal : live.expenseTotal;
	if (otherLiveTotal > 0) {
		return { kind: 'sinceRevision', total: otherLiveTotal };
	}
	return { kind: 'none' };
}

/**
 * Which of one category's frozen lines to open.
 *
 * An asked-for direction is taken as asked, and answers nothing when it has no line. With none asked
 * for, which is an old link or a hand-typed address, the category's own type is opened, so the
 * reader lands on the ordinary side and not on the Koreksi side. Only when that side has no line on
 * this revision does it fall to the one that does.
 */
function openedLine(
	categoryLines: readonly MonthlyReportCategoryLine[],
	ownType: CashCategoryType,
	requested: CashCategoryType | undefined
): MonthlyReportCategoryLine | undefined {
	if (requested !== undefined) {
		return categoryLines.find((candidate) => candidate.type === requested);
	}
	return categoryLines.find((candidate) => candidate.type === ownType) ?? categoryLines[0];
}

/**
 * The stored type of one Kategori Kas, or `undefined` when no row carries that id.
 *
 * A frozen line names a category that existed at publication, and nothing deletes a category that
 * has transactions, so `undefined` is not expected. It opens nothing rather than throwing, because
 * the one thing a missing row must not do is take the whole report page down with it.
 */
async function categoryType(
	db: Database,
	categoryId: string
): Promise<CashCategoryType | undefined> {
	const [row] = await db
		.select({ type: cashCategories.type })
		.from(cashCategories)
		.where(eq(cashCategories.id, categoryId))
		.limit(1);
	return row?.type;
}

/** The frozen lines going one direction, in reading order, each told whether it opens. */
function categoryRows(
	lines: readonly MonthlyReportCategoryLine[],
	type: CashCategoryType,
	duesCategoryId: string
): readonly ReportCategoryRow[] {
	return lines
		.filter((line) => line.type === type)
		.map((line) => ({
			categoryId: line.categoryId,
			name: line.name,
			total: line.total,
			mayDrillDown: line.categoryId !== duesCategoryId
		}));
}

/** One frozen line's total, or zero when this revision published no line for that direction. */
function frozenTotalOf(
	lines: readonly MonthlyReportCategoryLine[],
	categoryId: string,
	type: CashCategoryType
): Rupiah {
	const line = lines.find(
		(candidate) => candidate.categoryId === categoryId && candidate.type === type
	);
	return line?.total ?? rupiah(0);
}

/**
 * The id of the "Iuran warga" system category.
 *
 * Looked up by `systemKey` and never by display name, which a superuser may change; see
 * `src/lib/server/db/schema/cash-category.ts`.
 *
 * A missing row throws rather than being treated as "there is no dues category", and the direction
 * matters: absent it, every line on the report would become drillable, including the one this
 * module refuses to open. `drizzle/0009_cash_report.sql` seeds the row, so an empty result means the
 * migration did not run — a broken database, not a normal state worth papering over. The same
 * reasoning `rolesOf` in `src/lib/server/authz.ts` records for the default-role trigger.
 */
async function duesCategory(db: Database): Promise<string> {
	const [row] = await db
		.select({ id: cashCategories.id })
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues))
		.limit(1);
	if (!row) {
		throw new Error(
			`No cash category carries the system key "${SYSTEM_CATEGORY_KEY.dues}". The migration that seeds it has not run, and without it a report cannot tell the iuran category apart from an ordinary one.`
		);
	}
	return row.id;
}
