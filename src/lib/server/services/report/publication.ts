import { and, desc, eq, sql } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import {
	monthlyReports,
	type MonthlyReport,
	type MonthlyReportCategoryLine
} from '../../db/schema/monthly-report';
import { PERIOD_STATUS, periods } from '../../db/schema/period';
import type { Clock } from '../../ports/clock';
import { CASH_BOOK_MONTH_PATTERN } from '../cash/balance';
import { lockPeriod, listPeriods, periodLabel } from '../cash/period';
import { composeReportFigures, currentReportPeriod, type ReportFigures } from './composition';

/**
 * Publishing a Laporan Bulanan, and reading the published ones back — the numbered, frozen
 * publication of one Periode that `docs/spec-kas-laporan-v1.md` builds the whole feature around:
 * "angka-angkanya dibekukan pada saat terbit sehingga laporan revisi 1 tetap bisa dibaca setelah
 * revisi 2 ada. Membuka kunci periode tidak menghapus laporan mana pun."
 *
 * ## One transaction does three things, in this order, and the order is the argument
 *
 * `publishReport` opens one transaction and inside it: locks the Periode, works out which revision
 * number this is, and writes the row. User story 13 asks for the first two together — "menerbitkan
 * laporan bulanan, dan penerbitan itu mengunci periodenya" — and the order settles the rest.
 *
 * 1. **`lockPeriod` first.** It takes `for update` on the month's `periods` row (see
 *    `../cash/period.ts`), and that single row lock is what serialises publishers. It also refuses a
 *    month that is already locked, which is how a second publication of a month nobody has reopened
 *    is turned away before it computes anything: republishing without an unlock would be exactly the
 *    silent overwrite the spec exists to prevent.
 * 2. **Then the revision number**, read as `max(revision) + 1` for that Periode *while the row lock
 *    is held*. See the next section.
 * 3. **Then the figures**, composed inside the same transaction. `requireOpenPeriodFor` takes
 *    `for share` on the very row this transaction now holds `for update`, so no Transaksi Kas dated
 *    inside this month can commit between the lock and the freeze — see `composeReportFigures`.
 *
 * ## Gapless sequential revisions, and the race between two publishers
 *
 * `src/lib/server/db/schema/monthly-report.ts` states the gap in what the database can see: a
 * `CHECK` proves `revision >= 1` and a unique index proves `(periodId, revision)` is not taken
 * twice, but "berurutan tanpa celah" is a fact across rows that no single row can answer for. It is
 * this module's, and three things together make it true:
 *
 * - **The number is derived, never allocated.** `max(revision) + 1` over the rows that exist, not a
 *   PostgreSQL sequence. A sequence hands out a number at the moment it is asked and keeps it even
 *   when the transaction rolls back, so one refused publication — a missing revision reason, a
 *   permission denied, a constraint violation — would leave revision 3 published after revision 1
 *   with nothing in between and no way to tell what was lost. A derived number consumes nothing on
 *   failure: the whole transaction rolls back, and the next publisher reads the same `max` the
 *   failed one did.
 * - **Two publishers cannot read that `max` at the same time.** Both must pass through step 1, and
 *   `lockPeriod`'s `for update` on one `periods` row admits one of them at a time. The second waits
 *   there — not at the `select max(…)`, which is the read that would otherwise go stale — and when
 *   the first commits, READ COMMITTED gives the waiter a fresh snapshot in which the row now says
 *   `locked`, so `lockPeriod` refuses it with `PeriodRuleError` `alreadyLocked`. It never reaches
 *   the revision read at all. `tests/unit/report-revision.test.ts` forces exactly that interleaving
 *   with a second connection, the way `tests/unit/period-lock.test.ts` forces its own.
 * - **`monthly_reports_period_id_revision_unique` is the backstop, not the mechanism.** If the lock
 *   argument above were ever broken by a later change, two publishers computing the same number
 *   would collide on the index and one would fail — an error, never a duplicate, and never a gap.
 *
 * A month that has *never* been published has no `monthly_reports` row, so `max` is null and
 * `coalesce(max(revision), 0) + 1` is 1, which is what `monthly_reports_revision_check` demands and
 * what `monthly_reports_revision_reason_check` forbids a reason on.
 *
 * ## The revision reason is checked here, on both sides
 *
 * `monthly_reports_revision_reason_check` is two-sided — forbidden on revision 1, required above it
 * — and this module refuses both halves by name before the insert, so an admin reads a sentence
 * rather than a driver error. The database check remains the guarantee; `ReportRuleError` is how a
 * person finds out.
 *
 * ## Who is recorded, and where
 *
 * `publishedBy` on the row, and an audit entry beside it naming the Periode and the revision. The
 * lock that publication performs records its own audit entry through `lockPeriod`, so a month's
 * history reads as two facts that are both true: the month was locked, and this publication is what
 * locked it. The reason `lockPeriod` files is written in Indonesian, because that column already
 * holds the Indonesian sentences a superuser types when reopening a month, and a single audit
 * stream in two languages is worse than either.
 */

/** The audit log's `action` for a Laporan Bulanan that was published, with its revision in `after`. */
export const REPORT_PUBLISHED_ACTION = 'report_published';

/**
 * Every rule this module refuses a publication for, other than permission and other than the locked
 * month, which `PeriodRuleError` already names.
 *
 * The same shape as `CASH_RULE` and `PERIOD_RULE`, and for the same reason: the publishing screen
 * maps these through an exhaustive `Record`, so a rule added here is a type error on that screen
 * until somebody writes the sentence an admin reads. These refuse a *request*, never the caller, so
 * a route answers them with `fail(400, …)` rather than a 403.
 */
export const REPORT_RULE = {
	/** A revision above the first was asked for without the alasan every warga is shown. */
	revisionReasonMissing: 'revisionReasonMissing',
	/** An alasan was supplied for revision 1, which revises nothing and may not carry one. */
	revisionReasonNotAllowed: 'revisionReasonNotAllowed'
} as const;

/** One of the rules above. */
export type ReportRule = (typeof REPORT_RULE)[keyof typeof REPORT_RULE];

/**
 * Thrown when a publication is refused by one of the rules in `REPORT_RULE`.
 *
 * Named and `instanceof`-checkable for the reason `CashRuleError` and `PeriodRuleError` are: a route
 * tells this apart from "something broke" by catching the class and reading `rule`, never by
 * matching a message.
 */
export class ReportRuleError extends Error {
	override readonly name = 'ReportRuleError';

	/** Which rule refused the publication. */
	readonly rule: ReportRule;

	constructor(rule: ReportRule, detail: string) {
		super(`The Laporan Bulanan refused this publication (${rule}): ${detail}`);
		this.rule = rule;
	}
}

/** Which month is being published, by whom, and why this revision exists. */
export interface PublishReportRequest {
	/** The signed-in account. Checked against `ACTION.publishReports` before anything else. */
	readonly actorId: string;
	/** The Periode being published, as `YYYY-MM`. */
	readonly period: string;
	/**
	 * Why this revision exists, shown to every warga. Required above revision 1 and refused on it —
	 * both halves are checked here and re-checked by `monthly_reports_revision_reason_check`.
	 */
	readonly revisionReason?: string;
}

/**
 * Publishes one revision of one Periode's Laporan Bulanan: freezes the month's figures, numbers the
 * revision, and locks the month — all in one transaction, so that a report residents can read never
 * exists beside a month that still accepts new money.
 *
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`. A route validates
 *   its own input against `CASH_BOOK_MONTH_PATTERN`, so reaching this is a mistake in calling code.
 * @throws {PermissionDeniedError} when `actorId` may not publish. `CONTEXT.md` puts "menerbitkan
 *   Laporan Bulanan" on Admin; see `ACTION.publishReports` in `src/lib/server/authz.ts`.
 * @throws {PeriodRuleError} `alreadyLocked`, when the month has already been published and no
 *   superuser has reopened it.
 * @throws {ReportRuleError} `revisionReasonMissing` or `revisionReasonNotAllowed`.
 */
export async function publishReport(
	db: Database,
	clock: Clock,
	request: PublishReportRequest
): Promise<MonthlyReport> {
	const period = requirePeriod(request.period);
	const month = monthOf(period);

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.publishReports);

		const row = await lockPeriod(transaction, clock, {
			actorId: request.actorId,
			year: month.year,
			month: month.month,
			reason: `Penerbitan Laporan Bulanan periode ${period}.`
		});

		const revision = await nextRevisionFor(transaction, row.id);
		const revisionReason = requireRevisionReason(revision, request.revisionReason);
		const figures = await composeReportFigures(transaction, clock, period);

		const [report] = await transaction
			.insert(monthlyReports)
			.values({
				periodId: row.id,
				revision,
				publishedAt: clock.now(),
				publishedBy: request.actorId,
				revisionReason,
				openingBalance: figures.openingBalance,
				totalIncome: figures.totalIncome,
				totalExpense: figures.totalExpense,
				closingBalance: figures.closingBalance,
				duesCollected: figures.duesCollected,
				duesUnitsPaid: figures.duesUnitsPaid,
				duesUnitsUnpaid: figures.duesUnitsUnpaid,
				categoryBreakdown: [...figures.categoryBreakdown]
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: REPORT_PUBLISHED_ACTION,
			targetId: report.id,
			after: { period, revision, revisionReason }
		});
		return report;
	});
}

/** One published revision, as a list of them reads — no figures, only which revision it is. */
export interface PublishedReportRevision {
	readonly id: string;
	/** The Periode it publishes, as `YYYY-MM`. */
	readonly period: string;
	/** 1 for the first publication, 2 and up for revisions. */
	readonly revision: number;
	readonly publishedAt: Date;
	/** Why this revision exists. Null on revision 1, where the schema forbids one. */
	readonly revisionReason: string | null;
}

/**
 * The newest revision of every Periode that has ever been published, newest month first — the list
 * a warga opens at `/reports`.
 *
 * Only the newest revision of each month is listed. An older one is never unreachable: it is on the
 * report's own page, which carries every revision of its Periode so that "revisi lama tetap bisa
 * dibaca" holds. A list showing all of them would put four rows for one January in front of a reader
 * whose question is "which figures apply now", and the answer to that is always the newest.
 *
 * Takes no caller: a published Laporan Bulanan is readable by every signed-in Warga, so there is no
 * action to hold. The session check at the route is the whole guard — see `./resident-payload.ts`.
 */
export async function listPublishedReports(
	writer: DatabaseWriter
): Promise<readonly PublishedReportRevision[]> {
	const rows = await selectRevisions(writer);

	const newest = new Map<string, PublishedReportRevision>();
	for (const row of rows) {
		if (!newest.has(row.period)) {
			newest.set(row.period, row);
		}
	}
	return [...newest.values()];
}

/** One published revision with everything the page that renders it needs. */
export interface PublishedReport extends PublishedReportRevision {
	/** The figures as they were frozen when this revision went out. Never recomputed. */
	readonly figures: ReportFigures;
	/** Every revision of the same Periode, newest first, so an older one stays one click away. */
	readonly revisions: readonly PublishedReportRevision[];
	/** Whether this is the newest revision of its Periode. */
	readonly isLatest: boolean;
}

/**
 * One published revision of one Periode, read back exactly as it was frozen.
 *
 * @param revision which revision to read, or `undefined` for the newest there is — the answer to
 *   "which figures apply now".
 * @returns `undefined` when that Periode has no published report at all, or when `revision` names
 *   one that was never published. A route answers both with a 404: a revision number that does not
 *   exist and a month that was never published are the same thing to a reader.
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 */
export async function publishedReport(
	writer: DatabaseWriter,
	period: string,
	revision?: number
): Promise<PublishedReport | undefined> {
	const month = monthOf(requirePeriod(period));

	const rows = await writer
		.select({
			id: monthlyReports.id,
			revision: monthlyReports.revision,
			publishedAt: monthlyReports.publishedAt,
			revisionReason: monthlyReports.revisionReason,
			openingBalance: monthlyReports.openingBalance,
			totalIncome: monthlyReports.totalIncome,
			totalExpense: monthlyReports.totalExpense,
			closingBalance: monthlyReports.closingBalance,
			duesCollected: monthlyReports.duesCollected,
			duesUnitsPaid: monthlyReports.duesUnitsPaid,
			duesUnitsUnpaid: monthlyReports.duesUnitsUnpaid,
			categoryBreakdown: monthlyReports.categoryBreakdown
		})
		.from(monthlyReports)
		.innerJoin(periods, eq(periods.id, monthlyReports.periodId))
		.where(and(eq(periods.year, month.year), eq(periods.month, month.month)))
		.orderBy(desc(monthlyReports.revision));
	if (rows.length === 0) {
		return undefined;
	}

	const wanted = revision === undefined ? rows[0] : rows.find((row) => row.revision === revision);
	if (!wanted) {
		return undefined;
	}

	const revisions = rows.map((row): PublishedReportRevision => ({
		id: row.id,
		period,
		revision: row.revision,
		publishedAt: row.publishedAt,
		revisionReason: row.revisionReason
	}));
	return {
		id: wanted.id,
		period,
		revision: wanted.revision,
		publishedAt: wanted.publishedAt,
		revisionReason: wanted.revisionReason,
		isLatest: wanted.revision === rows[0].revision,
		revisions,
		figures: {
			openingBalance: wanted.openingBalance,
			totalIncome: wanted.totalIncome,
			totalExpense: wanted.totalExpense,
			closingBalance: wanted.closingBalance,
			duesCollected: wanted.duesCollected,
			duesUnitsPaid: wanted.duesUnitsPaid,
			duesUnitsUnpaid: wanted.duesUnitsUnpaid,
			categoryBreakdown: frozenBreakdown(wanted.categoryBreakdown)
		}
	};
}

/** Everything the screen an admin publishes from needs, for one month at a time. */
export interface ReportWorkbench {
	/** The month being previewed, as `YYYY-MM`. */
	readonly period: string;
	/** Every month worth offering in the picker, newest first. Always includes `period`. */
	readonly periods: readonly string[];
	/** This month as the buku kas stands right now — a preview, never a publication. */
	readonly figures: ReportFigures;
	/** Whether the month is locked, which is also whether publishing it again is possible today. */
	readonly isLocked: boolean;
	/** Every revision already published for this month, newest first. */
	readonly revisions: readonly PublishedReportRevision[];
	/** The number the next publication would carry. */
	readonly nextRevision: number;
	/** Whether that publication must carry an alasan. True from revision 2 on. */
	readonly revisionReasonRequired: boolean;
}

/**
 * The publishing screen's whole answer: one month's preview, its published revisions, and the state
 * of its lock.
 *
 * The preview is user story 12 — "melihat pratinjau laporan bulan berjalan kapan saja, supaya saya
 * tidak terkejut di akhir bulan" — and it is deliberately the same computation the publication
 * freezes, so that what an admin looked at is what they then published.
 *
 * The month list and the lock status come from `listPeriods` rather than from a second reader of
 * `periods` and `monthly_reports`: that function already returns every month the buku kas knows
 * about, its status, and the reports published inside it. `ACTION.readPeriods` is held by `admin`
 * and `superuser` both, so an admin who may publish already holds it; the two checks are not
 * redundant, because `publishReports` is the one that decides whether this screen may be opened at
 * all and `readPeriods` is the one `listPeriods` guards itself with.
 *
 * @throws {PermissionDeniedError} when `actorId` may not publish a Laporan Bulanan.
 * @throws {TypeError} when `period` is given and is not a calendar month written as `YYYY-MM`.
 */
export async function reportWorkbench(
	db: Database,
	clock: Clock,
	actorId: string,
	period?: string
): Promise<ReportWorkbench> {
	await requirePermission(db, actorId, ACTION.publishReports);

	const wanted = period === undefined ? currentReportPeriod(clock) : requirePeriod(period);
	const listing = await listPeriods(db, actorId);
	const summary = listing.periods.find((month) => month.period === wanted);

	const revisions = (summary?.reports ?? [])
		.map((report): PublishedReportRevision => ({
			id: report.id,
			period: wanted,
			revision: report.revision,
			publishedAt: report.publishedAt,
			revisionReason: report.revisionReason
		}))
		.sort((left, right) => right.revision - left.revision);
	const nextRevision = (revisions[0]?.revision ?? 0) + 1;

	const months = new Set(listing.periods.map((month) => month.period));
	months.add(wanted);
	months.add(currentReportPeriod(clock));

	return {
		period: wanted,
		periods: [...months].sort((left, right) => right.localeCompare(left)),
		figures: await composeReportFigures(db, clock, wanted),
		isLocked: summary?.status === PERIOD_STATUS.locked,
		revisions,
		nextRevision,
		revisionReasonRequired: nextRevision > 1
	};
}

/** Every published revision of every Periode, newest month first and newest revision first. */
async function selectRevisions(
	writer: DatabaseWriter
): Promise<readonly PublishedReportRevision[]> {
	const rows = await writer
		.select({
			id: monthlyReports.id,
			year: periods.year,
			month: periods.month,
			revision: monthlyReports.revision,
			publishedAt: monthlyReports.publishedAt,
			revisionReason: monthlyReports.revisionReason
		})
		.from(monthlyReports)
		.innerJoin(periods, eq(periods.id, monthlyReports.periodId))
		.orderBy(desc(periods.year), desc(periods.month), desc(monthlyReports.revision));

	return rows.map((row) => ({
		id: row.id,
		period: periodLabel(row),
		revision: row.revision,
		publishedAt: row.publishedAt,
		revisionReason: row.revisionReason
	}));
}

/**
 * The revision number the next publication of `periodId` would carry.
 *
 * Read inside the caller's transaction, after `lockPeriod` has taken `for update` on the Periode's
 * row — see this module's doc comment for why that order is the whole gaplessness argument.
 * `coalesce` rather than a null check in TypeScript: `max` over no rows is null, and a Periode that
 * has never been published is the ordinary case rather than an edge one.
 */
async function nextRevisionFor(transaction: Transaction, periodId: string): Promise<number> {
	const [row] = await transaction
		.select({ highest: sql<number>`coalesce(max(${monthlyReports.revision}), 0)` })
		.from(monthlyReports)
		.where(eq(monthlyReports.periodId, periodId));
	return Number(row?.highest ?? 0) + 1;
}

/**
 * The trimmed alasan for `revision`, or the refusal that says it is missing or not allowed.
 *
 * Both directions, because `monthly_reports_revision_reason_check` is two-sided. Revision 1 revises
 * nothing, so an alasan on it is a statement about an event that never happened; every revision
 * above it is shown to warga with its reason (user story 16), so one without a reason is a hole in
 * the public record.
 *
 * @throws {ReportRuleError} `revisionReasonMissing` or `revisionReasonNotAllowed`.
 */
function requireRevisionReason(revision: number, reason: string | undefined): string | null {
	const trimmed = reason?.trim() ?? '';
	if (revision === FIRST_REVISION) {
		if (trimmed !== '') {
			throw new ReportRuleError(
				REPORT_RULE.revisionReasonNotAllowed,
				'Revision 1 revises nothing, so it carries no alasan revisi.'
			);
		}
		return null;
	}
	if (trimmed === '') {
		throw new ReportRuleError(
			REPORT_RULE.revisionReasonMissing,
			`Revision ${revision} replaces figures warga have already read, so it states why.`
		);
	}
	return trimmed;
}

/** The revision number the first publication of a Periode carries. */
const FIRST_REVISION = 1;

/** Where the year ends in a `YYYY-MM`, which is also how many characters it takes. */
const YEAR_LENGTH = 4;

/**
 * `period` unchanged, or the `TypeError` that says it is not a calendar month.
 *
 * The same shape `composeReportFigures` refuses with, and for the same reason `assertPeriod` in
 * `../dues/invoice.ts` records: every caller has already checked it against
 * `CASH_BOOK_MONTH_PATTERN`, so reaching this is a mistake in calling code rather than a refusal a
 * person should read a sentence about.
 */
function requirePeriod(period: string): string {
	if (!CASH_BOOK_MONTH_PATTERN.test(period)) {
		throw new TypeError(`"${period}" is not a calendar month written as YYYY-MM.`);
	}
	return period;
}

/** `YYYY-MM` as the two integer columns `periods` keys a month by. */
function monthOf(period: string): { readonly year: number; readonly month: number } {
	return {
		year: Number(period.slice(0, YEAR_LENGTH)),
		month: Number(period.slice(YEAR_LENGTH + 1))
	};
}

/**
 * The frozen breakdown as it came back out of `jsonb`.
 *
 * Read back rather than re-derived, and ordered here rather than in SQL, because `jsonb` is a sealed
 * document: `src/lib/server/db/schema/monthly-report.ts` chose that shape precisely so that a
 * published revision is displayed whole and never filtered or summed by the database. Sorting by
 * name keeps two revisions of one month rendering their lines in the same order even if a later
 * publication wrote them in a different one.
 */
function frozenBreakdown(
	lines: readonly MonthlyReportCategoryLine[]
): readonly MonthlyReportCategoryLine[] {
	return [...lines].sort(
		(left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type)
	);
}
