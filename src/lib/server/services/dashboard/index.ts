import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { civilDayOf, civilMonthOf } from '$lib/time';
import type { Database } from '../../db';
import { allocations } from '../../db/schema/allocation';
import { CASH_CATEGORY_TYPE } from '../../db/schema/cash-category';
import { COMPLAINT_STATUS, complaints, type ComplaintStatus } from '../../db/schema/complaint';
import { invoices } from '../../db/schema/invoice';
import { occupancies } from '../../db/schema/occupancy';
import { PAYMENT_STATUS, payments } from '../../db/schema/payment';
import { POST_STATUS, posts, type PostType } from '../../db/schema/post';
import { residents } from '../../db/schema/resident';
import type { JobRunStatus } from '../../db/schema/scheduler';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { applicationJobs, listJobsWithLastRun } from '../../scheduler';
import { cashBook, type CashBook } from '../cash/balance';
import { creditBalanceOfUnit } from '../dues/credit-balance';
import {
	INVOICE_STATUS,
	invoiceStatus,
	invoicesForUser,
	type ResidentInvoiceRow
} from '../dues/queries';
import { stillRunningOn } from '../occupancy/visibility';

/**
 * The Beranda's two answers: "what should a pengurus do today?" and "what should this Warga do
 * today?", both read without HTTP so that the route (#142) is two calls and no arithmetic.
 *
 * `docs/spec-shell-beranda-v1.md` puts the aggregation here rather than in the page loader for one
 * reason, quoted: "aturan 'bulan ini' dan 'menunggak' sudah ada di service Tagihan dan Kas, dan
 * Beranda harus memakai definisi yang sama, bukan menghitung ulang di rute." So nothing in this
 * module decides what a word means. It borrows every definition it needs:
 *
 * | Figure | Borrowed from |
 * |---|---|
 * | "bulan ini" | `civilMonthOf` in `src/lib/time.ts` — WIB, never UTC |
 * | "sudah lewat jatuh tempo" | `civilDayOf`, compared by `invoiceStatus` in `../dues/queries.ts` |
 * | lunas / menunggak | `invoiceStatus` in `../dues/queries.ts` |
 * | saldo kas and its sign convention | `cashBook` in `../cash/balance.ts` |
 * | Saldo Titipan | `creditBalanceOfUnit` in `../dues/credit-balance.ts` |
 * | a Warga's own Tagihan | `invoicesForUser` in `../dues/queries.ts` |
 * | "masih tinggal di sini" | `stillRunningOn` in `../occupancy/visibility.ts` |
 * | the jobs and their last run | `listJobsWithLastRun` in `../../scheduler/index.ts` |
 *
 * Nothing here writes. The two functions are reads and only reads.
 *
 * ## `adminDashboard` takes an `actorId`, and still decides no permission
 *
 * The spec says the route is what checks, and this module holds to that: there is no
 * `requirePermission` call anywhere below, and no role is read or compared. The `actorId` is here
 * because two of the borrowed reads take one — `cashBook` is guarded by
 * `ACTION.recordCashTransactions` and `listJobsWithLastRun` by `ACTION.manageJobs` — and passing
 * the caller through to them is what makes this module reuse those definitions instead of writing
 * a second copy of the running balance. The alternative was to re-derive the saldo here, which is
 * exactly the thing the spec exists to prevent.
 *
 * ## Why `cash` and `jobs` can be `null`
 *
 * Those two actions are held by *different* roles: `recordCashTransactions` by `admin`,
 * `manageJobs` by `superuser` (`src/lib/server/authz.ts`). An account holding only one of them
 * still opens the Beranda, so letting either refusal escape would turn one missing card into a 403
 * for the whole page. A `PermissionDeniedError` from one of those two reads is therefore turned
 * into `null` for that field, and nothing else about it is caught — any other failure still
 * propagates.
 *
 * `null` and "empty" are kept apart on purpose: `jobs: null` means this caller may not see the
 * jobs, `jobs: []` means none are registered. The card layer reads the difference and says so,
 * which is the same courtesy `visibleMenu` in `src/lib/components/app-shell/menu.ts` already does
 * for the sidebar — a pengurus is shown the cards for the screens they can open, and no others.
 *
 * ## Why `complaintWorklistSummary` is not the complaints figure
 *
 * `../complaint/worklist.ts` answers story 20 — how many Keluhan came in and how many were
 * finished *this month*. The Beranda asks a different question, story 17: how many are open right
 * now, per status, whatever month they arrived in. Neither number can be derived from the other, so
 * this module counts the open statuses itself in one grouped query. That is a count, not a domain
 * rule; `OPEN_COMPLAINT_STATUSES` below names which three statuses "belum selesai" means, and
 * `withdrawn` and `rejected` are as finished as `resolved` for this purpose.
 *
 * ## Why the whole cash book is read for three numbers
 *
 * `cashBook` folds the running balance in TypeScript, so its `closingBalance` is the saldo of the
 * complex and its `entries` carry the sign convention already applied. Reading it unfiltered and
 * summing this month's lines from the rows in hand costs one extra pass over an array that is
 * already in memory, and it keeps the arithmetic in exactly one place. A dedicated aggregate would
 * be cheaper and would be a second definition of the same sum. The spec settles the trade-off by
 * saying what this page is sized for: "angka dan tautan sudah cukup untuk 100 rumah".
 */

/**
 * The Keluhan statuses that still need somebody's attention — "terbuka" on the Beranda and in
 * story 17. The order is the order a status moves through, which is the order the cards read in.
 */
export const OPEN_COMPLAINT_STATUSES = [
	COMPLAINT_STATUS.new,
	COMPLAINT_STATUS.reviewing,
	COMPLAINT_STATUS.working
] as const;

/** One of the three statuses above. */
export type OpenComplaintStatus = (typeof OPEN_COMPLAINT_STATUSES)[number];

/** How many Keluhan sit in each open status. Every status is present, zero when none are. */
export type OpenComplaintCounts = Readonly<Record<OpenComplaintStatus, number>>;

/** How many Post the Beranda lists, per `docs/spec-shell-beranda-v1.md`'s "tiga terbitan terbaru". */
const LATEST_POST_COUNT = 3;

/** This month's Tagihan, counted and totalled three ways. */
export interface DashboardInvoiceSummary {
	/** Every Tagihan of the month that was not cancelled. */
	readonly issuedCount: number;
	/** The sum of what those Tagihan charge. */
	readonly issuedAmount: Rupiah;
	/** Of those, the ones `invoiceStatus` calls `paid`. */
	readonly paidCount: number;
	/** The sum of what the paid ones charge. */
	readonly paidAmount: Rupiah;
	/** Of those, the ones `invoiceStatus` calls `overdue`. */
	readonly overdueCount: number;
	/**
	 * What is still owed on the menunggak ones — their charge less what is allocated to them, the
	 * same figure `listOverdueUnits` totals into `totalOverdue`, not the full charge.
	 */
	readonly overdueAmount: Rupiah;
}

/** The Pembayaran nobody has decided on yet. */
export interface PendingPaymentsSummary {
	readonly count: number;
	readonly amount: Rupiah;
}

/** The cash book as three numbers. */
export interface CashSummary {
	/** The running balance of the whole book — `cashBook`'s own `closingBalance`. */
	readonly balance: Rupiah;
	/** Money in, over the Transaksi Kas whose `occurredOn` falls in the WIB month. */
	readonly incomeThisMonth: Rupiah;
	/** Money out, over the same month. */
	readonly expenseThisMonth: Rupiah;
}

/** One of the three most recently published Post, as a Beranda line. */
export interface LatestPost {
	readonly id: string;
	readonly title: string;
	readonly type: PostType;
	readonly publishedAt: Date;
}

/** One scheduled job and the last thing that happened to it. */
export interface JobStatusSummary {
	readonly name: string;
	/** When its most recent run started, or `null` when it has never run. */
	readonly lastRunAt: Date | null;
	/** What that run came to, or `null` when it has never run. */
	readonly status: JobRunStatus | null;
}

/** The pengurus Beranda's whole load. */
export interface AdminDashboard {
	/** The WIB calendar month every "bulan ini" figure below is about, as `YYYY-MM`. */
	readonly month: string;
	readonly invoices: DashboardInvoiceSummary;
	readonly pendingPayments: PendingPaymentsSummary;
	/** `null` when this caller may not read the cash book — see this module's doc comment. */
	readonly cash: CashSummary | null;
	readonly complaints: OpenComplaintCounts;
	readonly latestPosts: readonly LatestPost[];
	/** `null` when this caller may not see the jobs; `[]` when none are registered. */
	readonly jobs: readonly JobStatusSummary[] | null;
}

/**
 * Everything the pengurus Beranda shows, for the WIB calendar month `clock` is in.
 *
 * Checks no permission of its own. `actorId` is passed to the two borrowed reads that guard
 * themselves, and a refusal from either leaves that one field `null` rather than failing the page —
 * see this module's doc comment for both halves of that decision.
 */
export async function adminDashboard(
	db: Database,
	clock: Clock,
	actorId: string
): Promise<AdminDashboard> {
	const now = clock.now();
	const month = civilMonthOf(now);
	const today = civilDayOf(now);

	return {
		month,
		invoices: await monthInvoiceSummary(db, month, today),
		pendingPayments: await pendingPaymentsSummary(db),
		cash: await cashSummary(db, actorId, month),
		complaints: await openComplaintCounts(db),
		latestPosts: await latestPublishedPosts(db),
		jobs: await jobStatuses(db, clock, actorId)
	};
}

/** What a Warga still owes on one house, counted over their own Tagihan. */
export interface ResidentOpenInvoices {
	/** Tagihan that are not lunas — belum bayar, sebagian and menunggak together. */
	readonly count: number;
	/** The sum of what is still owed on them. */
	readonly amount: Rupiah;
	/** How many of them are menunggak. */
	readonly overdueCount: number;
}

/** One house a Warga is living in right now. */
export interface ResidentUnitSummary {
	readonly unitId: string;
	/** `Blok A No 1` — the wording `../dues/verification.ts` already names a house by. */
	readonly label: string;
	readonly openInvoices: ResidentOpenInvoices;
	readonly creditBalance: Rupiah;
}

/** One Keluhan of the Warga's own that is still running. */
export interface ResidentComplaintSummary {
	readonly id: string;
	readonly title: string;
	readonly status: ComplaintStatus;
}

/** The Warga Beranda's whole load. */
export interface ResidentDashboard {
	/** One entry per house with a running Masa Huni. Empty when there is none. */
	readonly units: readonly ResidentUnitSummary[];
	/**
	 * Whether this Warga has a house at all. `false` is what lets the Beranda explain that their
	 * house is not linked yet instead of showing zeroes everywhere — story 21.
	 */
	readonly hasUnit: boolean;
	readonly complaints: readonly ResidentComplaintSummary[];
	readonly latestPosts: readonly LatestPost[];
}

/**
 * Everything the Warga Beranda shows for one Warga.
 *
 * Checks no permission and takes no caller other than the Warga it is about: `residentId` is a
 * `residents.id`, the key `complaints.reporterId` and `occupancies.residentId` are already written
 * in. A `residentId` naming no row is an empty Beranda with `hasUnit: false`, the same expected
 * state `occupiedUnitsForUser` gives an account with no `residents` row — not an error.
 */
export async function residentDashboard(
	db: Database,
	clock: Clock,
	residentId: string
): Promise<ResidentDashboard> {
	const [resident] = await db
		.select({ userId: residents.userId })
		.from(residents)
		.where(eq(residents.id, residentId))
		.limit(1);

	const unitSummaries = resident
		? await residentUnitSummaries(db, clock, residentId, resident.userId)
		: [];

	return {
		units: unitSummaries,
		hasUnit: unitSummaries.length > 0,
		complaints: await residentComplaints(db, residentId),
		latestPosts: await latestPublishedPosts(db)
	};
}

/**
 * This month's Tagihan, with every status decided by `invoiceStatus` against `today` rather than by
 * a comparison written here.
 *
 * A cancelled Tagihan is left out in the `where` clause rather than counted and then discarded: a
 * voided Tagihan is nothing owed at all, so it is not a Tagihan the month issued either — the same
 * reading `invoicesForUser` already takes.
 */
async function monthInvoiceSummary(
	db: Database,
	month: string,
	today: string
): Promise<DashboardInvoiceSummary> {
	const rows = await db
		.select({ invoiceId: invoices.id, amount: invoices.amount, dueDate: invoices.dueDate })
		.from(invoices)
		.where(and(eq(invoices.period, month), isNull(invoices.voidedAt)));

	const allocated = await allocatedAmountsByInvoice(
		db,
		rows.map((row) => row.invoiceId)
	);

	let issuedAmount = 0;
	let paidCount = 0;
	let paidAmount = 0;
	let overdueCount = 0;
	let overdueAmount = 0;

	for (const row of rows) {
		const allocatedAmount = allocated.get(row.invoiceId) ?? rupiah(0);
		issuedAmount += row.amount;
		const status = invoiceStatus(
			{ amount: row.amount, allocatedAmount, dueDate: row.dueDate, voidedAt: null },
			today
		);
		if (status === INVOICE_STATUS.paid) {
			paidCount += 1;
			paidAmount += row.amount;
		}
		if (status === INVOICE_STATUS.overdue) {
			overdueCount += 1;
			overdueAmount += row.amount - allocatedAmount;
		}
	}

	return {
		issuedCount: rows.length,
		issuedAmount: rupiah(issuedAmount),
		paidCount,
		paidAmount: rupiah(paidAmount),
		overdueCount,
		overdueAmount: rupiah(overdueAmount)
	};
}

/**
 * How much has been allocated to each of `invoiceIds`, keyed by invoice id and absent for one with
 * no allocation at all.
 *
 * The same query `allocatedAmountsByInvoice` in `../dues/queries.ts` runs, and deliberately not an
 * import of it: that one is private to its module, and this ticket's surface does not include
 * widening it. The shared part is the `::text` and `coalesce` idiom that module records — PostgreSQL
 * widens `sum(bigint)` to `numeric`, and `sum` over an empty group is `null`. No rule is duplicated
 * here, only a sum; the rule that reads it is `invoiceStatus`, which is imported.
 */
async function allocatedAmountsByInvoice(
	db: Database,
	invoiceIds: readonly string[]
): Promise<ReadonlyMap<string, Rupiah>> {
	if (invoiceIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			invoiceId: allocations.invoiceId,
			total: sql<string>`coalesce(sum(${allocations.amount}), 0)::text`
		})
		.from(allocations)
		.where(inArray(allocations.invoiceId, [...invoiceIds]))
		.groupBy(allocations.invoiceId);

	return new Map(rows.map((row) => [row.invoiceId, rupiah(Number(row.total))]));
}

/** Every Pembayaran still waiting for a decision, counted and totalled — story 14. */
async function pendingPaymentsSummary(db: Database): Promise<PendingPaymentsSummary> {
	const [row] = await db
		.select({
			total: count(),
			amount: sql<string>`coalesce(sum(${payments.amount}), 0)::text`
		})
		.from(payments)
		.where(eq(payments.status, PAYMENT_STATUS.pending));

	return { count: row?.total ?? 0, amount: rupiah(Number(row?.amount ?? '0')) };
}

/**
 * The saldo and this month's two flows, or `null` when `actorId` may not read the cash book.
 *
 * `occurredOn` is a `YYYY-MM-DD` string and `month` is `YYYY-MM`, so the prefix test is exact: no
 * other month's day can start with this month's text.
 */
async function cashSummary(
	db: Database,
	actorId: string,
	month: string
): Promise<CashSummary | null> {
	const book = await readableCashBook(db, actorId);
	if (!book) {
		return null;
	}

	let incomeThisMonth = 0;
	let expenseThisMonth = 0;
	for (const entry of book.entries) {
		if (!entry.occurredOn.startsWith(month)) {
			continue;
		}
		if (entry.type === CASH_CATEGORY_TYPE.income) {
			incomeThisMonth += entry.amount;
		} else {
			expenseThisMonth += entry.amount;
		}
	}

	return {
		balance: book.closingBalance,
		incomeThisMonth: rupiah(incomeThisMonth),
		expenseThisMonth: rupiah(expenseThisMonth)
	};
}

/** The whole cash book, or `null` when this caller is refused it. Nothing else is caught. */
async function readableCashBook(db: Database, actorId: string): Promise<CashBook | null> {
	try {
		return await cashBook(db, actorId);
	} catch (caught) {
		if (caught instanceof PermissionDeniedError) {
			return null;
		}
		throw caught;
	}
}

/** How many Keluhan sit in each open status right now — story 17. */
async function openComplaintCounts(db: Database): Promise<OpenComplaintCounts> {
	const rows = await db
		.select({ status: complaints.status, total: count() })
		.from(complaints)
		.where(inArray(complaints.status, [...OPEN_COMPLAINT_STATUSES]))
		.groupBy(complaints.status);

	// Written out rather than built from the constant so that adding a status to
	// `OPEN_COMPLAINT_STATUSES` fails `bun run check` here instead of returning a missing key.
	const counts: Record<OpenComplaintStatus, number> = { new: 0, reviewing: 0, working: 0 };
	for (const row of rows) {
		if (isOpenComplaintStatus(row.status)) {
			counts[row.status] = row.total;
		}
	}
	return counts;
}

/** Whether `status` is one of the three the query above asked for. */
function isOpenComplaintStatus(status: ComplaintStatus): status is OpenComplaintStatus {
	const open: readonly ComplaintStatus[] = OPEN_COMPLAINT_STATUSES;
	return open.includes(status);
}

/**
 * The three most recently published Post, newest first.
 *
 * "Terbaru" is `publishedAt`, not the `upcoming` ordering `listPublicPosts` uses: that one answers
 * "what is coming up" for the board, and this card answers "what was said last". A `published` row
 * always carries a `publishedAt`, and the `is not null` in the `where` clause is what lets the
 * ordering be total and the field be a `Date` rather than a nullable one.
 */
async function latestPublishedPosts(db: Database): Promise<readonly LatestPost[]> {
	const rows = await db
		.select({ id: posts.id, title: posts.title, type: posts.type, publishedAt: posts.publishedAt })
		.from(posts)
		.where(and(eq(posts.status, POST_STATUS.published), isNotNull(posts.publishedAt)))
		.orderBy(desc(posts.publishedAt), desc(posts.id))
		.limit(LATEST_POST_COUNT);

	const latest: LatestPost[] = [];
	for (const row of rows) {
		if (row.publishedAt !== null) {
			latest.push({ id: row.id, title: row.title, type: row.type, publishedAt: row.publishedAt });
		}
	}
	return latest;
}

/** Every registered job with its last run, or `null` when this caller may not see them — story 18. */
async function jobStatuses(
	db: Database,
	clock: Clock,
	actorId: string
): Promise<readonly JobStatusSummary[] | null> {
	try {
		const summaries = await listJobsWithLastRun({
			db,
			clock,
			registry: applicationJobs,
			actorId
		});
		return summaries.map((summary) => ({
			name: summary.name,
			lastRunAt: summary.lastRun?.startedAt ?? null,
			status: summary.lastRun?.status ?? null
		}));
	} catch (caught) {
		if (caught instanceof PermissionDeniedError) {
			return null;
		}
		throw caught;
	}
}

/**
 * Every house this Warga is living in today, with what it owes and what it has on deposit.
 *
 * "Living in today" is `stillRunningOn`, the one definition of it, so a Masa Huni given an end date
 * that has not arrived yet still counts. The Tagihan come from `invoicesForUser` — one call for
 * every house, already filtered to what this Warga may see and already carrying each status — and
 * are then split by house here rather than queried per house.
 */
async function residentUnitSummaries(
	db: Database,
	clock: Clock,
	residentId: string,
	userId: string
): Promise<readonly ResidentUnitSummary[]> {
	const today = civilDayOf(clock.now());
	const occupied = await db
		.selectDistinct({ unitId: units.id, block: units.block, number: units.number })
		.from(occupancies)
		.innerJoin(units, eq(units.id, occupancies.unitId))
		.where(and(eq(occupancies.residentId, residentId), stillRunningOn(occupancies.endedOn, today)));
	if (occupied.length === 0) {
		return [];
	}

	const view = await invoicesForUser(db, clock, userId);

	return Promise.all(
		occupied.map(async (unit) => ({
			unitId: unit.unitId,
			label: `Blok ${unit.block} No ${unit.number}`,
			openInvoices: openInvoicesOf(view.invoices, unit.unitId),
			creditBalance: await creditBalanceOfUnit(db, unit.unitId)
		}))
	);
}

/**
 * The rows of `unitId` that are not lunas, counted and totalled.
 *
 * `remainingAmount` rather than `amount`, so a Tagihan half answered by an Alokasi adds only what is
 * left of it; `invoicesForUser` has already left every cancelled Tagihan out.
 */
function openInvoicesOf(rows: readonly ResidentInvoiceRow[], unitId: string): ResidentOpenInvoices {
	let openCount = 0;
	let amount = 0;
	let overdueCount = 0;

	for (const row of rows) {
		if (row.unitId !== unitId || row.status === INVOICE_STATUS.paid) {
			continue;
		}
		openCount += 1;
		amount += row.remainingAmount;
		if (row.status === INVOICE_STATUS.overdue) {
			overdueCount += 1;
		}
	}

	return { count: openCount, amount: rupiah(amount), overdueCount };
}

/** This Warga's own Keluhan that are still running, newest first — story 12. */
async function residentComplaints(
	db: Database,
	residentId: string
): Promise<readonly ResidentComplaintSummary[]> {
	return db
		.select({ id: complaints.id, title: complaints.title, status: complaints.status })
		.from(complaints)
		.where(
			and(
				eq(complaints.reporterId, residentId),
				inArray(complaints.status, [...OPEN_COMPLAINT_STATUSES])
			)
		)
		.orderBy(desc(complaints.createdAt), desc(complaints.id));
}
