import { and, eq, gte, sql } from 'drizzle-orm';
import { readOrigin } from '../../auth';
import type { Database } from '../../db';
import { emailQueue } from '../../db/schema/email';
import { monthlyReports } from '../../db/schema/monthly-report';
import { periods } from '../../db/schema/period';
import { enqueueEmail } from '../../email/queue';
import { MONTHLY_REPORT_KIND, monthlyReportPayload } from '../../email/templates/monthly-report';
import {
	MONTHLY_REPORT_REVISED_KIND,
	reportRevisedPayload
} from '../../email/templates/report-revised';
import type { Clock } from '../../ports/clock';
import { periodLabel } from '../cash/period';
import { residentsSubscribedTo, type SubscribedResident } from '../subscription';
import { SUBSCRIPTION_KIND } from '../subscription/kinds';
import { unsubscribeLink } from '../subscription/unsubscribe-token';

/**
 * Who hears about a Laporan Bulanan, and what they are sent: the two emails #37 adds, and the
 * idempotency rule that makes running the job twice harmless. `./jobs.ts` calls
 * `sendMonthlyReportEmails` on a schedule and on a superuser's manual trigger; `./publication.ts`
 * calls `notifyReportRevised` once, after its own transaction has committed.
 *
 * ## Who receives both emails
 *
 * `residentsSubscribedTo(db, SUBSCRIPTION_KIND.monthlyReport)` and nothing else. That function
 * already applies the kind's registry default — opt-in, off — for a resident who has never answered,
 * so a resident who never asked for the report receives nothing, and this module never has to know
 * that rule itself. A revision goes to the same list, for the reason `../../email/templates/report-revised.ts`
 * records: it corrects figures those very people were sent.
 *
 * ## "Running the job twice does not send it twice", and why the scheduler's lock is not the answer
 *
 * `job_runs` locks a job name together with a *schedule period*, which for this job is a day. That
 * says nothing about a Laporan Bulanan's Periode: a superuser pressing the manual trigger tomorrow
 * claims a different day and would happily send January again. The rule therefore lives here, and it
 * is read off the evidence rather than off a flag — `email_queue` already holds one row per email
 * ever queued, so a resident who has a `monthly-report` row whose payload names this Periode has
 * already been told about it. `sendMonthlyReportEmails` skips exactly those, which also means a run
 * that died halfway through finishes the rest the next day instead of starting over.
 *
 * ## Which Periode a run considers
 *
 * Every Periode whose **revision 1** was published inside `MONTHLY_REPORT_ANNOUNCEMENT_WINDOW_MILLISECONDS`
 * of now. Two decisions in one sentence:
 *
 * - **Revision 1 only.** It is the publication that announces a month exists; revisions 2 and up
 *   announce themselves, from `publishReport`, with their own reason. Sending the announcement from
 *   the newest revision instead would mean a resident whose January email arrived yesterday gets a
 *   second "laporan Januari terbit" today because the figures were corrected, which is not what
 *   happened.
 * - **A window, rather than every Periode ever published.** Without one, a resident who switches the
 *   Langganan on in 2028 would be sent every month of 2026 and 2027 at once, because none of those
 *   Periode carry a row for their address. The window is a little over a month, so an announcement
 *   is either sent while it is news or not at all — the report page is where an old month is read,
 *   and it is always one click away.
 *
 * ## Neither function here swallows its own failures, and only one of them may fail loudly
 *
 * `../dues/notification.ts` catches its own exceptions because its callers hand it no substitute.
 * This module's revision notification can be replaced through `PublishReportSettings.notify`, so the
 * guarantee that a committed publication is never reported as failed has to hold for *whatever* is
 * injected — which means it belongs at the call site, in `publishReport`, and that is where it is.
 * Putting it here as well would be a second, weaker copy of the same rule.
 *
 * `sendMonthlyReportEmails` throws on purpose: it is a job's whole body, and a job reports failure by
 * throwing so that the scheduler records it on the run and lets the day be attempted again.
 */

/** The locale both emails render in, until a resident's own language is a stored fact. */
const REPORT_EMAIL_LOCALE = 'id';

/** The revision that announces a Periode for the first time. */
const FIRST_REVISION = 1;

/** How many milliseconds are in a day, for the window below. */
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * How long after its publication a Periode is still worth announcing: thirty-five days, a little
 * more than the month it takes for the next Periode to be published. See this module's doc comment.
 */
export const MONTHLY_REPORT_ANNOUNCEMENT_WINDOW_MILLISECONDS = 35 * DAY_MILLISECONDS;

/** What one run of the sender did, for the line a job writes to the console. */
export interface MonthlyReportSendSummary {
	/** Every Periode the run considered, oldest first. */
	readonly periods: readonly string[];
	/** How many queue rows it wrote. */
	readonly enqueued: number;
	/** How many recipients it skipped because they had already been sent that Periode. */
	readonly alreadySent: number;
}

/**
 * Queues the `monthly-report` email for every recently published Periode that a subscriber has not
 * already been sent.
 *
 * @param db the plain database. There is no surrounding transaction: the publications this
 *   announces committed long before the job ran.
 */
export async function sendMonthlyReportEmails(
	db: Database,
	clock: Clock
): Promise<MonthlyReportSendSummary> {
	const announcements = await recentFirstPublications(db, clock);
	if (announcements.length === 0) {
		return { periods: [], enqueued: 0, alreadySent: 0 };
	}

	const recipients = await residentsSubscribedTo(db, SUBSCRIPTION_KIND.monthlyReport);
	if (recipients.length === 0) {
		return {
			periods: announcements.map((announcement) => announcement.period),
			enqueued: 0,
			alreadySent: 0
		};
	}

	const origin = readOrigin();
	let enqueued = 0;
	let alreadySent = 0;
	for (const announcement of announcements) {
		const sent = await recipientsAlreadySent(db, MONTHLY_REPORT_KIND, announcement.period);
		for (const recipient of recipients) {
			if (sent.has(recipient.email)) {
				alreadySent += 1;
				continue;
			}
			await enqueueEmail(db, clock, {
				recipient: recipient.email,
				kind: MONTHLY_REPORT_KIND,
				payload: monthlyReportPayload({
					period: announcement.period,
					openingBalance: announcement.openingBalance,
					totalIncome: announcement.totalIncome,
					totalExpense: announcement.totalExpense,
					closingBalance: announcement.closingBalance,
					reportUrl: reportUrl(origin, announcement.period),
					unsubscribeUrl: unsubscribeUrlFor(origin, recipient),
					locale: REPORT_EMAIL_LOCALE
				})
			});
			enqueued += 1;
		}
	}

	return {
		periods: announcements.map((announcement) => announcement.period),
		enqueued,
		alreadySent
	};
}

/** One run of the sender, as a sentence for the server console. */
export function describeMonthlyReportSend(summary: MonthlyReportSendSummary): string {
	const periods = summary.periods.length === 0 ? 'none' : summary.periods.join(', ');
	return `Monthly report emails: ${summary.enqueued} queued, ${summary.alreadySent} already sent, for period(s) ${periods}.`;
}

/** Which revision of which Periode was published, and why. */
export interface ReportRevisionAnnouncement {
	/** The Periode the revised report covers, as `YYYY-MM`. */
	readonly period: string;
	/** Which revision this is. Always 2 or more. */
	readonly revision: number;
	/** Why the revision exists, exactly as `monthly_reports.revisionReason` holds it. */
	readonly reason: string;
}

/**
 * Queues the `monthly-report-revised` email to every resident subscribed to the monthly report.
 *
 * Does nothing at all for revision 1, which revises nothing: `publishReport` already calls this only
 * above the first revision, and the check is repeated here so that the rule survives a second caller.
 *
 * @param db the plain database. The caller passes it once its own transaction has committed — never
 *   a transaction handle, which would put the email back inside the window it is deliberately
 *   outside of.
 */
export async function notifyReportRevised(
	db: Database,
	clock: Clock,
	announcement: ReportRevisionAnnouncement
): Promise<void> {
	if (announcement.revision <= FIRST_REVISION) {
		return;
	}
	const recipients = await residentsSubscribedTo(db, SUBSCRIPTION_KIND.monthlyReport);
	if (recipients.length === 0) {
		return;
	}
	const origin = readOrigin();
	for (const recipient of recipients) {
		await enqueueEmail(db, clock, {
			recipient: recipient.email,
			kind: MONTHLY_REPORT_REVISED_KIND,
			payload: reportRevisedPayload({
				period: announcement.period,
				revision: announcement.revision,
				reason: announcement.reason,
				reportUrl: reportUrl(origin, announcement.period),
				unsubscribeUrl: unsubscribeUrlFor(origin, recipient),
				locale: REPORT_EMAIL_LOCALE
			})
		});
	}
}

/** One Periode's first publication, with the figures that were frozen with it. */
interface FirstPublication {
	readonly period: string;
	readonly openingBalance: number;
	readonly totalIncome: number;
	readonly totalExpense: number;
	readonly closingBalance: number;
}

/**
 * Every Periode whose revision 1 was published inside the announcement window, oldest first.
 *
 * The figures come off the `monthly_reports` row rather than being recomputed: they are frozen there
 * precisely so that what a resident was told stays what they were told, however the buku kas moves
 * afterwards.
 */
async function recentFirstPublications(
	db: Database,
	clock: Clock
): Promise<readonly FirstPublication[]> {
	const since = new Date(clock.now().getTime() - MONTHLY_REPORT_ANNOUNCEMENT_WINDOW_MILLISECONDS);
	const rows = await db
		.select({
			year: periods.year,
			month: periods.month,
			publishedAt: monthlyReports.publishedAt,
			openingBalance: monthlyReports.openingBalance,
			totalIncome: monthlyReports.totalIncome,
			totalExpense: monthlyReports.totalExpense,
			closingBalance: monthlyReports.closingBalance
		})
		.from(monthlyReports)
		.innerJoin(periods, eq(periods.id, monthlyReports.periodId))
		.where(and(eq(monthlyReports.revision, FIRST_REVISION), gte(monthlyReports.publishedAt, since)))
		.orderBy(monthlyReports.publishedAt);

	return rows.map((row) => ({
		period: periodLabel(row),
		openingBalance: row.openingBalance,
		totalIncome: row.totalIncome,
		totalExpense: row.totalExpense,
		closingBalance: row.closingBalance
	}));
}

/**
 * Every address that already has a queue row of `kind` naming `period`.
 *
 * Every status counts, `failed` included: a row that was written and could not be delivered is still
 * a decision this application made once, and queuing it again would not make the mail server answer.
 */
async function recipientsAlreadySent(
	db: Database,
	kind: string,
	period: string
): Promise<ReadonlySet<string>> {
	const rows = await db
		.select({ recipient: emailQueue.recipient })
		.from(emailQueue)
		.where(and(eq(emailQueue.kind, kind), sql`${emailQueue.payload} ->> 'period' = ${period}`));
	return new Set(rows.map((row) => row.recipient));
}

/** The address of one Periode's report page. Built from `ORIGIN`, never from a request header. */
function reportUrl(origin: string, period: string): string {
	return `${origin.replace(/\/+$/, '')}/reports/${period}`;
}

/** The address of one recipient's own unsubscribe page, for the monthly report Langganan. */
function unsubscribeUrlFor(origin: string, recipient: SubscribedResident): string {
	return unsubscribeLink(origin, {
		residentId: recipient.residentId,
		kind: SUBSCRIPTION_KIND.monthlyReport
	});
}
