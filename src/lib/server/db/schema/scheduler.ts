import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * `job_runs`: one row per attempt to run a scheduled job for one period, and — in the same row —
 * the lock that keeps a second attempt at the same period from running. The mechanism that makes
 * "exactly one execution" true is `job_runs_claim_unique` below; the argument for why it is true
 * is in `src/lib/server/scheduler/lock.ts`, next to the statements that rely on it.
 *
 * Decisions settled here:
 *
 * - **The lock is a row in the history table, not a table of its own.** A separate `job_locks`
 *   table would hold the same pair of values as the run it belongs to, and would then have to be
 *   kept in step with it: two writes to go wrong instead of one, and a lock whose held/released
 *   state could disagree with the outcome of the run that took it. One row carries both — taking
 *   the lock *is* inserting the history row, and finishing the run *is* the update that decides
 *   whether the lock stays held.
 * - **The unique index is partial: it covers `running` and `succeeded`, not `failed`.** That one
 *   choice is what makes the two rules the spec asks for hold at the same time. A `succeeded` row
 *   keeps the slot forever, so a job never runs twice for a period it has already completed. A
 *   `failed` row is outside the index, so the statement that records a failure is also the
 *   statement that releases the lock — no cleanup pass, no second write that could be skipped, and
 *   no period left permanently unrunnable because one attempt threw. The failed attempt stays as
 *   history, which is why this is a partial index rather than a delete.
 * - **`period` is text, and its shape is the schedule's business.** A monthly job's marker is
 *   `2026-03`, a daily job's is `2026-03-15`, a frequent job's is an instant. The lock only ever
 *   compares markers for equality, so it does not need to parse them, and a column typed as a date
 *   or a month would force every schedule into one granularity. See `Schedule` in
 *   `src/lib/server/scheduler/registry.ts`.
 * - **`status` is text with a check constraint, not a PostgreSQL enum** — the same reasoning as
 *   `email_queue.status` in `./email.ts`.
 * - **`leaseExpiresAt` is on the row, not derived.** A process that dies between claiming and
 *   finishing writes neither outcome, and its `running` row would hold the slot for that period
 *   for good. The lease bounds that: after it passes, the next claim may take the abandoned run
 *   over. It is a bound on *abandonment*, never a deadline for the work — nothing interrupts a
 *   running job when its lease expires.
 * - **No column has a database default for its time**, the same rule `./email.ts` and `./audit.ts`
 *   follow: every instant here is written by code that was handed a `Clock`, so a test decides
 *   what time it is — including whether a lease has expired — without waiting for it.
 */

/**
 * What can be true of one run.
 *
 * - `running`: claimed, and not yet known to have finished. Holds the lock.
 * - `succeeded`: the job's function returned. Holds the lock forever, which is what stops the same
 *   period from being run a second time.
 * - `failed`: the job's function threw, or the run was abandoned and its lease ran out. `error`
 *   says which. Does not hold the lock, so this period can be attempted again.
 */
export const JOB_RUN_STATUS = {
	running: 'running',
	succeeded: 'succeeded',
	failed: 'failed'
} as const;

/** The status of one run. */
export type JobRunStatus = (typeof JOB_RUN_STATUS)[keyof typeof JOB_RUN_STATUS];

/** Every status there is, for a test — or a screen — that wants to walk them. */
export const JOB_RUN_STATUSES: readonly JobRunStatus[] = Object.values(JOB_RUN_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = JOB_RUN_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The statuses that hold the lock on their `(job_name, period)` pair. Everything else — which is
 * `failed` alone — leaves the pair free for another attempt.
 */
export const CLAIM_HOLDING_STATUSES: readonly JobRunStatus[] = [
	JOB_RUN_STATUS.running,
	JOB_RUN_STATUS.succeeded
];

/** The SQL list of lock-holding statuses, built from the one array above. */
const CLAIM_HOLDING_LIST = CLAIM_HOLDING_STATUSES.map((status) => `'${status}'`).join(', ');

export const jobRuns = pgTable(
	'job_runs',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Which registered job this run belongs to, as `JobDefinition.name` spells it. */
		jobName: text().notNull(),
		/** Which period of that job's schedule this run covers. */
		period: text().notNull(),
		status: text().$type<JobRunStatus>().notNull(),
		/** When the run was claimed. */
		startedAt: timestamp({ withTimezone: true }).notNull(),
		/** When it stopped, either way. Null while it is still `running`. */
		finishedAt: timestamp({ withTimezone: true }),
		/** After this instant, a claim may take an abandoned `running` row over. */
		leaseExpiresAt: timestamp({ withTimezone: true }).notNull(),
		/** Why the run failed, kept so that a `failed` row can be explained. Null otherwise. */
		error: text()
	},
	(table) => [
		// The lock. One row per (job_name, period) among the statuses that hold it, enforced by the
		// index rather than by anything this application reads first — see
		// `src/lib/server/scheduler/lock.ts` for why that distinction is the whole correctness
		// argument.
		uniqueIndex('job_runs_claim_unique')
			.on(table.jobName, table.period)
			.where(sql.raw(`status in (${CLAIM_HOLDING_LIST})`)),
		// The admin screen's only read: the most recent run of one job.
		index('job_runs_job_name_started_at_idx').on(table.jobName, table.startedAt),
		check('job_runs_status_check', sql.raw(`status in (${STATUS_LIST})`))
	]
);

/** One row of `job_runs`: one attempt at one job for one period. */
export type JobRun = typeof jobRuns.$inferSelect;

/** A row on its way into `job_runs`. */
export type NewJobRun = typeof jobRuns.$inferInsert;
