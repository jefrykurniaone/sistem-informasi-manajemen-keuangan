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
 * idempotent registration and the call at module scope.
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
 * Nothing here is registered unless something imports this module, and `src/hooks.server.ts` is the
 * one composition root that does — see the section it carries on why that file and no other.
 */

/**
 * The name this job is registered, locked and shown under. An identifier, so English, and stable
 * forever — see decision 1 above.
 */
export const INVOICE_ISSUANCE_JOB_NAME = 'issue-invoices';

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
		}
	};
}

/**
 * Puts the issuance job in a registry, once.
 *
 * Called at module scope below, so that importing this module is all a composition root has to do —
 * and called again by nothing, because doing it twice is a no-op by decision 3 above.
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

registerDuesJobs();

/**
 * Where a run's summary goes by default. The console the server already writes its scheduler errors
 * to is the honest place for it until this application has a logger — see decision 4 above.
 */
function reportIssuance(summary: InvoiceIssuanceSummary): void {
	console.info(describeIssuance(summary));
}
