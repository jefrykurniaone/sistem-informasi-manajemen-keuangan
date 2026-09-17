import { and, desc, eq, lte } from 'drizzle-orm';
import type { Database } from '../db';
import { jobRuns, JOB_RUN_STATUS, type JobRun } from '../db/schema/scheduler';
import type { Clock } from '../ports/clock';

/**
 * The lock: everything that reads or writes `job_runs`. `./index.ts` is the only caller, and it
 * uses nothing else to decide whether a job may run.
 *
 * ## Why exactly one execution happens, and which interleaving that excludes
 *
 * Claiming a run is one statement — `insert … on conflict do nothing returning *` — and the thing
 * that decides the race is the partial unique index `job_runs_claim_unique` on
 * `(job_name, period)`, not anything this code reads beforehand.
 *
 * That distinction is the entire argument. A `select` that finds no run followed by an `insert` is
 * **not** a lock here: `db.transaction` runs at PostgreSQL's default READ COMMITTED, where a
 * reader never blocks on another transaction's uncommitted row — it reads the latest *committed*
 * state. Two schedulers starting at the same moment would both read "nothing has run for 2026-03",
 * both insert, and the month's invoices would be issued twice. Wrapping that pair of statements in
 * a transaction changes nothing, because neither of them ever waits for the other. That is the
 * interleaving the unique index excludes, and it excludes it without this code having to order any
 * locks: two concurrent inserts of the same `(job_name, period)` cannot both succeed at any
 * isolation level. The second one blocks *inside the index* until the first transaction ends, and
 * then either sees the committed row and does nothing — returning no row, so its caller skips — or,
 * if the first rolled back, inserts its own. There is no window between the check and the write,
 * because there is no check.
 *
 * A held lock therefore makes the second caller **skip**, never fail: `claimJobRun` returns
 * `undefined` rather than throwing, and a unique-violation error never surfaces, because
 * `on conflict do nothing` turns the conflict into an empty result.
 *
 * ## What releases the lock
 *
 * - **A job that throws.** `failJobRun` sets the row to `failed`, which takes it out of the partial
 *   index — the same statement that records the failure releases the lock, so the next attempt at
 *   that period claims it cleanly, and the failed attempt stays as history. There is no cleanup
 *   pass that could be forgotten and no second write that could be skipped.
 * - **A job that succeeds does not release it, ever.** A `succeeded` row keeps its slot in the
 *   index for good, and that is precisely what "never twice for the same period" means.
 * - **A process that dies mid-run**, writing neither outcome, leaves a `running` row holding the
 *   slot. `leaseExpiresAt` bounds that: once it has passed, the next claim marks the abandoned run
 *   `failed` and retries its insert. Two claimers racing that takeover are serialised by the row
 *   lock the `update` takes — under READ COMMITTED the loser waits, then re-evaluates its `where`
 *   against the *updated* row, finds `status = 'failed'`, and matches nothing. Exactly one takeover
 *   happens, and which of them then gets the new run is decided by the unique index again.
 * - **Nothing holds a database transaction open for the length of a job.** The claim commits by
 *   itself, the job runs outside any transaction, and its outcome is a second short statement. The
 *   opposite arrangement — running the work inside a transaction that holds a `select … for update`
 *   — would release the lock on a crash for free, and was rejected for the reason the email queue
 *   gives in `src/lib/server/email/queue.ts`: it puts work of unbounded length inside a database
 *   transaction, which is how a connection pool runs out on the day that work gets slow.
 */

/**
 * How long a claim is honoured before another claimer may take it over. Fifteen minutes is longer
 * than any job this application has, and short enough that a crash at 01:00 does not block the
 * period until someone notices.
 *
 * It bounds *abandonment*, not the work: nothing interrupts a job whose lease has passed. What the
 * lease costs in the worst case is one repeated execution — a job that is still running when its
 * lease expires can have its period claimed by a second one — which is why it is generously long
 * and why `completeJobRun` refuses to write an outcome onto a run that was taken over.
 */
export const DEFAULT_LEASE_MILLISECONDS = 15 * 60 * 1000;

/** What `error` says on a run that was taken over because its lease had passed. */
export const ABANDONED_RUN_ERROR =
	'The process running this job stopped without recording an outcome, and its lease expired.';

/** A claim that was granted: the run row this caller now owns. */
export interface JobClaim {
	/** The `job_runs` row this run owns, to be passed back to `completeJobRun` or `failJobRun`. */
	readonly runId: string;
	readonly jobName: string;
	readonly period: string;
	readonly startedAt: Date;
	readonly leaseExpiresAt: Date;
}

/** Which run is being claimed, and for how long. */
export interface JobClaimRequest {
	readonly jobName: string;
	readonly period: string;
	/** Defaults to `DEFAULT_LEASE_MILLISECONDS`. */
	readonly leaseMilliseconds?: number;
}

/**
 * Takes the lock on one `(job name, period)` pair and opens its history row.
 *
 * @param db the database itself, deliberately not a transaction: the claim has to commit on its
 *   own for a second process to be able to see it, and a caller that could pass its own open
 *   transaction would be holding the lock for as long as that transaction lives.
 * @returns the claim, or `undefined` when the pair is already held — by a run still going, or by
 *   one that has already succeeded. A held lock is a reason to skip, never an error.
 */
export async function claimJobRun(
	db: Database,
	clock: Clock,
	request: JobClaimRequest
): Promise<JobClaim | undefined> {
	const claimed = await insertClaim(db, clock, request);
	if (claimed) {
		return claimed;
	}

	// The pair is held. It is only worth a second attempt if what holds it is a run that was
	// abandoned: `expireAbandonedRun` says whether this caller is the one that ended it.
	const takenOver = await expireAbandonedRun(db, clock, request);
	if (!takenOver) {
		return undefined;
	}
	// One retry, never a loop: if another claimer inserted first in the moment between the takeover
	// and this insert, that claimer is running the job, and skipping is the right answer.
	return await insertClaim(db, clock, request);
}

/**
 * Records that a run finished its work.
 *
 * Refuses to touch a row that is no longer `running` — a run whose lease expired and was taken over
 * is already `failed`, and letting a late finisher write `succeeded` over that would claim a lock
 * that a second run is holding.
 */
export async function completeJobRun(db: Database, clock: Clock, runId: string): Promise<void> {
	await db
		.update(jobRuns)
		.set({ status: JOB_RUN_STATUS.succeeded, finishedAt: clock.now(), error: null })
		.where(and(eq(jobRuns.id, runId), eq(jobRuns.status, JOB_RUN_STATUS.running)));
}

/**
 * Records that a run failed, and releases its lock in the same statement — `failed` is outside the
 * partial unique index, so writing it frees the pair for another attempt.
 *
 * Refuses a row that is no longer `running`, for the same reason `completeJobRun` does.
 */
export async function failJobRun(
	db: Database,
	clock: Clock,
	runId: string,
	reason: string
): Promise<void> {
	await db
		.update(jobRuns)
		.set({ status: JOB_RUN_STATUS.failed, finishedAt: clock.now(), error: reason })
		.where(and(eq(jobRuns.id, runId), eq(jobRuns.status, JOB_RUN_STATUS.running)));
}

/**
 * The most recent run of one job, or `undefined` when it has never run.
 *
 * Ordered by `startedAt`, with a still-running row winning a tie: two runs claimed at the same
 * instant can only happen for two different periods, and the one that has not finished is the one
 * a screen means by "the last run".
 */
export async function latestJobRun(db: Database, jobName: string): Promise<JobRun | undefined> {
	const [row] = await db
		.select()
		.from(jobRuns)
		.where(eq(jobRuns.jobName, jobName))
		.orderBy(desc(jobRuns.startedAt), desc(jobRuns.finishedAt))
		.limit(1);
	return row;
}

/** The one statement the whole guarantee rests on. Returns nothing when the pair is already held. */
async function insertClaim(
	db: Database,
	clock: Clock,
	request: JobClaimRequest
): Promise<JobClaim | undefined> {
	const startedAt = clock.now();
	const leaseExpiresAt = new Date(
		startedAt.getTime() + (request.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS)
	);

	const [row] = await db
		.insert(jobRuns)
		.values({
			jobName: request.jobName,
			period: request.period,
			status: JOB_RUN_STATUS.running,
			startedAt,
			leaseExpiresAt,
			finishedAt: null,
			error: null
		})
		.onConflictDoNothing()
		.returning();

	if (!row) {
		return undefined;
	}
	return {
		runId: row.id,
		jobName: row.jobName,
		period: row.period,
		startedAt: row.startedAt,
		leaseExpiresAt: row.leaseExpiresAt
	};
}

/**
 * Ends a `running` row whose lease has passed, so that its pair can be claimed again.
 *
 * @returns whether this caller is the one that ended it. Exactly one of several concurrent callers
 *   can be: the `update` takes a row lock, and a caller that waits on it re-evaluates its `where`
 *   against the row the winner wrote, where `status` is no longer `running`.
 */
async function expireAbandonedRun(
	db: Database,
	clock: Clock,
	request: JobClaimRequest
): Promise<boolean> {
	const now = clock.now();
	const expired = await db
		.update(jobRuns)
		.set({ status: JOB_RUN_STATUS.failed, finishedAt: now, error: ABANDONED_RUN_ERROR })
		.where(
			and(
				eq(jobRuns.jobName, request.jobName),
				eq(jobRuns.period, request.period),
				eq(jobRuns.status, JOB_RUN_STATUS.running),
				lte(jobRuns.leaseExpiresAt, now)
			)
		)
		.returning({ id: jobRuns.id });
	return expired.length > 0;
}
