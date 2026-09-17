import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { EmailPayload } from '$lib/server/ports/email';

/**
 * The email queue: every email the application means to send, and what has happened to it.
 *
 * Nothing sends an email from inside a request. A service enqueues a row in the same transaction
 * as the change that caused it, and a worker sends it afterwards — see `../../email/queue.ts` for
 * why that ordering is the point of the table existing at all.
 *
 * Decisions settled here:
 *
 * - **`kind` and `payload`, not a rendered subject and body.** The text is produced when the email
 *   leaves, from a template chosen by `kind` and the values in `payload`. A row therefore stays
 *   small, readable and language-neutral, and a wording fix reaches the emails that are still
 *   waiting. See `$lib/server/ports/email`.
 * - **`kind` is free text with no constraint.** Every later spec adds kinds of its own, and a
 *   PostgreSQL enum would make each of them ship an `alter type` migration to add one word. The
 *   set of kinds that really exist is the template registry the worker is given; a row naming a
 *   kind that is not in it fails, loudly, as that one row.
 * - **`status` is text with a check constraint, not a PostgreSQL enum.** These three values are a
 *   closed set — waiting, gone, given up — but a check constraint is altered by one statement in a
 *   plain migration, while an enum value can never be removed and, until recently, could not even
 *   be added inside a transaction. The constraint buys the same protection at a lower price.
 * - **No column has a database default for its time.** `created_at` could have had `now()`, and
 *   deliberately does not: the whole point of the `Clock` port is that a test can decide what time
 *   it is, and a column filled by the database is a column a fake clock cannot reach. Every
 *   instant in this table is written by code that was handed a clock.
 * - **`attempts` counts attempts started, not attempts finished.** The worker increments it while
 *   claiming the row, before it tries to send. A process killed mid-send therefore costs one
 *   attempt and the row is picked up again later, which is the right trade: an email sent twice is
 *   an annoyance, an email lost because nothing recorded that it was ever in flight is not.
 * - **No channel column.** The spec asks a future notification table to carry one so that adding
 *   WhatsApp needs no migration. This table is not that table: it is the email queue, named after
 *   the one transport it serves, and a column that can only ever hold `'email'` here would be an
 *   invitation to build the notification concept in the wrong place.
 */

/**
 * What can be true of a queued email.
 *
 * - `pending`: waiting to be sent, or waiting out the delay after a failed attempt.
 * - `sent`: a mail server accepted it. It is kept as a record, not deleted.
 * - `failed`: given up on, either because the last attempt was used or because the failure was one
 *   that retrying cannot fix. `lastError` says which.
 */
export const EMAIL_STATUS = {
	pending: 'pending',
	sent: 'sent',
	failed: 'failed'
} as const;

/** The status of one queued email. */
export type EmailStatus = (typeof EMAIL_STATUS)[keyof typeof EMAIL_STATUS];

/** Every status there is, for a test that wants to walk them. */
export const EMAIL_STATUSES: readonly EmailStatus[] = Object.values(EMAIL_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = EMAIL_STATUSES.map((status) => `'${status}'`).join(', ');

export const emailQueue = pgTable(
	'email_queue',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The recipient's address. One row is one email to one address. */
		recipient: text().notNull(),
		/** Which template renders this email. */
		kind: text().notNull(),
		/** The values that template renders from. */
		payload: jsonb().$type<EmailPayload>().notNull(),
		status: text().$type<EmailStatus>().notNull(),
		/** How many attempts have been started, including the one in flight. */
		attempts: integer().notNull(),
		/** The earliest instant a worker may try this row again. */
		nextAttemptAt: timestamp({ withTimezone: true }).notNull(),
		/** Why the last attempt failed, kept so that a `failed` row can be explained. */
		lastError: text(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		/** When a mail server accepted it. Null until then. */
		sentAt: timestamp({ withTimezone: true })
	},
	(table) => [
		// The worker's only query: the pending rows that are due, oldest deadline first.
		index('email_queue_due_idx').on(table.status, table.nextAttemptAt),
		check('email_queue_status_check', sql.raw(`status in (${STATUS_LIST})`))
	]
);

/** One row of the email queue. */
export type QueuedEmail = typeof emailQueue.$inferSelect;

/** A row on its way into the email queue. */
export type NewQueuedEmail = typeof emailQueue.$inferInsert;
