import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
	ACTION,
	isAllowed,
	requirePermission,
	rolesOf,
	type DatabaseWriter,
	type Transaction
} from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { cashTransactions } from '../../db/schema/cash-transaction';
import { monthlyReports } from '../../db/schema/monthly-report';
import { PERIOD_STATUS, periods, type Period, type PeriodStatus } from '../../db/schema/period';
import type { Clock } from '../../ports/clock';

/**
 * The Periode: one calendar month of the buku kas, either open or locked, and the rule every writer
 * of money has to respect. `CONTEXT.md` defines it as "satu bulan kalender buku kas, berstatus
 * terbuka atau terkunci", and `docs/spec-kas-laporan-v1.md` says what the status is *for*: once a
 * Laporan Bulanan has been published, residents have read numbers for that month, so a transaction
 * dated inside it may not appear until a superuser reopens the month with a reason (user stories 14
 * and 15).
 *
 * ## The lifecycle decision this module owns, stated once
 *
 * **A month with no `periods` row is open, and the first write dated inside it creates the row.**
 * #34 deliberately left the rule unenforced rather than decide this, because deciding it there
 * would have made the recording transaction the creator of `periods` rows and the owner of the race
 * on `periods_year_month_unique`. Both belong here, and both are settled below:
 *
 * - `requireOpenPeriodFor` is the write-path contract. It creates the month's row when there is
 *   none, takes a share lock on it, and refuses with `PeriodLockedError` when the row says `locked`.
 *   It takes a `Transaction`, never a `Database`, because a check that is not inside the caller's
 *   own transaction is a stale read by the time the row is inserted.
 * - `isDateInLockedPeriod` is the plain question, with no lock and no row creation, for a screen
 *   deciding whether to draw a button. **A write path must never use it in place of
 *   `requireOpenPeriodFor`**: between the predicate answering `false` and the insert landing, a
 *   superuser's publication can lock the month, and nothing would have stopped it.
 *
 * ## The insert race on `periods_year_month_unique`, and how it is resolved
 *
 * Two admins recording the first transaction of a new month reach `openPeriodRow` at the same time.
 * `db.transaction` runs at PostgreSQL's default READ COMMITTED, so a plain `select` sees no row for
 * either of them, both insert, and the second gets a unique-violation error out of a code path that
 * has nothing wrong with it — a 500 on an ordinary recording.
 *
 * `insert … on conflict (year, month) do nothing` is what removes it, and the removal is real
 * rather than hopeful: PostgreSQL's speculative insertion makes the second statement *wait* on the
 * first transaction's unpublished row instead of failing, and then do nothing once it commits. The
 * `select … for share` that follows is a second statement, so under READ COMMITTED it takes a fresh
 * snapshot and sees the row the winner committed. `tests/unit/period-lock.test.ts` proves exactly
 * that interleaving with a second connection holding an uncommitted insert of the same month — not
 * with two concurrent calls, which would only prove that the race is rare.
 *
 * ## Why `for share` on the read, and `for update` on the two writes
 *
 * The same reasoning `lockOpeningBalanceCategory` and `lockTransaction` record, with one difference
 * worth the extra lock strength. A recorder does not change the Periode row; it only needs the row
 * to still say what it said when the money row lands beside it. A locker does change it. So:
 *
 * - `requireOpenPeriodFor` takes `for share`, which lets any number of concurrent recordings in one
 *   month proceed together and still blocks `lockPeriod`'s `for update` until every one of them has
 *   committed. Without it, `lockPeriod` could commit between a recorder's check and its insert, and
 *   the published report would be missing a transaction dated inside the month it froze.
 * - `lockPeriod` and `unlockPeriod` take `for update`, so the two directions of the switch, and any
 *   two callers of either, contend on one row rather than on a read each of them already made.
 *
 * The lock order is the same everywhere money is written — the row being corrected first (held by
 * `./correction.ts`), then the Periode — so there is no pair of transactions that can take these
 * two locks in opposite orders, which is what a deadlock would need.
 *
 * ## Who may do what
 *
 * - `ACTION.unlockPeriods` is `superuser`'s. `CONTEXT.md` names "pembukaan kunci Periode" in
 *   Superuser's own sentence, and the acceptance criteria says outright that `admin` cannot.
 * - `ACTION.readPeriods` is `admin`'s **and** `superuser`'s — see the argument beside it in
 *   `src/lib/server/authz.ts`.
 * - `lockPeriod` carries no permission check of its own, and that is deliberate. Locking is not a
 *   use case somebody invokes; it is what publishing a Laporan Bulanan does to the month it froze,
 *   and `CONTEXT.md` puts "menerbitkan Laporan Bulanan" on **Admin**. Guarding this transition with
 *   the superuser-only unlock action would therefore make the publication #36 has to write
 *   impossible for the role that is supposed to perform it. It takes a `Transaction` rather than a
 *   `Database` for the same reason `recordAuditEntry` takes a writer: it is a step inside somebody
 *   else's transaction, reachable only from a service that already opened one and already checked
 *   the action that entitles it to publish.
 *
 * ## Who is recorded, and where
 *
 * Nowhere on this table. `src/lib/server/db/schema/period.ts` deliberately has no `lockedBy` and no
 * unlock reason column — "who locked, who unlocked, when and why are history of *operations*" — so
 * the actor and the reason go to the audit log, in the same transaction as the status change.
 * `audit_log.actor_id` is plain `text` holding a `user.id` with no foreign key at all, so a
 * superuser who has no `residents` row is never shut out of unlocking a month. That is the trap
 * `exemptions.createdBy` fell into by referencing `residents.id`, and this module does not repeat
 * it.
 */

/** The audit log's `action` for a Periode that was locked, with the reason in `after`. */
export const PERIOD_LOCKED_ACTION = 'period_locked';

/** The audit log's `action` for a Periode a superuser reopened, with the reason in `after`. */
export const PERIOD_UNLOCKED_ACTION = 'period_unlocked';

/** How many months a year has, so that "1 through 12" is written once. */
const MONTHS_IN_YEAR = 12;

/** The shape a day arrives in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Where the year ends in a `YYYY-MM-DD`, which is also how many characters it takes. */
const YEAR_LENGTH = 4;

/** Where the month part of a `YYYY-MM-DD` ends. */
const MONTH_END = 7;

/**
 * Every rule this module refuses a request for, other than permission and other than the locked
 * month itself, which has a named error of its own.
 *
 * The same shape as `CASH_RULE` in `./transaction.ts`, and for the same reason: the period screen
 * maps these through an exhaustive `Record`, so a rule added here is a type error on that screen
 * until somebody writes the sentence a person reads. These are refusals of a *request*, never of
 * the caller — the superuser was inside their rights — so a route answers them with `fail(400, …)`
 * rather than with a 403.
 *
 * "No such Periode" is folded in as `alreadyOpen` rather than given an error class of its own,
 * because a month with no row is open: that is this module's lifecycle decision, and answering a
 * request to reopen it with two different refusals would state the opposite.
 */
export const PERIOD_RULE = {
	/** The year and month are not a month that exists. */
	notACalendarMonth: 'notACalendarMonth',
	/** The reason is empty. Both directions of the switch record one in the audit log. */
	reasonMissing: 'reasonMissing',
	/** Asked to unlock a Periode that is not locked — including a month with no row yet. */
	alreadyOpen: 'alreadyOpen',
	/** Asked to lock a Periode that is already locked. */
	alreadyLocked: 'alreadyLocked'
} as const;

/** One of the rules above. */
export type PeriodRule = (typeof PERIOD_RULE)[keyof typeof PERIOD_RULE];

/**
 * Thrown when a Periode request is refused by one of the rules in `PERIOD_RULE`.
 *
 * Named and `instanceof`-checkable for the reason `CashRuleError` is: a route tells this apart from
 * "something broke" by catching the class and reading `rule`, never by matching a message.
 */
export class PeriodRuleError extends Error {
	override readonly name = 'PeriodRuleError';

	/** Which rule refused the request. */
	readonly rule: PeriodRule;

	constructor(rule: PeriodRule, detail: string) {
		super(`The Periode refused this request (${rule}): ${detail}`);
		this.rule = rule;
	}
}

/**
 * Thrown when a transaction is dated inside a Periode that is locked — the acceptance criteria's
 * "galat bernama yang menyebut periodenya", so every field somebody would need to say which month
 * it was is on the error rather than only inside its message.
 *
 * It is not a member of `CASH_RULE`, although it refuses a cash write. `CASH_RULE` is mapped by an
 * exhaustive `Record` on the two cash screens, and those two files are outside this ticket's
 * surface, so adding a member there would be a type error this ticket may not fix. The class is
 * what a route catches instead; see this ticket's pull request for the one-branch follow-up each of
 * those screens needs.
 */
export class PeriodLockedError extends Error {
	override readonly name = 'PeriodLockedError';

	/** The date that fell inside the locked month. */
	readonly occurredOn: string;
	/** The `periods` row that refused it. */
	readonly periodId: string;
	readonly year: number;
	readonly month: number;
	/** The month as `YYYY-MM`, the way `invoices.period` writes one. */
	readonly period: string;

	constructor(occurredOn: string, period: Period) {
		super(
			`Periode "${periodLabel(period)}" is locked, so a cash transaction dated ${occurredOn} may not be written into it. A superuser reopens the month with a reason first.`
		);
		this.occurredOn = occurredOn;
		this.periodId = period.id;
		this.year = period.year;
		this.month = period.month;
		this.period = periodLabel(period);
	}
}

/** One calendar month, as `periods` stores it in two integer columns. */
export interface CalendarMonth {
	readonly year: number;
	/** 1 through 12. */
	readonly month: number;
}

/** One calendar month as `YYYY-MM` — the bridge `src/lib/server/db/schema/period.ts` documents. */
export function periodLabel(month: CalendarMonth): string {
	return `${month.year}-${String(month.month).padStart(2, '0')}`;
}

/**
 * The Periode `occurredOn` falls in, created when the month has none, share-locked until the
 * caller's transaction ends, and open — or the refusal that says it is not.
 *
 * **This is the contract every write path that dates money takes**, and the reason it takes a
 * `Transaction` rather than a `Database` is that the answer is only true for as long as the
 * caller's transaction holds the lock. `./transaction.ts` calls it after the category is known and
 * before the insert; `./correction.ts` calls it against the *corrected row's* `occurredOn`, inside
 * the transaction that already holds that row's lock. #29's payment verification writes a Transaksi
 * Kas of its own and calls it the same way.
 *
 * @throws {TypeError} when `occurredOn` is not shaped `YYYY-MM-DD`. Every caller has already checked
 *   that, or read it back out of a `date` column, so reaching this is a mistake in calling code.
 * @throws {PeriodLockedError} when the month it falls in is locked.
 */
export async function requireOpenPeriodFor(
	transaction: Transaction,
	clock: Clock,
	occurredOn: string
): Promise<Period> {
	const period = await openPeriodRow(transaction, clock, monthOf(occurredOn));
	if (period.status === PERIOD_STATUS.locked) {
		throw new PeriodLockedError(occurredOn, period);
	}
	return period;
}

/**
 * Whether `day` falls inside a Periode that is locked right now.
 *
 * The plain question, with no lock, no row creation and no caller: it is for a screen deciding
 * whether to offer a button, and for whatever read a later ticket wants to explain itself with. A
 * month with no `periods` row answers `false`, which is this module's lifecycle decision rather
 * than a convenience — nothing has ever been locked there, and the first write dated inside it will
 * create the row open.
 *
 * It takes no caller because it decides nothing: the screen around it is already guarded by
 * whatever action it needs, the same reasoning `listActiveCashCategories` records. **A write path
 * uses `requireOpenPeriodFor` instead**, because an answer read outside the writing transaction is
 * stale the moment it is returned.
 *
 * @throws {TypeError} when `day` is not shaped `YYYY-MM-DD`.
 */
export async function isDateInLockedPeriod(writer: DatabaseWriter, day: string): Promise<boolean> {
	const month = monthOf(day);
	const [row] = await writer
		.select({ status: periods.status })
		.from(periods)
		.where(and(eq(periods.year, month.year), eq(periods.month, month.month)));
	return row?.status === PERIOD_STATUS.locked;
}

/** Who is locking which month, and why the audit log should say it happened. */
export interface LockPeriodRequest extends CalendarMonth {
	/** The account the audit row is filed under. */
	readonly actorId: string;
	/** Why the month is being closed — for a publication, which Laporan Bulanan closed it. */
	readonly reason: string;
}

/**
 * Locks one Periode, creating its row when the month has none, and records the reason in the audit
 * log inside the caller's own transaction.
 *
 * **It checks no permission of its own.** See the "Who may do what" section of this module's doc
 * comment: publishing a Laporan Bulanan is Admin's in `CONTEXT.md`, unlocking a Periode is
 * Superuser's, and guarding this transition with the unlock action would make the publication that
 * performs it impossible for the role that is meant to. Taking a `Transaction` is what keeps it out
 * of a route's reach: only a service that has already opened a transaction — and therefore already
 * checked the action that let it get this far — holds one.
 *
 * @throws {PeriodRuleError} `notACalendarMonth`, `reasonMissing`, or `alreadyLocked`.
 */
export async function lockPeriod(
	transaction: Transaction,
	clock: Clock,
	request: LockPeriodRequest
): Promise<Period> {
	const month = requireCalendarMonth(request);
	const reason = requireReason(request.reason);

	const existing = await openPeriodRow(transaction, clock, month, 'update');
	if (existing.status === PERIOD_STATUS.locked) {
		throw new PeriodRuleError(
			PERIOD_RULE.alreadyLocked,
			`Periode "${periodLabel(month)}" is already locked.`
		);
	}

	const row = await setStatus(transaction, existing.id, PERIOD_STATUS.locked);
	await recordAuditEntry(transaction, clock, {
		actorId: request.actorId,
		action: PERIOD_LOCKED_ACTION,
		targetId: row.id,
		before: { status: existing.status },
		after: { status: row.status, period: periodLabel(row), reason }
	});
	return row;
}

/** Who is unlocking which month, and the alasan the acceptance criteria makes mandatory. */
export interface UnlockPeriodRequest extends CalendarMonth {
	/** The signed-in superuser. Checked against `ACTION.unlockPeriods` before anything else. */
	readonly actorId: string;
	/** Why the month is being reopened. Required, and recorded in the audit log. */
	readonly reason: string;
}

/**
 * Reopens one locked Periode, with a reason, and records both in the audit log.
 *
 * Unlocking never creates a row: a month with no row is already open, so there is nothing to
 * reopen, and writing one would put a Periode into the table to record an event that did not
 * happen.
 *
 * @throws {PermissionDeniedError} when `actorId` may not unlock a Periode. `admin` may not; see
 *   `ACTION.unlockPeriods` in `src/lib/server/authz.ts`.
 * @throws {PeriodRuleError} `notACalendarMonth`, `reasonMissing`, or `alreadyOpen`.
 */
export async function unlockPeriod(
	db: Database,
	clock: Clock,
	request: UnlockPeriodRequest
): Promise<Period> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.unlockPeriods);
		const month = requireCalendarMonth(request);
		const reason = requireReason(request.reason);

		const existing = await findPeriodForUpdate(transaction, month);
		if (!existing || existing.status !== PERIOD_STATUS.locked) {
			throw new PeriodRuleError(
				PERIOD_RULE.alreadyOpen,
				`Periode "${periodLabel(month)}" is not locked, so there is nothing to reopen.`
			);
		}

		const row = await setStatus(transaction, existing.id, PERIOD_STATUS.open);
		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: PERIOD_UNLOCKED_ACTION,
			targetId: row.id,
			before: { status: existing.status },
			after: { status: row.status, period: periodLabel(row), reason }
		});
		return row;
	});
}

/** One published revision of a Periode's Laporan Bulanan, as the period screen shows it. */
export interface PublishedReportSummary {
	readonly id: string;
	/** 1 for the first publication, 2 and up for revisions. */
	readonly revision: number;
	readonly publishedAt: Date;
	/** Why this revision exists. Null on revision 1, where the schema forbids one. */
	readonly revisionReason: string | null;
}

/** One month of the cash book as the period screen reads it. */
export interface PeriodSummary extends CalendarMonth {
	/** The `periods` row, or null for a month that has transactions but no row yet. */
	readonly id: string | null;
	/** The month as `YYYY-MM`. */
	readonly period: string;
	/** `open` for a month with no row — see this module's lifecycle decision. */
	readonly status: PeriodStatus;
	/** How many Transaksi Kas are dated inside the month. */
	readonly transactionCount: number;
	/** Every published revision of this month's Laporan Bulanan, oldest revision first. */
	readonly reports: readonly PublishedReportSummary[];
}

/** The period screen's whole answer. */
export interface PeriodListing {
	/** Newest month first. */
	readonly periods: readonly PeriodSummary[];
	/**
	 * Whether this caller may reopen a locked month, so the screen knows whether to draw the button.
	 * Decided here rather than at the route, the same way `complaintReadScopeFor` and
	 * `unitVisibilityFor` answer a capability question in the service layer. Hiding the button is
	 * never the authorization — `unlockPeriod` refuses on its own — it only keeps the screen from
	 * offering an admin something the next click would refuse.
	 */
	readonly mayUnlock: boolean;
}

/**
 * Every Periode with its status and its published reports, newest month first.
 *
 * The list is the union of two things, because the acceptance criteria asks for a Periode "untuk
 * setiap bulan yang punya transaksi, atau dibuat pada saat dibutuhkan": every `periods` row there
 * is, plus every month that has a Transaksi Kas in it but no row yet. The second kind is shown as
 * open with a null id, which is exactly what it is — nothing has ever locked it, and the next write
 * dated inside it will materialise the row. Leaving those months off the screen would hide the
 * months an admin most wants to see.
 *
 * @throws {PermissionDeniedError} when `actorId` may not read the Periode list.
 */
export async function listPeriods(db: Database, actorId: string): Promise<PeriodListing> {
	await requirePermission(db, actorId, ACTION.readPeriods);

	const [rows, counts, reports, roles] = await Promise.all([
		db.select().from(periods).orderBy(desc(periods.year), desc(periods.month)),
		transactionCountsByMonth(db),
		reportsByPeriod(db),
		rolesOf(db, actorId)
	]);

	const summaries: PeriodSummary[] = rows.map((row) => ({
		id: row.id,
		year: row.year,
		month: row.month,
		period: periodLabel(row),
		status: row.status,
		transactionCount: counts.get(periodLabel(row)) ?? 0,
		reports: reports.get(row.id) ?? []
	}));

	const materialised = new Set(summaries.map((summary) => summary.period));
	for (const [label, transactionCount] of counts) {
		if (!materialised.has(label)) {
			summaries.push({ ...derivedMonth(label), transactionCount, reports: [] });
		}
	}

	summaries.sort((left, right) => right.year - left.year || right.month - left.month);
	return { periods: summaries, mayUnlock: isAllowed(roles, ACTION.unlockPeriods) };
}

/**
 * How many Transaksi Kas each month holds, keyed by `YYYY-MM`.
 *
 * A `Map`, never an object literal. The keys are built from data, but a lookup in an object literal
 * answers for names nobody put in it — `constructor` comes back truthy and defeats the `?? 0`
 * fallback above — and there is no reason to leave that shape lying in a file that a later ticket
 * will key by something a caller chose.
 */
async function transactionCountsByMonth(db: Database): Promise<ReadonlyMap<string, number>> {
	const monthOfTransaction = sql<string>`to_char(${cashTransactions.occurredOn}, 'YYYY-MM')`;
	const rows = await db
		.select({ month: monthOfTransaction, total: sql<string>`count(*)::text` })
		.from(cashTransactions)
		.groupBy(monthOfTransaction)
		.orderBy(desc(monthOfTransaction));
	return new Map(rows.map((row) => [row.month, Number(row.total)]));
}

/** Every published report, grouped under the Periode it publishes, oldest revision first. */
async function reportsByPeriod(
	db: Database
): Promise<ReadonlyMap<string, readonly PublishedReportSummary[]>> {
	const rows = await db
		.select({
			id: monthlyReports.id,
			periodId: monthlyReports.periodId,
			revision: monthlyReports.revision,
			publishedAt: monthlyReports.publishedAt,
			revisionReason: monthlyReports.revisionReason
		})
		.from(monthlyReports)
		.orderBy(asc(monthlyReports.revision));

	const grouped = new Map<string, PublishedReportSummary[]>();
	for (const row of rows) {
		const existing = grouped.get(row.periodId);
		const summary = {
			id: row.id,
			revision: row.revision,
			publishedAt: row.publishedAt,
			revisionReason: row.revisionReason
		};
		if (existing) {
			existing.push(summary);
		} else {
			grouped.set(row.periodId, [summary]);
		}
	}
	return grouped;
}

/** A month that has transactions but no `periods` row yet, as the listing shows it. */
function derivedMonth(label: string): Omit<PeriodSummary, 'transactionCount' | 'reports'> {
	return {
		id: null,
		year: Number(label.slice(0, YEAR_LENGTH)),
		month: Number(label.slice(YEAR_LENGTH + 1)),
		period: label,
		status: PERIOD_STATUS.open
	};
}

/**
 * The Periode row for `month`, created open when there is none, locked at `strength` until the
 * caller's transaction ends.
 *
 * The `insert … on conflict do nothing` followed by a locking `select` is the whole answer to the
 * race on `periods_year_month_unique`; the argument is in this module's doc comment, and
 * `tests/unit/period-lock.test.ts` forces the interleaving it describes.
 */
async function openPeriodRow(
	transaction: Transaction,
	clock: Clock,
	month: CalendarMonth,
	strength: 'share' | 'update' = 'share'
): Promise<Period> {
	await transaction
		.insert(periods)
		.values({
			year: month.year,
			month: month.month,
			status: PERIOD_STATUS.open,
			createdAt: clock.now()
		})
		.onConflictDoNothing({ target: [periods.year, periods.month] });

	const [row] = await transaction
		.select()
		.from(periods)
		.where(and(eq(periods.year, month.year), eq(periods.month, month.month)))
		.for(strength);
	if (!row) {
		// Unreachable: the statement above either inserted this row or waited for the transaction that
		// did and saw it commit. Stated rather than asserted away, so a future change that makes it
		// reachable fails loudly instead of returning something invented.
		throw new Error(
			`Periode "${periodLabel(month)}" is neither present nor insertable, which should not be possible.`
		);
	}
	return row;
}

/** The Periode row for `month` locked for update, or `undefined` when the month has no row. */
async function findPeriodForUpdate(
	transaction: Transaction,
	month: CalendarMonth
): Promise<Period | undefined> {
	const [row] = await transaction
		.select()
		.from(periods)
		.where(and(eq(periods.year, month.year), eq(periods.month, month.month)))
		.for('update');
	return row;
}

/** Flips one Periode's status and hands back the row as it now stands. */
async function setStatus(
	transaction: Transaction,
	periodId: string,
	status: PeriodStatus
): Promise<Period> {
	const [row] = await transaction
		.update(periods)
		.set({ status })
		.where(eq(periods.id, periodId))
		.returning();
	return row;
}

/** The calendar month a `YYYY-MM-DD` falls in. */
function monthOf(day: string): CalendarMonth {
	if (!DAY_PATTERN.test(day)) {
		throw new TypeError(`"${day}" is not a calendar day written as YYYY-MM-DD.`);
	}
	return {
		year: Number(day.slice(0, YEAR_LENGTH)),
		month: Number(day.slice(YEAR_LENGTH + 1, MONTH_END))
	};
}

/**
 * Refuses a year and month that are not a month on the calendar — by name, before the insert lets
 * `periods_month_check` refuse it as a driver error nobody named.
 *
 * No range is put on the year. `src/lib/server/db/schema/period.ts` declined to invent one and gave
 * its reason; a service-layer range would be the same invention one layer up.
 *
 * @throws {PeriodRuleError} `notACalendarMonth`.
 */
function requireCalendarMonth(month: CalendarMonth): CalendarMonth {
	const known =
		Number.isInteger(month.year) &&
		Number.isInteger(month.month) &&
		month.month >= 1 &&
		month.month <= MONTHS_IN_YEAR;
	if (!known) {
		throw new PeriodRuleError(
			PERIOD_RULE.notACalendarMonth,
			`Year ${month.year} month ${month.month} is not a month on the calendar; a month is 1 through ${MONTHS_IN_YEAR}.`
		);
	}
	return { year: month.year, month: month.month };
}

/**
 * The trimmed reason, or the refusal that says it is missing.
 *
 * Both directions of the switch demand one: the acceptance criteria makes it explicit for unlocking
 * ("dengan alasan wajib"), and requires that locking be audited "beserta alasannya" too. An audit
 * row saying a month was reopened, with no word about why, is the silent unlock this whole feature
 * exists to prevent.
 *
 * @throws {PeriodRuleError} `reasonMissing`.
 */
function requireReason(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed === '') {
		throw new PeriodRuleError(
			PERIOD_RULE.reasonMissing,
			'Changing a Periode lock records a reason in the audit log, so an empty one is refused.'
		);
	}
	return trimmed;
}
