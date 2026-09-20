import {
	applicationJobs,
	dailySchedule,
	type JobDefinition,
	type JobRegistry
} from '../../scheduler';
import { COMPLEX_TIME_ZONE } from '../dues/issuance';
import {
	describeMonthlyReportSend,
	sendMonthlyReportEmails,
	type MonthlyReportSendSummary
} from './notification';

/**
 * Where the monthly report's email meets the scheduler: the job that calls
 * `sendMonthlyReportEmails`.
 *
 * It sits here, next to the work it does, rather than in `src/lib/server/scheduler/index.ts`, for
 * the reason decision 4 there states — `applicationJobs` holds the scheduler's own housekeeping and
 * nothing else, and "every other job is registered by whoever owns the work". `../dues/jobs.ts` is
 * the file this one copies, down to the idempotent registration and the call at module scope.
 *
 * Decisions settled here:
 *
 * 1. **The job's name is `send-monthly-report`, and it is now permanent.** It is written to
 *    `job_runs.job_name` beside a period and is half of the lock's key, so renaming it later would
 *    make every day it has already run for look unrun.
 * 2. **`dailySchedule(COMPLEX_TIME_ZONE)`, not a monthly one.** A Laporan Bulanan is published when
 *    a person gets round to publishing it — the second of the month, the eleventh, whenever the last
 *    receipt is entered — so a job that fires once a month would announce a Periode up to four weeks
 *    after it went out, or miss it entirely when the publication happened after that month's tick.
 *    A daily schedule means the announcement follows the publication by at most a day. The zone is
 *    the complex's own, the same constant `../dues/issuance.ts` publishes and for the same reason: a
 *    civil day has no meaning without one.
 * 3. **The job is not what makes the sending idempotent.** The lock covers one job name and one
 *    *day*, which says nothing about which Periode has already been announced — a manual trigger on
 *    a later day claims a different period and would be free to send January again. The rule that
 *    one Periode reaches one address once lives in `./notification.ts`, read off `email_queue`, and
 *    is proved by a test that runs this job twice over the same data.
 * 4. **Registration is idempotent**, for the reason `registerEmailJobs` records: `vite dev`
 *    re-executes a changed server module against the very same `applicationJobs`, and a duplicate
 *    name is a `TypeError` that would break the dev server on an unrelated edit.
 * 5. **The summary goes to the server console by default, and a test passes its own reporter.** The
 *    same shape and the same justification as `../dues/jobs.ts`: there is no logger in this
 *    application yet, `job_runs` has no column for a result, and `JobDefinition.run` answers `void`,
 *    so this is the only place a run's counts can be observed at runtime.
 *
 * Registering it is also the whole of "Superuser dapat memicu pengiriman secara manual":
 * `/admin/jobs` walks `applicationJobs` through `listJobsWithLastRun` and offers a trigger for every
 * job it finds, so that page needed no change.
 *
 * Nothing here is registered unless something imports this module, and `src/hooks.server.ts` is the
 * one composition root that does.
 */

/**
 * The name this job is registered, locked and shown under. An identifier, so English, and stable
 * forever — see decision 1 above.
 */
export const MONTHLY_REPORT_JOB_NAME = 'send-monthly-report';

/** What a monthly report job may have handed to it instead of the production wiring. */
export interface MonthlyReportJobSettings {
	/**
	 * Where the run's summary is reported. Defaults to the server console; a test passes its own so
	 * that a run under Vitest is asserted on rather than printed.
	 */
	readonly report?: (summary: MonthlyReportSendSummary) => void;
}

/**
 * Builds the job that queues the Laporan Bulanan emails.
 *
 * @param settings what to use instead of the production wiring. The running application passes
 *   nothing.
 */
export function monthlyReportJob(settings: MonthlyReportJobSettings = {}): JobDefinition {
	const report = settings.report ?? reportSending;

	return {
		name: MONTHLY_REPORT_JOB_NAME,
		schedule: dailySchedule(COMPLEX_TIME_ZONE),
		run: async ({ db, clock }) => {
			report(await sendMonthlyReportEmails(db, clock));
		}
	};
}

/**
 * Puts the monthly report job in a registry, once.
 *
 * Called at module scope below, so that importing this module is all a composition root has to do —
 * and called again by nothing, because doing it twice is a no-op by decision 4 above.
 *
 * @param registry defaults to `applicationJobs`, which is the registry `/admin/jobs` lists and the
 *   periodic trigger ticks.
 */
export function registerReportJobs(registry: JobRegistry = applicationJobs): void {
	if (registry.get(MONTHLY_REPORT_JOB_NAME)) {
		return;
	}
	registry.register(monthlyReportJob());
}

registerReportJobs();

/**
 * Where a run's summary goes by default. The console the server already writes its scheduler errors
 * to is the honest place for it until this application has a logger — see decision 5 above.
 */
function reportSending(summary: MonthlyReportSendSummary): void {
	console.info(describeMonthlyReportSend(summary));
}
