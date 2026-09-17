import { and, asc, eq, lte } from 'drizzle-orm';
import type { Database } from '../db';
import { emailQueue, EMAIL_STATUS, type QueuedEmail } from '../db/schema/email';
import type { Clock } from '../ports/clock';
import type { EmailPayload } from '../ports/email';

/**
 * Putting an email into the queue, and taking one out of it. Everything that touches the
 * `email_queue` table is here; what should happen to a row that fails is in `./worker.ts`.
 *
 * ## Why a queue at all, and what it actually guarantees
 *
 * The requirement is that an email that cannot be sent must not fail the action that asked for
 * it: a payment is verified whether or not the mail server is answering, and a monthly report
 * goes out to two hundred residents without the one unreachable address taking the other hundred
 * and ninety-nine with it. That is achieved by *when* each half runs, not by catching errors:
 *
 * - **Enqueuing is one `insert`, and it runs inside the caller's transaction.** `enqueueEmail`
 *   takes the transaction the service is already using, so the email and the change that causes
 *   it commit together. An action that rolls back leaves no email promising something that did
 *   not happen, and an action that commits cannot lose the email it promised.
 * - **Sending runs later, in the worker, in a different call stack entirely.** There is no path
 *   from `sender.send()` back into a request, so an SMTP timeout has nothing to fail. The worst a
 *   dead mail server can do is leave rows pending.
 *
 * The one thing this does *not* survive is a caller that awaits the worker inside its own
 * request. Nothing here does that, and nothing later should: the scheduler is the only caller of
 * `processEmailQueue`.
 *
 * ## Claiming
 *
 * A worker claims rows by incrementing `attempts` and pushing `next_attempt_at` forward inside a
 * short transaction, then sends outside it. The alternative — holding a row lock for the length
 * of an SMTP conversation — puts a network call inside a database transaction, which is how a
 * connection pool runs out on the day the mail server gets slow.
 *
 * The claim selects `for update skip locked`, so two workers running at once take different rows
 * rather than the same one. That is a safety net and not the argument: the scheduler holds a lock
 * per job, and it is that lock that makes one worker the only worker.
 */

/** A transaction handle, as the callback of `Database['transaction']` receives it. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything that can write: the database itself, or a transaction on it. Every service that
 * enqueues an email should be passing its transaction.
 */
export type DatabaseWriter = Database | Transaction;

/** The email a caller wants sent. */
export interface EmailToEnqueue {
	/** The recipient's address. */
	readonly recipient: string;
	/** Which template renders it, and therefore which templates the worker must have been given. */
	readonly kind: string;
	/** The values that template renders from. Kept small: identifiers, amounts, dates. */
	readonly payload?: EmailPayload;
}

/** How a worker claims a batch. */
export interface ClaimOptions {
	readonly clock: Clock;
	/** How many rows to take at most. */
	readonly limit: number;
	/**
	 * How long to wait before the attempt after the one being claimed. The claim sets
	 * `next_attempt_at` with it, so a worker that dies mid-send leaves a row that comes back on
	 * its own rather than one that is stuck. The policy itself lives in `./worker.ts`.
	 */
	readonly retryDelayMilliseconds: (attempt: number) => number;
}

/**
 * Adds an email to the queue, due immediately.
 *
 * @param writer the caller's transaction, so that the email commits with the change that caused
 *   it. Passing the database itself is only right when there is no surrounding transaction.
 * @throws {TypeError} when the recipient or the kind is blank, which would queue an email that
 *   can never be delivered or never be rendered.
 */
export async function enqueueEmail(
	writer: DatabaseWriter,
	clock: Clock,
	email: EmailToEnqueue
): Promise<QueuedEmail> {
	const recipient = email.recipient.trim();
	const kind = email.kind.trim();
	if (recipient === '' || kind === '') {
		throw new TypeError(
			`An email needs a recipient and a kind; received recipient "${email.recipient}" and kind "${email.kind}".`
		);
	}

	const now = clock.now();
	const [row] = await writer
		.insert(emailQueue)
		.values({
			recipient,
			kind,
			payload: email.payload ?? {},
			status: EMAIL_STATUS.pending,
			attempts: 0,
			nextAttemptAt: now,
			createdAt: now
		})
		.returning();
	return row;
}

/**
 * Takes the pending emails that are due, marks them as attempted, and returns them for sending.
 *
 * The returned rows carry the values as they were just written, so a caller reasoning about
 * `attempts` is reasoning about the attempt it is making rather than the one before it.
 *
 * @throws {TypeError} when the limit is not a positive whole number.
 */
export async function claimDueEmails(
	db: Database,
	options: ClaimOptions
): Promise<readonly QueuedEmail[]> {
	if (!Number.isInteger(options.limit) || options.limit < 1) {
		throw new TypeError(`A claim takes at least one row, not ${options.limit}.`);
	}
	const now = options.clock.now();

	return db.transaction(async (transaction) => {
		const due = await transaction
			.select()
			.from(emailQueue)
			.where(and(eq(emailQueue.status, EMAIL_STATUS.pending), lte(emailQueue.nextAttemptAt, now)))
			.orderBy(asc(emailQueue.nextAttemptAt))
			.limit(options.limit)
			.for('update', { skipLocked: true });

		const claimed: QueuedEmail[] = [];
		for (const row of due) {
			const attempts = row.attempts + 1;
			const nextAttemptAt = new Date(now.getTime() + options.retryDelayMilliseconds(attempts));
			await transaction
				.update(emailQueue)
				.set({ attempts, nextAttemptAt })
				.where(eq(emailQueue.id, row.id));
			claimed.push({ ...row, attempts, nextAttemptAt });
		}
		return claimed;
	});
}

/** Records that a mail server accepted the email. */
export async function markEmailSent(db: Database, clock: Clock, id: string): Promise<void> {
	await db
		.update(emailQueue)
		.set({ status: EMAIL_STATUS.sent, sentAt: clock.now(), lastError: null })
		.where(eq(emailQueue.id, id));
}

/**
 * Records that an attempt failed and that there will be another one. The row stays `pending`, and
 * `next_attempt_at` is left as the claim set it.
 */
export async function recordEmailRetry(db: Database, id: string, reason: string): Promise<void> {
	await db.update(emailQueue).set({ lastError: reason }).where(eq(emailQueue.id, id));
}

/** Records that this email will not be sent, and why. */
export async function markEmailFailed(db: Database, id: string, reason: string): Promise<void> {
	await db
		.update(emailQueue)
		.set({ status: EMAIL_STATUS.failed, lastError: reason })
		.where(eq(emailQueue.id, id));
}
