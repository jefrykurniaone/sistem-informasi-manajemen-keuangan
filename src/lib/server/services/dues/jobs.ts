import * as m from '#lib/paraglide/messages.js';
import { formatMonthLabel } from '../../../time';
import {
	applicationJobs,
	monthlySchedule,
	type JobDefinition,
	type JobRegistry
} from '../../scheduler';
import {
	COMPLEX_TIME_ZONE,
	describeIssuance,
	issueInvoicesForPeriod,
	type InvoiceIssuanceSummary
} from './issuance';

/**
 * Where issuance meets the scheduler: the monthly job that calls `issueInvoicesForPeriod`.
 *
 * It sits here, next to the function that does the work, rather than in
 * `src/lib/server/scheduler/index.ts`, because decision 4 there is explicit — `applicationJobs` holds
 * the scheduler's own housekeeping and nothing else, and "every other job is registered by whoever
 * owns the work". `src/lib/server/email/jobs.ts` is the pattern this file copies, down to the
 * idempotent registration.
 *
 * Decisions settled here:
 *
 * 1. **The job's name is `issue-invoices`, and it is now permanent.** It is written to
 *    `job_runs.job_name` next to a period and is half of the lock's key, so renaming it later would
 *    make every month it has already issued look unissued and issue them all again. The name is the
 *    one `src/lib/server/scheduler/index.ts`'s own worked example predicted.
 * 2. **`monthlySchedule(COMPLEX_TIME_ZONE)`.** A month is not a month without a zone, and
 *    `src/lib/server/scheduler/registry.ts` takes it as an argument rather than hard-coding one
 *    precisely so that this ticket would pass the complex's own. The constant and the reasoning
 *    behind `Asia/Jakarta` live in `./issuance.ts`, because the zone is a property of the complex
 *    rather than of how this job happens to be wired up.
 *
 *    The schedule is what makes the job run on the first of the month: a period marker is `2026-03`,
 *    the marker changes the instant local midnight passes on the first, and the first tick after
 *    that claims it. Nothing replays a period that was never ticked during — a server switched off
 *    for all of March comes back in April and issues April — which is
 *    `src/lib/server/scheduler/registry.ts`'s settled behaviour for every schedule, not something
 *    this job chooses.
 * 3. **Registration is idempotent**, for the reason `registerEmailJobs` records: `vite dev`
 *    re-executes a changed server module against the very same `applicationJobs`, and a duplicate
 *    name is a `TypeError` that would break the dev server on an unrelated edit.
 * 4. **The summary goes to the server console by default, and a test passes its own reporter.** The
 *    same shape and the same justification as `onTickError` in `src/lib/server/scheduler/index.ts`:
 *    there is no logger in this application yet, `job_runs` has no column for a result, and a run
 *    nobody hears about is a month of Tagihan nobody can account for. `JobDefinition.run` answers
 *    `void`, so this is the only place the count of what was issued and what was skipped can be
 *    observed at runtime.
 *
 * 5. **The definition carries what `/admin/jobs` says about it** (ticket #317): its title and
 *    purpose, and the one failure it explains in a sentence, a missing Tarif. The month in that
 *    sentence is the run's own period, read by the schedule's formatter.
 *
 * Nothing here is registered by importing this module. `registerDuesJobs` is called by
 * `registerApplicationJobs` in `src/lib/server/scheduler/index.ts`, which `src/hooks.server.ts`
 * calls — see decision 4 there.
 */

/**
 * The name this job is registered, locked and shown under. An identifier, so English, and stable
 * forever — see decision 1 above.
 */
export const INVOICE_ISSUANCE_JOB_NAME = 'issue-invoices';

/**
 * `NoDuesRateError`'s `name`, as `./issuance.ts` declares it with `override readonly name`. Written
 * out rather than read off the class, whose own `name` a bundler is free to shorten;
 * `tests/unit/scheduler-backoff.test.ts` runs the real issuance job against a database with no Tarif
 * and proves the two still agree.
 */
const NO_DUES_RATE_ERROR_NAME = 'NoDuesRateError';

/** What an issuance job may have handed to it instead of the production wiring. */
export interface InvoiceIssuanceJobSettings {
	/**
	 * Where the run's summary is reported. Defaults to the server console; a test passes its own so
	 * that a run under Vitest is asserted on rather than printed.
	 */
	readonly report?: (summary: InvoiceIssuanceSummary) => void;
}

/**
 * Builds the job that issues a month's Tagihan.
 *
 * @param settings what to use instead of the production wiring. The running application passes
 *   nothing.
 */
export function invoiceIssuanceJob(settings: InvoiceIssuanceJobSettings = {}): JobDefinition {
	const report = settings.report ?? reportIssuance;

	return {
		name: INVOICE_ISSUANCE_JOB_NAME,
		schedule: monthlySchedule(COMPLEX_TIME_ZONE),
		run: async ({ db, clock, period }) => {
			report(await issueInvoicesForPeriod(db, clock, period));
		},
		display: {
			title: (locale) => m.adminJobs_job_issueInvoices_title({}, { locale }),
			purpose: (locale) => m.adminJobs_job_issueInvoices_purpose({}, { locale })
		},
		failures: [
			{
				name: NO_DUES_RATE_ERROR_NAME,
				explain: (period, locale) =>
					m.adminJobs_error_noDuesRate({ month: formatMonthLabel(period, locale) }, { locale })
			}
		]
	};
}

/**
 * Puts the issuance job in a registry, once: doing it twice is a no-op by decision 3 above. Called
 * by `registerApplicationJobs` in `src/lib/server/scheduler/index.ts`, never on import.
 *
 * @param registry defaults to `applicationJobs`, which is the registry `/admin/jobs` lists and the
 *   periodic trigger ticks.
 */
export function registerDuesJobs(registry: JobRegistry = applicationJobs): void {
	if (registry.get(INVOICE_ISSUANCE_JOB_NAME)) {
		return;
	}
	registry.register(invoiceIssuanceJob());
}

/**
 * Where a run's summary goes by default. The console the server already writes its scheduler errors
 * to is the honest place for it until this application has a logger — see decision 4 above.
 */
function reportIssuance(summary: InvoiceIssuanceSummary): void {
	console.info(describeIssuance(summary));
}
