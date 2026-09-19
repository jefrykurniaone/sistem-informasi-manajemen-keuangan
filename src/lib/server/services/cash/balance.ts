import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import { ACTION, requirePermission } from '../../authz';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	type CashCategoryType
} from '../../db/schema/cash-category';
import { cashTransactions } from '../../db/schema/cash-transaction';

/**
 * Reading the buku kas back: the lines in date order, the running balance beside each one, and the
 * two filters user story 10 asks for. Nothing in this module writes, and that is half of what
 * "hanya bisa ditambah" means — see the doc comment on `./transaction.ts` for the other half and
 * for the argument that the absence is structural rather than observed.
 *
 * ## Saldo is never stored, and this is the only place it is worked out
 *
 * `docs/spec-kas-laporan-v1.md` is explicit: "Saldo kas dan saldo per periode dihitung dari
 * transaksi, tidak pernah disimpan sebagai kolom yang diperbarui." There is no balance column
 * anywhere in `src/lib/server/db/schema/` — `tests/unit/schema-cash-report.test.ts` asserts that
 * outright — and the running balance below is computed on every read.
 *
 * ## Where the arithmetic happens, and why it is split
 *
 * The per-row column is a **fold in TypeScript** over the rows the query already returned. The
 * carry-forward that precedes them is a **single aggregate in SQL**. The split is not an
 * inconsistency; each half is where it is for a reason the other does not have:
 *
 * - The listed rows are all in memory anyway, because the screen renders every one of them. A
 *   window function would send the same set across the wire with one `bigint` more per row and buy
 *   nothing.
 * - A window function's `ORDER BY` and the statement's own `ORDER BY` have to be the same clause or
 *   the column quietly means something else. They are two clauses that can drift; a fold over the
 *   returned array cannot disagree with the order of the array it folds.
 * - `Rupiah` is a branded type whose constructor checks that a value is a whole number inside the
 *   safe integer range. Folding in TypeScript runs that check on **every intermediate balance**, so
 *   a book whose running total left the safe range throws by name here instead of arriving from the
 *   driver as a silently rounded `number`.
 * - The carry-forward, by contrast, is one number over rows that are never displayed. Fetching them
 *   all in order to fold them would be the waste the window function avoided — so that half stays in
 *   SQL, where `sum` reads an index range and returns one value.
 *
 * The two halves must agree on one thing, the sign convention, and they do: `income` adds,
 * everything else subtracts. "Everything else" is `expense` and nothing else, because
 * `cash_transactions_type_check` allows exactly the two.
 *
 * ## What the running balance means when a filter is on
 *
 * A filtered view has two possible answers, and picking neither is how a column becomes a lie. The
 * answer here is: **the running balance is always the balance of the rows in this view**, carried
 * forward from the same view's own history.
 *
 * - With no filter it is the true cash balance of the complex, which is what user story 9 asks for
 *   ("supaya saya bisa mencocokkannya dengan rekening").
 * - Filtered to a month, `openingBalance` is the balance at the end of the day before that month
 *   began, so the last row's balance is still the true balance on that day. A month's view is a
 *   window onto the same running total, not a separate one.
 * - Filtered to a category, every figure is that category's own net — money in that category, less
 *   its corrections. That is the number user story 20 wants when a resident drills into one heading
 *   and asks whether it adds up.
 *
 * `src/routes/(app)/admin/cash/+page.svelte` says which of the three it is showing, in Indonesian,
 * above the table. A column headed "saldo" that silently changed meaning with a dropdown is exactly
 * the unexplained difference this spec's problem statement is about.
 */

/**
 * The shape a month filter arrives in: `YYYY-MM`, zero-padded, month 01 to 12 — the same shape
 * `invoices_period_shape_check` enforces on `invoices.period`, so the two are already comparable
 * without a conversion. Exported so a route can refuse a hand-typed query string before it becomes
 * a service call.
 */
export const CASH_BOOK_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The signed total of the rows a query selects, as text.
 *
 * `::text` rather than a bare `sum`: PostgreSQL widens `sum(bigint)` to `numeric`, which
 * node-postgres hands back as a string anyway to avoid losing precision, and saying so makes the
 * conversion in TypeScript deliberate instead of dependent on which parser happens to be
 * registered. `coalesce` is not decoration either — `sum` over an empty set is `null`, which would
 * otherwise reach `Number()` as a balance of `NaN`.
 */
const SIGNED_TOTAL = sql<string>`coalesce(sum(case when ${cashTransactions.type} = ${CASH_CATEGORY_TYPE.income} then ${cashTransactions.amount} else -${cashTransactions.amount} end), 0)::text`;

/** The `YYYY-MM` a transaction's `occurredOn` falls in, for the month filter's own option list. */
const MONTH_OF_TRANSACTION = sql<string>`to_char(${cashTransactions.occurredOn}, 'YYYY-MM')`;

/** Which slice of the cash book to read. Both halves are optional and combine. */
export interface CashBookFilter {
	/** A calendar month as `YYYY-MM`, or absent for every month there is. */
	readonly month?: string;
	/** A Kategori Kas id, or absent for every category. */
	readonly categoryId?: string;
}

/** One line of the cash book as a screen reads it, with its running balance already worked out. */
export interface CashBookEntry {
	readonly id: string;
	/** The day money moved, as `YYYY-MM-DD`. */
	readonly occurredOn: string;
	/** `income` or `expense`. Opposes the category's type exactly when this row is a Koreksi. */
	readonly type: CashCategoryType;
	readonly categoryId: string;
	readonly categoryName: string;
	/** How much moved, always positive. */
	readonly amount: Rupiah;
	/** The keterangan — or, on a Koreksi, the alasan. */
	readonly description: string;
	/** The `FileStore` key of the receipt photo, or null when there is none. */
	readonly attachmentKey: string | null;
	/** The transaction this row reverses, when it is a Koreksi. */
	readonly correctionOf: string | null;
	/** The Koreksi that reverses this row, when one exists. A row with one refuses a second. */
	readonly correctedBy: string | null;
	/** The name of the account that recorded the row. */
	readonly recordedByName: string;
	/** When the row was typed in — the tiebreaker for two transactions on one day. */
	readonly createdAt: Date;
	/** The running balance of this view, up to and including this row. */
	readonly balance: Rupiah;
}

/** One Kategori Kas that appears somewhere in the cash book, for the filter's option list. */
export interface CashBookCategory {
	readonly id: string;
	readonly name: string;
	readonly type: CashCategoryType;
}

/** The cash book as one screen's worth of answer. */
export interface CashBook {
	/** The lines, oldest first. */
	readonly entries: readonly CashBookEntry[];
	/** The balance carried into the first line shown. Zero when no month filter is on. */
	readonly openingBalance: Rupiah;
	/** The balance after the last line shown. */
	readonly closingBalance: Rupiah;
	/** Every category that appears anywhere in the book, whatever the filter, ordered by name. */
	readonly categories: readonly CashBookCategory[];
	/** Every `YYYY-MM` that has at least one transaction, newest first, whatever the filter. */
	readonly months: readonly string[];
}

/**
 * The cash book, filtered, in date order, with a running balance on every line.
 *
 * Lines are ordered by `occurredOn`, then by `createdAt`, then by `id`. The first is the order the
 * spec asks for; the other two only ever break ties, and they are there so that the balance column
 * is the same on two renderings of the same page — an order that leaves ties unresolved would let
 * two rows on one day swap places between two requests and take their running balances with them.
 *
 * @throws {PermissionDeniedError} when `actorId` may not record a Transaksi Kas. Reading the book
 *   and adding to it are one action; see `src/lib/server/authz.ts`.
 * @throws {TypeError} when `filter.month` is not shaped `YYYY-MM`. A route validates its own query
 *   string against `CASH_BOOK_MONTH_PATTERN`, so reaching this is a mistake in calling code.
 */
export async function cashBook(
	db: Database,
	actorId: string,
	filter: CashBookFilter = {}
): Promise<CashBook> {
	await requirePermission(db, actorId, ACTION.recordCashTransactions);

	const range = filter.month === undefined ? undefined : monthRange(filter.month);
	const rows = await selectEntries(db, range, filter.categoryId);
	const [openingBalance, correctedBy, categories, months] = await Promise.all([
		range === undefined ? Promise.resolve(rupiah(0)) : balanceBefore(db, range.from, filter),
		correctionIndex(
			db,
			rows.map((row) => row.id)
		),
		cashBookCategories(db),
		cashBookMonths(db)
	]);

	const entries = withRunningBalance(rows, openingBalance, correctedBy);
	return {
		entries,
		openingBalance,
		closingBalance: entries.at(-1)?.balance ?? openingBalance,
		categories,
		months
	};
}

/** One selected row, before its running balance and its Koreksi are attached. */
type SelectedRow = Awaited<ReturnType<typeof selectEntries>>[number];

/** The filtered lines, joined to the names a screen shows, in the documented order. */
async function selectEntries(db: Database, range: MonthRange | undefined, categoryId?: string) {
	return db
		.select({
			id: cashTransactions.id,
			occurredOn: cashTransactions.occurredOn,
			type: cashTransactions.type,
			categoryId: cashTransactions.categoryId,
			categoryName: cashCategories.name,
			amount: cashTransactions.amount,
			description: cashTransactions.description,
			attachmentKey: cashTransactions.attachmentKey,
			correctionOf: cashTransactions.correctionOf,
			recordedByName: user.name,
			createdAt: cashTransactions.createdAt
		})
		.from(cashTransactions)
		.innerJoin(cashCategories, eq(cashTransactions.categoryId, cashCategories.id))
		.innerJoin(user, eq(cashTransactions.recordedBy, user.id))
		.where(entryFilter(range, categoryId))
		.orderBy(
			asc(cashTransactions.occurredOn),
			asc(cashTransactions.createdAt),
			asc(cashTransactions.id)
		);
}

/** The `where` both the listing and the carry-forward are built from, or `undefined` for all rows. */
function entryFilter(range: MonthRange | undefined, categoryId?: string): SQL | undefined {
	const conditions: SQL[] = [];
	if (range) {
		conditions.push(
			gte(cashTransactions.occurredOn, range.from),
			lte(cashTransactions.occurredOn, range.to)
		);
	}
	if (categoryId !== undefined) {
		conditions.push(eq(cashTransactions.categoryId, categoryId));
	}
	return conditions.length === 0 ? undefined : and(...conditions);
}

/**
 * The balance this view carries into its first line: the signed total of every transaction matching
 * the same category filter that happened strictly before `day`.
 *
 * The category filter is applied here as well as to the listing on purpose. A view of one category
 * whose carry-forward came from the whole book would open at a number none of its own rows explain,
 * and the column would stop being a running total of what is on the screen.
 */
async function balanceBefore(db: Database, day: string, filter: CashBookFilter): Promise<Rupiah> {
	const conditions: SQL[] = [lt(cashTransactions.occurredOn, day)];
	if (filter.categoryId !== undefined) {
		conditions.push(eq(cashTransactions.categoryId, filter.categoryId));
	}

	const [row] = await db
		.select({ total: SIGNED_TOTAL })
		.from(cashTransactions)
		.where(and(...conditions));
	return rupiah(Number(row?.total ?? '0'));
}

/** Which Koreksi, if any, reverses each of `ids`. Keyed by the corrected transaction. */
async function correctionIndex(
	db: Database,
	ids: readonly string[]
): Promise<ReadonlyMap<string, string>> {
	const index = new Map<string, string>();
	if (ids.length === 0) {
		return index;
	}

	const rows = await db
		.select({ id: cashTransactions.id, correctionOf: cashTransactions.correctionOf })
		.from(cashTransactions)
		.where(inArray(cashTransactions.correctionOf, [...ids]));
	for (const row of rows) {
		if (row.correctionOf !== null) {
			index.set(row.correctionOf, row.id);
		}
	}
	return index;
}

/**
 * Every Kategori Kas with at least one transaction, ordered by name — the filter's option list.
 *
 * It is the categories present in the *book*, not the active ones, because a category that has been
 * retired still has history worth filtering to; `listActiveCashCategories` answers the other
 * question, for the form that adds new rows.
 */
async function cashBookCategories(db: Database): Promise<readonly CashBookCategory[]> {
	return db
		.selectDistinct({
			id: cashCategories.id,
			name: cashCategories.name,
			type: cashCategories.type
		})
		.from(cashTransactions)
		.innerJoin(cashCategories, eq(cashTransactions.categoryId, cashCategories.id))
		.orderBy(asc(cashCategories.name));
}

/** Every month with at least one transaction, newest first — the other filter's option list. */
async function cashBookMonths(db: Database): Promise<readonly string[]> {
	const rows = await db
		.select({ month: MONTH_OF_TRANSACTION })
		.from(cashTransactions)
		.groupBy(MONTH_OF_TRANSACTION)
		.orderBy(desc(MONTH_OF_TRANSACTION));
	return rows.map((row) => row.month);
}

/**
 * The fold: each line's balance is the one before it plus this line's signed amount.
 *
 * `rupiah()` on every step is the point of doing this in TypeScript rather than in SQL — see this
 * module's doc comment.
 */
function withRunningBalance(
	rows: readonly SelectedRow[],
	openingBalance: Rupiah,
	correctedBy: ReadonlyMap<string, string>
): readonly CashBookEntry[] {
	let running: number = openingBalance;
	return rows.map((row) => {
		running += signedAmount(row.type, row.amount);
		return {
			...row,
			correctedBy: correctedBy.get(row.id) ?? null,
			balance: rupiah(running)
		};
	});
}

/** What one line does to the balance: money in adds, money out takes away. */
function signedAmount(type: CashCategoryType, amount: Rupiah): number {
	return type === CASH_CATEGORY_TYPE.income ? amount : -amount;
}

/** The first and last day of one calendar month, as `occurredOn` stores them. */
interface MonthRange {
	readonly from: string;
	readonly to: string;
}

/**
 * `YYYY-MM` as the inclusive range of days it covers.
 *
 * Day zero of the *next* month is the last day of this one, which is how February gets 28 or 29
 * without this function knowing anything about leap years.
 *
 * @throws {TypeError} when `month` is not shaped `YYYY-MM` with a month between 01 and 12.
 */
function monthRange(month: string): MonthRange {
	if (!CASH_BOOK_MONTH_PATTERN.test(month)) {
		throw new TypeError(`"${month}" is not a calendar month written as YYYY-MM.`);
	}
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}
