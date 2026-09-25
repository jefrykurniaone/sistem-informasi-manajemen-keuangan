import { error, fail, redirect } from '@sveltejs/kit';
import { PermissionDeniedError } from '$lib/errors';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime.js';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { JOB_RUN_STATUS, type JobRunStatus } from '$lib/server/db/schema/scheduler';
import { EMAIL_QUEUE_DRAIN_JOB_NAME } from '$lib/server/email/jobs';
import { systemClock } from '$lib/server/ports/clock';
import {
	applicationJobs,
	isFailureNamed,
	JOB_OUTCOME,
	JOB_RUN_PRUNE_JOB_NAME,
	listJobsWithLastRun,
	triggerJob,
	type JobOutcome,
	type JobSummary
} from '$lib/server/scheduler';
import { JOB_RUN_RETENTION_DAYS } from '$lib/server/scheduler/lock';
import { INVOICE_ISSUANCE_JOB_NAME } from '$lib/server/services/dues/jobs';
import { MONTHLY_REPORT_JOB_NAME } from '$lib/server/services/report/jobs';
import { formatDateTime, formatDay, formatMonthLabel, type InterfaceLocale } from '$lib/time';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the scheduled jobs: what is registered, what each one is for, what
 * happened to it last time, and a button that runs one now.
 *
 * It follows the shape `src/routes/(app)/admin/roles/+page.server.ts` settled. Nobody who is not
 * signed in reaches the service layer: `locals.user` is checked before anything is called, because
 * there would be no caller to name. A `PermissionDeniedError` becomes `error(403, …)` here rather
 * than in the service, which is the route's job.
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
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const jobs = await listJobsWithLastRun({
			db: database(),
			clock: systemClock,
			registry: applicationJobs,
			actorId: locals.user.id
		});
		const locale = getLocale();
		return { jobs: jobs.map((job) => jobView(job, locale)) };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	trigger: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const jobName = String(form.get('jobName') ?? '').trim();
		if (jobName === '') {
			return fail(400, { message: m.adminJobs_invalidRequest() });
		}

		let outcome: JobOutcome | undefined;
		try {
			outcome = await triggerJob({
				db: database(),
				clock: systemClock,
				registry: applicationJobs,
				actorId: locals.user.id,
				jobName
			});
		} catch (caught) {
			throwAsRouteError(caught);
		}

		if (!outcome) {
			return fail(400, { message: m.adminJobs_unknownJob({ name: jobName }) });
		}
		return { message: describeOutcome(outcome, getLocale()) };
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

/** The human name and purpose of each job this application registers, by its registered name. */
const JOB_WORDS: Readonly<
	Partial<Record<string, (locale: InterfaceLocale) => { title: string; purpose: string }>>
> = {
	[EMAIL_QUEUE_DRAIN_JOB_NAME]: (locale) => ({
		title: m.adminJobs_job_emailQueueDrain_title({}, { locale }),
		purpose: m.adminJobs_job_emailQueueDrain_purpose({}, { locale })
	}),
	[INVOICE_ISSUANCE_JOB_NAME]: (locale) => ({
		title: m.adminJobs_job_issueInvoices_title({}, { locale }),
		purpose: m.adminJobs_job_issueInvoices_purpose({}, { locale })
	}),
	[JOB_RUN_PRUNE_JOB_NAME]: (locale) => ({
		title: m.adminJobs_job_jobRunHistoryPrune_title({}, { locale }),
		purpose: m.adminJobs_job_jobRunHistoryPrune_purpose(
			{ days: JOB_RUN_RETENTION_DAYS },
			{ locale }
		)
	}),
	[MONTHLY_REPORT_JOB_NAME]: (locale) => ({
		title: m.adminJobs_job_sendMonthlyReport_title({}, { locale }),
		purpose: m.adminJobs_job_sendMonthlyReport_purpose({}, { locale })
	})
};

/** How a run's status reads. The value in code stays English. */
const STATUS_WORDS: Readonly<Record<JobRunStatus, (locale: InterfaceLocale) => string>> = {
	[JOB_RUN_STATUS.running]: (locale) => m.adminJobs_status_running({}, { locale }),
	[JOB_RUN_STATUS.succeeded]: (locale) => m.adminJobs_status_succeeded({}, { locale }),
	[JOB_RUN_STATUS.failed]: (locale) => m.adminJobs_status_failed({}, { locale })
};

/**
 * `NoDuesRateError`'s `name`, as `src/lib/server/services/dues/issuance.ts` declares it with
 * `override readonly name`. Written out rather than read off the class, whose own `name` a bundler
 * is free to shorten; `tests/unit/scheduler-backoff.test.ts` runs the real issuance job against a
 * database with no Tarif and proves the two still agree.
 */
const NO_DUES_RATE_ERROR_NAME = 'NoDuesRateError';

/** A monthly period marker, `2026-09`. Fixed length, anchored: nothing to backtrack over. */
const MONTH_PERIOD = /^\d{4}-\d{2}$/;

/** A daily period marker, `2026-09-24`. */
const DAY_PERIOD = /^\d{4}-\d{2}-\d{2}$/;

/** Noon in WIB as a UTC hour: a civil date read at noon never slips to the day before or after. */
const NOON_WIB_AS_UTC_HOUR = 5;

/** The locale a count is grouped in: `2.635` in Indonesian, `2,635` in English. */
const NUMBER_FORMAT: Readonly<Record<InterfaceLocale, Intl.NumberFormat>> = {
	id: new Intl.NumberFormat('id-ID'),
	en: new Intl.NumberFormat('en-US')
};

/** One job, ready to render. */
function jobView(job: JobSummary, locale: InterfaceLocale): JobView {
	const words = JOB_WORDS[job.name]?.(locale);
	return {
		name: job.name,
		title: words?.title ?? job.name,
		purpose: words?.purpose,
		currentPeriod: _formatPeriod(job.currentPeriod, locale),
		lastRun: job.lastRun && {
			period: _formatPeriod(job.lastRun.period, locale),
			status: STATUS_WORDS[job.lastRun.status](locale),
			startedAt: formatDateTime(job.lastRun.startedAt),
			finishedAt: job.lastRun.finishedAt
				? formatDateTime(job.lastRun.finishedAt)
				: m.adminJobs_notFinished({}, { locale }),
			error: _describeRunError(job.lastRun.error, job.lastRun.period, locale)
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

/**
 * A period marker as a person reads it, in WIB: a monthly one as `September 2026`, a daily one as
 * a date, and a window of minutes (the email drain's minute, the prune's day counted from the
 * epoch) as the date and time it starts. A marker of any other shape is shown as it is.
 *
 * The date and time use `$lib/time`'s formatters, whose locale is `id-ID` whatever the interface
 * language (decision 2 there: it is what prints `WIB`); only the month name follows the language.
 *
 * Exported, with the underscore SvelteKit asks of any extra export from a route file, for
 * `tests/unit/scheduler-backoff.test.ts`.
 */
export function _formatPeriod(period: string, locale: InterfaceLocale): string {
	if (MONTH_PERIOD.test(period)) {
		return formatMonthLabel(period, locale);
	}
	if (DAY_PERIOD.test(period)) {
		const [year, month, day] = period.split('-').map(Number);
		return formatDay(new Date(Date.UTC(year, month - 1, day, NOON_WIB_AS_UTC_HOUR)));
	}
	const instant = new Date(period);
	return Number.isNaN(instant.getTime()) ? period : formatDateTime(instant);
}

/**
 * What the screen says about a run's `error`: a missing Tarif as a sentence in `locale`, built
 * from the run's own period, and anything else as the text that was recorded.
 *
 * A missing Tarif is recognised by the name `describeFailure` in `src/lib/server/scheduler` puts in
 * front of the message (`isFailureNamed`), never by the English wording, which is the issuance
 * service's to change. A run recorded before ticket #218 has no name on it and shows its text.
 *
 * Exported, with the underscore SvelteKit asks of any extra export from a route file, for
 * `tests/unit/scheduler-backoff.test.ts`.
 */
export function _describeRunError(
	error: string | null | undefined,
	period: string,
	locale: InterfaceLocale
): string | undefined {
	if (!error) {
		return undefined;
	}
	if (isFailureNamed(error, NO_DUES_RATE_ERROR_NAME) && MONTH_PERIOD.test(period)) {
		return m.adminJobs_error_noDuesRate({ month: formatMonthLabel(period, locale) }, { locale });
	}
	return error;
}

/** What the screen says about one attempt, in the language the superuser reads it in. */
function describeOutcome(outcome: JobOutcome, locale: InterfaceLocale): string {
	const subject = {
		job: JOB_WORDS[outcome.jobName]?.(locale).title ?? outcome.jobName,
		period: _formatPeriod(outcome.period, locale)
	};
	if (outcome.outcome === JOB_OUTCOME.succeeded) {
		return m.adminJobs_outcome_succeeded(subject, { locale });
	}
	if (outcome.outcome === JOB_OUTCOME.skipped) {
		return m.adminJobs_outcome_skipped(subject, { locale });
	}
	const reason = _describeRunError(outcome.error, outcome.period, locale) ?? '';
	return m.adminJobs_outcome_failed({ ...subject, error: reason }, { locale }).trim();
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws. The return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what an action or a load function returns, exactly as the
 * roles screen's copy of this helper explains.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminJobs_forbidden());
	}
	throw caught;
}
