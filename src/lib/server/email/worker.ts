import type { Database } from '../db';
import type { QueuedEmail } from '../db/schema/email';
import type { Clock } from '../ports/clock';
import {
	PermanentEmailError,
	type EmailMessage,
	type EmailSender,
	type EmailTemplates
} from '../ports/email';
import { claimDueEmails, markEmailFailed, markEmailSent, recordEmailRetry } from './queue';

/**
 * The worker that empties the email queue.
 *
 * Decisions settled here:
 *
 * 1. **It is a function the scheduler calls, not a loop that runs forever.** `processEmailQueue`
 *    takes one batch, sends it, and returns what it did. A long-running loop would need its own
 *    start-up, its own shutdown, its own way of not running twice, and its own way of being
 *    triggered by hand — all of which the scheduler already has to have for every other job. The
 *    scheduler (a later ticket) decides when this runs and holds the lock that makes one worker
 *    the only worker; it is not built here.
 * 2. **One batch, sent one at a time.** Sending in parallel would open a connection per email to
 *    a mail server that has every right to rate-limit, and would make a failure hard to attribute.
 *    The batch size bounds how long one run takes.
 * 3. **A failed row never ends the run.** Every email is delivered inside its own `try`, and the
 *    outcome is written to its own row. Two hundred monthly reports do not stop at the first bad
 *    address.
 * 4. **Retries back off, and end.** Attempt one waits a minute, and each following wait is five
 *    times the one before, so a mail server that is down for an hour is not hammered for an hour.
 *    After `MAX_EMAIL_ATTEMPTS` the row is `failed` and stays as a record of what did not get
 *    sent, rather than being deleted or retried forever.
 * 5. **A failure that cannot be fixed by waiting does not wait.** A recipient the server refuses,
 *    a kind with no template, a template that throws — each is `failed` on the spot. Retrying a
 *    verdict that will not change only delays finding out.
 */

/** How many emails one run takes at most. */
export const DEFAULT_EMAIL_BATCH_SIZE = 20;

/**
 * How many attempts an email gets before it is given up on. Five attempts with the delays below
 * spread over roughly two and a half hours, which outlasts an ordinary mail server outage without
 * leaving a resident waiting for a password reset all day.
 */
export const MAX_EMAIL_ATTEMPTS = 5;

/** How long the first retry waits. */
const FIRST_RETRY_DELAY_MILLISECONDS = 60 * 1000;

/** How much longer each retry waits than the one before it. */
const RETRY_DELAY_FACTOR = 5;

/** How much of a failure's message is kept on the row. */
const MAXIMUM_REASON_LENGTH = 500;

/** What happened to one claimed email. */
type DeliveryOutcome = 'sent' | 'retried' | 'failed';

/** Everything one run of the worker needs. */
export interface EmailWorkerOptions {
	readonly db: Database;
	readonly clock: Clock;
	readonly sender: EmailSender;
	/** Every kind this application can render. A row naming a kind that is not here fails. */
	readonly templates: EmailTemplates;
	/** How many emails to take. Defaults to `DEFAULT_EMAIL_BATCH_SIZE`. */
	readonly batchSize?: number;
}

/** What one run of the worker did. */
export interface EmailWorkerReport {
	/** How many rows were taken. Equal to the sum of the three below. */
	readonly claimed: number;
	readonly sent: number;
	/** Failed this time, and due to be tried again. */
	readonly retried: number;
	/** Given up on. */
	readonly failed: number;
}

/**
 * How long to wait before attempt number `attempt`: one minute, then five, then twenty-five, and
 * so on. The delay is applied when an attempt is claimed rather than when it fails, so a worker
 * that dies mid-send leaves a row that comes back by itself.
 *
 * @param attempt which attempt the delay is for, counting from one.
 */
export function retryDelayMilliseconds(attempt: number): number {
	const step = Math.max(1, Math.trunc(attempt));
	return FIRST_RETRY_DELAY_MILLISECONDS * RETRY_DELAY_FACTOR ** (step - 1);
}

/**
 * Sends the emails that are due. This is the entry point a scheduled job calls; it returns rather
 * than looping, and it is safe to call again immediately.
 */
export async function processEmailQueue(options: EmailWorkerOptions): Promise<EmailWorkerReport> {
	const claimed = await claimDueEmails(options.db, {
		clock: options.clock,
		limit: options.batchSize ?? DEFAULT_EMAIL_BATCH_SIZE,
		retryDelayMilliseconds
	});

	const outcomes: DeliveryOutcome[] = [];
	for (const email of claimed) {
		outcomes.push(await deliver(email, options));
	}

	return {
		claimed: claimed.length,
		sent: outcomes.filter((outcome) => outcome === 'sent').length,
		retried: outcomes.filter((outcome) => outcome === 'retried').length,
		failed: outcomes.filter((outcome) => outcome === 'failed').length
	};
}

/**
 * Renders one queued email into the message a sender takes.
 *
 * @throws {PermanentEmailError} when there is no template for the row's kind, or when the
 *   template throws. Both mean this row will never render, however many times it is tried: a
 *   missing template is a kind nobody registered, and a throwing template is a bug or a payload
 *   that does not match it.
 */
export function renderQueuedEmail(email: QueuedEmail, templates: EmailTemplates): EmailMessage {
	// `Object.hasOwn`, not `templates[kind]`: the kind is data read back from a table, and a row
	// carrying `constructor` would otherwise reach a function off `Object.prototype`.
	if (!Object.hasOwn(templates, email.kind)) {
		throw new PermanentEmailError(
			`There is no email template for the kind "${email.kind}". Either the worker was given the wrong set of templates, or nothing should have queued that kind.`
		);
	}
	const template = templates[email.kind];
	try {
		return { ...template(email.payload), to: email.recipient };
	} catch (error) {
		throw new PermanentEmailError(
			`The email template "${email.kind}" could not render the payload of this email.`,
			{ cause: error }
		);
	}
}

/** Sends one claimed email and writes down what happened to it. */
async function deliver(email: QueuedEmail, options: EmailWorkerOptions): Promise<DeliveryOutcome> {
	try {
		await options.sender.send(renderQueuedEmail(email, options.templates));
	} catch (error) {
		return await recordFailure(email, error, options);
	}
	await markEmailSent(options.db, options.clock, email.id);
	return 'sent';
}

/** Decides whether a failed email gets another attempt, and records the reason either way. */
async function recordFailure(
	email: QueuedEmail,
	error: unknown,
	options: EmailWorkerOptions
): Promise<'retried' | 'failed'> {
	const reason = describeFailure(error);
	if (error instanceof PermanentEmailError || email.attempts >= MAX_EMAIL_ATTEMPTS) {
		await markEmailFailed(options.db, email.id, reason);
		return 'failed';
	}
	await recordEmailRetry(options.db, email.id, reason);
	return 'retried';
}

/** The part of a failure worth keeping on the row: its message, shortened. */
function describeFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, MAXIMUM_REASON_LENGTH);
}
