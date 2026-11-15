import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { JOB_RUN_STATUS, type JobRunStatus } from '#lib/server/db/schema/scheduler.ts';
import {
	productionDependencies,
	readText,
	requireUser,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	applicationJobs,
	JOB_OUTCOME,
	knownFailureOf,
	listJobsWithLastRun,
	triggerJob,
	type JobDefinition,
	type JobOutcome,
	type JobSummary
} from '#lib/server/scheduler/index.ts';
import { formatDateTime, type InterfaceLocale } from '#lib/time.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the scheduled jobs: what is registered, what each one is for, what
 * happened to it last time, and a button that runs one now.
 *
 * It follows the shape `src/lib/server/route-action.ts` settled (#318). Nobody who is not signed in
 * reaches the service layer: `requireUser` runs before anything is called, because there would be
 * no caller to name. A `PermissionDeniedError` becomes `error(403, …)` here rather than in the
 * service, which is the route's job; anything else a run of the scheduler throws is rethrown.
 *
 * **Pressing the button takes the same lock a scheduled run takes.** A job that has already run for
 * the period it is in now answers `skipped`, and this page says so instead of running it a second
 * time; see decision 2 in `src/lib/server/scheduler/index.ts`. It does not wait out the backoff a
 * tick keeps after a failure (ticket #218). Only a request this screen could not have produced, a
 * blank or unregistered job name, is a rejected form, `fail(400, …)`; a job that ran and threw is
 * an outcome to report, not a rejected submission.
 *
 * **Every string is made here, in the active language, and `+page.svelte` only renders it**, the
 * way the Beranda's `src/routes/(app)/+page.server.ts` does. Since ticket #218 that covers the job's
 * human name and purpose, periods and instants read in WIB instead of raw markers and ISO stamps,
 * and a missing Tarif explained as a sentence built from the run's own period.
 *
 * **Since ticket #317 every one of those facts comes from the job's definition**, which
 * `listJobsWithLastRun` hands back beside the last run: the title and purpose from
 * `JobDefinition.display`, a period from its schedule's `formatPeriod`, and a failure's sentence
 * from the failure kinds the definition declares, found by `knownFailureOf`. This file no longer
 * keeps words by job name, reads a period marker's shape, or matches an error's name.
 */

/** The 403 for anyone who is not a superuser. The screen has no 404 of its own. */
const PAGE = { forbidden: m.adminJobs_forbidden } satisfies PageMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db, clock } = productionDependencies();
	try {
		const jobs = await listJobsWithLastRun({
			db,
			clock,
			registry: applicationJobs,
			actorId: user.id
		});
		const locale = getLocale();
		return { jobs: jobs.map((job) => jobView(job, locale)) };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	trigger: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const jobName = readText(form, 'jobName');
		if (jobName === '') {
			return fail(400, { message: m.adminJobs_invalidRequest() });
		}

		// A job that ran and threw is an outcome `triggerJob` returns, never a rejected form, so this
		// `catch` only ever throws: the 403, or the error itself.
		const { db, clock } = productionDependencies();
		let outcome: JobOutcome | undefined;
		try {
			outcome = await triggerJob({
				db,
				clock,
				registry: applicationJobs,
				actorId: user.id,
				jobName
			});
		} catch (caught) {
			throwRouteError(caught, PAGE);
		}

		// `triggerJob` answers only for a registered name, so the definition is there whenever an
		// outcome is; reading it back is how the outcome's words come from the job itself.
		const job = outcome && applicationJobs.get(outcome.jobName);
		if (!outcome || !job) {
			return fail(400, { message: m.adminJobs_unknownJob({ name: jobName }) });
		}
		return { message: describeOutcome(job, outcome, getLocale()) };
	}
};

/** One job as `+page.svelte` renders it: every string already in the active language. */
interface JobView {
	/** The registered name, shown small under the human one: it is what the logs call the job. */
	readonly name: string;
	readonly title: string;
	/** One sentence on what the job does, or `undefined` for a job this screen has no words for. */
	readonly purpose: string | undefined;
	readonly currentPeriod: string;
	readonly lastRun: LastRunView | undefined;
	/**
	 * How often the current period has failed and when a tick tries it again, present only when the
	 * latest run is a failure of the current period.
	 */
	readonly failure: FailureView | undefined;
}

/** The latest run of one job, formatted. */
interface LastRunView {
	readonly period: string;
	readonly status: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly error: string | undefined;
}

/** The two sentences about a period that keeps failing. */
interface FailureView {
	readonly count: string;
	readonly nextAttempt: string;
}

/** How a run's status reads. The value in code stays English. */
const STATUS_WORDS: Readonly<Record<JobRunStatus, (locale: InterfaceLocale) => string>> = {
	[JOB_RUN_STATUS.running]: (locale) => m.adminJobs_status_running({}, { locale }),
	[JOB_RUN_STATUS.succeeded]: (locale) => m.adminJobs_status_succeeded({}, { locale }),
	[JOB_RUN_STATUS.failed]: (locale) => m.adminJobs_status_failed({}, { locale })
};

/** The locale a count is grouped in: `2.635` in Indonesian, `2,635` in English. */
const NUMBER_FORMAT: Readonly<Record<InterfaceLocale, Intl.NumberFormat>> = {
	id: new Intl.NumberFormat('id-ID'),
	en: new Intl.NumberFormat('en-US')
};

/** One job, ready to render. */
function jobView(job: JobSummary, locale: InterfaceLocale): JobView {
	const { definition } = job;
	return {
		name: job.name,
		title: titleOf(definition, locale),
		purpose: definition.display?.purpose(locale),
		currentPeriod: _formatPeriod(definition, job.currentPeriod, locale),
		lastRun: job.lastRun && {
			period: _formatPeriod(definition, job.lastRun.period, locale),
			status: STATUS_WORDS[job.lastRun.status](locale),
			startedAt: formatDateTime(job.lastRun.startedAt),
			finishedAt: job.lastRun.finishedAt
				? formatDateTime(job.lastRun.finishedAt)
				: m.adminJobs_notFinished({}, { locale }),
			error: _describeRunError(definition, job.lastRun.error, job.lastRun.period, locale)
		},
		failure: failureView(job, locale)
	};
}

/** The count and the next attempt, when the latest run is a failure of the current period. */
function failureView(job: JobSummary, locale: InterfaceLocale): FailureView | undefined {
	const { lastRun } = job;
	if (lastRun?.status !== JOB_RUN_STATUS.failed || lastRun.period !== job.currentPeriod) {
		return undefined;
	}
	return {
		count: m.adminJobs_failureCount(
			{ count: NUMBER_FORMAT[locale].format(job.failuresInCurrentPeriod) },
			{ locale }
		),
		nextAttempt: job.nextAttemptAt
			? m.adminJobs_nextAttemptAt({ time: formatDateTime(job.nextAttemptAt) }, { locale })
			: m.adminJobs_nextAttemptSoon({}, { locale })
	};
}

/** A job's human name, or its registered name when its definition has no words for it. */
function titleOf(job: JobDefinition, locale: InterfaceLocale): string {
	return job.display?.title(locale) ?? job.name;
}

/**
 * One of `job`'s period markers as a person reads it, by the formatter of the schedule that chose
 * the marker: in WIB, a month as `September 2026`, a day as a date, a window of minutes as the date
 * and time it starts. A schedule without a formatter has its marker shown as it is.
 *
 * Exported, with the underscore SvelteKit asks of any extra export from a route file, for
 * `tests/unit/scheduler-backoff.test.ts`.
 */
export function _formatPeriod(job: JobDefinition, period: string, locale: InterfaceLocale): string {
	return job.schedule.formatPeriod?.(period, locale) ?? period;
}

/**
 * What the screen says about a run's `error`: a failure `job` declares (a missing Tarif, for the
 * issuance job) as that failure's sentence in `locale`, built from the run's own period, and
 * anything else as the text that was recorded. A run recorded before ticket #218 has no error name
 * on it, so no declared failure matches it and it shows its text.
 *
 * Exported, with the underscore SvelteKit asks of any extra export from a route file, for
 * `tests/unit/scheduler-backoff.test.ts`.
 */
export function _describeRunError(
	job: JobDefinition,
	error: string | null | undefined,
	period: string,
	locale: InterfaceLocale
): string | undefined {
	if (!error) {
		return undefined;
	}
	return knownFailureOf(job, error)?.explain(period, locale) ?? error;
}

/** What the screen says about one attempt, in the language the superuser reads it in. */
function describeOutcome(job: JobDefinition, outcome: JobOutcome, locale: InterfaceLocale): string {
	const subject = {
		job: titleOf(job, locale),
		period: _formatPeriod(job, outcome.period, locale)
	};
	if (outcome.outcome === JOB_OUTCOME.succeeded) {
		return m.adminJobs_outcome_succeeded(subject, { locale });
	}
	if (outcome.outcome === JOB_OUTCOME.skipped) {
		return m.adminJobs_outcome_skipped(subject, { locale });
	}
	const reason = _describeRunError(job, outcome.error, outcome.period, locale) ?? '';
	return m.adminJobs_outcome_failed({ ...subject, error: reason }, { locale }).trim();
}
