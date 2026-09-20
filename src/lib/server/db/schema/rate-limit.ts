import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `rate_limit_buckets`: one row per (action, subject) pair that has been seen inside its current
 * window, holding how many times. The limiter in `src/lib/server/rate-limit.ts` is the only reader
 * and the only writer; that module's header explains why the count lives in PostgreSQL rather than
 * in process memory.
 *
 * This table has no domain meaning — no resident, no money, no Indonesian term — so it is not in
 * `CONTEXT.md`, the same footing as `scaffold_probe` and `job_runs`.
 *
 * Decisions settled here:
 *
 * - **The key is text, and the row is the bucket.** `key` is `<action>:<kind>:<subject>`, built by
 *   the limiter, so one primary key covers both halves of the limiter's answer (the caller's
 *   address and the email they typed) without a column per kind. It is the primary key so that
 *   `insert … on conflict (key) do update` is one atomic statement: two requests for the same
 *   bucket at the same instant serialise on the row rather than both reading the old count.
 * - **`hits` is the count of attempts in the window, refused ones included.** The limiter reads
 *   the value the upsert returns and compares it to the rule's limit; nothing here knows what the
 *   limit is, because the limit is a property of the action, not of the row.
 * - **`expires_at` is the whole of the window.** A fixed window starts on the first attempt and
 *   ends at `expires_at`; an attempt after that instant starts a new window in the same row. The
 *   column is indexed because it is also how rows leave: the limiter deletes every row whose
 *   `expires_at` has passed before it counts, so the table holds at most one row per subject seen
 *   in the last window and never grows past that.
 * - **No column has a database default for its time**, the rule `./email.ts` and `./scheduler.ts`
 *   follow: `expires_at` is written by code handed a `Clock`, so a test moves a fake clock past a
 *   window instead of sleeping through one.
 * - **The subject is stored as typed, not hashed.** A hash would hide which address or which email
 *   is being throttled from whoever is looking at the table during an incident, and the rows live
 *   for minutes. The limiter bounds the subject's length instead, so the row size is bounded
 *   without a hash.
 */

export const rateLimitBuckets = pgTable(
	'rate_limit_buckets',
	{
		/** `<action>:<kind>:<subject>`, as `src/lib/server/rate-limit.ts` builds it. */
		key: text().primaryKey(),
		/** Attempts counted in the current window, including the ones that were refused. */
		hits: integer().notNull(),
		/** When the current window ends. The row is dead after this instant and is swept. */
		expiresAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// The sweep's only query: every row whose window has ended.
		index('rate_limit_buckets_expires_at_idx').on(table.expiresAt),
		// A bucket exists because something hit it; a row with zero hits would be a row the upsert
		// could never have written.
		check('rate_limit_buckets_hits_check', sql`hits > 0`)
	]
);

/** One row of `rate_limit_buckets`: one subject's count inside its current window. */
export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
