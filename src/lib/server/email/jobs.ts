import {
	smtpEmailSenderFromEnvironment,
	type EmailSender,
	type EmailTemplates
} from '../ports/email';
import {
	applicationJobs,
	everyMinutesSchedule,
	type JobDefinition,
	type JobRegistry
} from '../scheduler';
import { invitationTemplates } from './templates/invitation';
import { invoiceIssuedTemplates } from './templates/invoice-issued';
import { newPostTemplates } from './templates/new-post';
import { passwordResetTemplates } from './templates/password-reset';
import { paymentRejectedTemplates } from './templates/payment-rejected';
import { paymentVerifiedTemplates } from './templates/payment-verified';
import { registrationApprovedTemplates } from './templates/registration-approved';
import { verifyEmailTemplates } from './templates/verify-email';
import { processEmailQueue } from './worker';

/**
 * Where outgoing email is wired together: which templates this application can render, which mail
 * server it hands finished messages to, and the scheduled job that empties the queue.
 *
 * Until this module existed the queue had no drainer in practice. `../../auth.ts` wrote verification
 * and password-reset rows, `./worker.ts` knew how to send a batch, and the scheduler knew how to run
 * a job exactly once per period — but nothing put the three together, so a queued email sat in the
 * table until a person pressed a button.
 *
 * Decisions settled here:
 *
 * 1. **This is the one place that knows both halves.** The scheduler must not choose which templates
 *    the production worker has or which SMTP host it reaches — that is a statement about outgoing
 *    email, not about locking — and the worker must not choose how often it runs. This module is
 *    small precisely because it is only the seam between them.
 * 2. **The production sender is built on the first run, never at import.**
 *    `smtpEmailSenderFromEnvironment` reads `SMTP_HOST`, `SMTP_PORT` and `EMAIL_FROM` and throws
 *    when one is missing. Building it at module scope would make importing this file — which
 *    `src/hooks.server.ts` does, and which therefore happens during `vite build` — fail on a machine
 *    that has no mail settings, for a job that was never going to run at build time. It is built
 *    once and kept, because a `nodemailer` transport pools its connections.
 * 3. **Registration is idempotent.** `JobRegistry.register` refuses a duplicate name on purpose, and
 *    it is right to: two jobs under one name would share a lock. But `vite dev` re-executes a
 *    changed server module while leaving its unchanged dependencies alone, so this module can be
 *    evaluated a second time against the very same `applicationJobs` — and a registration that
 *    threw there would break the dev server on an unrelated edit. Asking the registry first is the
 *    honest way to say "this name, once", and it does not weaken the duplicate check for anybody
 *    else.
 * 4. **Nothing here awaits the queue inside a request.** `processEmailQueue` is called by the job's
 *    `run` and by nothing else, which is the rule `./queue.ts` has held since the queue was written.
 */

/** The name this job is registered, locked and shown under. An identifier, so English. */
export const EMAIL_QUEUE_DRAIN_JOB_NAME = 'email-queue-drain';

/**
 * How long a drain window is: one minute.
 *
 * It is the shortest schedule in the application, so it is also what sets the scheduler's tick
 * interval — see `DEFAULT_TICK_INTERVAL_MILLISECONDS` in `../scheduler/index.ts`. A minute is the
 * longest a resident should wait for a verification email that was queued the moment they
 * registered, and short enough that a mail server coming back up is noticed quickly.
 */
export const EMAIL_QUEUE_DRAIN_MINUTES = 1;

/**
 * Every email kind this application can render, which is exactly the set the production worker is
 * given. A queue row naming a kind that is not in here fails permanently and says so — see
 * `renderQueuedEmail` in `./worker.ts` — which is why a later spec adding a kind adds it to this
 * one object rather than to a worker call site.
 */
export const applicationEmailTemplates: EmailTemplates = {
	...verifyEmailTemplates,
	...passwordResetTemplates,
	...invitationTemplates,
	...registrationApprovedTemplates,
	...invoiceIssuedTemplates,
	...paymentVerifiedTemplates,
	...paymentRejectedTemplates,
	...newPostTemplates
};

/** What a drain job may have handed to it instead of the production wiring. */
export interface EmailQueueDrainSettings {
	/** Defaults to the SMTP sender built from the environment on the first run. */
	readonly sender?: EmailSender;
	/** Defaults to `applicationEmailTemplates`. */
	readonly templates?: EmailTemplates;
	/** How many emails one run takes. Defaults to the worker's own batch size. */
	readonly batchSize?: number;
}

/**
 * Builds the job that empties the email queue.
 *
 * @param settings what to use instead of the production wiring. A test passes a `FakeEmailSender`;
 *   the running application passes nothing.
 */
export function emailQueueDrainJob(settings: EmailQueueDrainSettings = {}): JobDefinition {
	const templates = settings.templates ?? applicationEmailTemplates;
	let sender = settings.sender;

	return {
		name: EMAIL_QUEUE_DRAIN_JOB_NAME,
		schedule: everyMinutesSchedule(EMAIL_QUEUE_DRAIN_MINUTES),
		run: async ({ db, clock }) => {
			sender ??= smtpEmailSenderFromEnvironment();
			await processEmailQueue({ db, clock, sender, templates, batchSize: settings.batchSize });
		}
	};
}

/**
 * Puts the drain job in a registry, once.
 *
 * Called at module scope below, so that importing this module is all a composition root has to do —
 * and called again by nothing, because doing it twice is a no-op by decision 3 above.
 *
 * @param registry defaults to `applicationJobs`, which is the registry `/admin/jobs` lists and the
 *   periodic trigger ticks.
 */
export function registerEmailJobs(registry: JobRegistry = applicationJobs): void {
	if (registry.get(EMAIL_QUEUE_DRAIN_JOB_NAME)) {
		return;
	}
	registry.register(emailQueueDrainJob());
}

registerEmailJobs();
