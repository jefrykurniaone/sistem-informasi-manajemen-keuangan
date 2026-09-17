import { error, fail, redirect } from '@sveltejs/kit';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	applicationJobs,
	JOB_OUTCOME,
	listJobsWithLastRun,
	triggerJob,
	type JobOutcome
} from '$lib/server/scheduler';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the scheduled jobs: what is registered, what happened to each one last
 * time, and a button that runs one now.
 *
 * It follows the shape `src/routes/(app)/admin/roles/+page.server.ts` settled. Nobody who is not
 * signed in reaches the service layer — `locals.user` is checked before anything is called, because
 * there would be no caller to name. A `PermissionDeniedError` becomes `error(403, …)` here rather
 * than in the service, which is the route's job.
 *
 * **Pressing the button takes the same lock a scheduled run takes.** A job that has already run for
 * the period it is in now answers `skipped`, and this page says so instead of running it a second
 * time — see decision 2 in `src/lib/server/scheduler/index.ts`. Only a request this screen could
 * not have produced — a blank or unregistered job name — is a rejected form, `fail(400, …)`; a job
 * that ran and threw is an outcome to report, not a rejected submission.
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
		return { jobs };
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
			return fail(400, { message: 'Permintaan tidak valid: pekerjaan tidak disebutkan.' });
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
			return fail(400, { message: `Pekerjaan "${jobName}" tidak dikenali.` });
		}
		return { message: describeOutcome(outcome) };
	}
};

/** What the screen says about one attempt, in the language the superuser reads it in. */
function describeOutcome(outcome: JobOutcome): string {
	const subject = `Pekerjaan "${outcome.jobName}" periode ${outcome.period}`;
	if (outcome.outcome === JOB_OUTCOME.succeeded) {
		return `${subject} selesai dijalankan.`;
	}
	if (outcome.outcome === JOB_OUTCOME.skipped) {
		return `${subject} dilewati: periode itu sudah pernah dijalankan atau sedang berjalan.`;
	}
	return `${subject} gagal: ${outcome.error ?? ''}`.trim();
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what an action or a load function returns, exactly as the
 * roles screen's copy of this helper explains.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, 'Anda tidak berhak mengelola pekerjaan terjadwal.');
	}
	throw caught;
}
