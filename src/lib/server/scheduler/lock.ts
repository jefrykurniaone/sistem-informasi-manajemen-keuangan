import { and, count, desc, eq, gte, inArray, lt, lte, ne, notInArray } from 'drizzle-orm';
import type { Database } from '../db';
import { jobRuns, JOB_RUN_STATUS, type JobRun, type JobRunStatus } from '../db/schema/scheduler';
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
 *   pass that could be forgotten and no second write that could be skipped. *When* a tick makes
 *   that next attempt is not the lock's business: since ticket #218 the tick in `./index.ts` waits
 *   out a backoff read from the failed rows first, and the lock itself is unchanged by it.
 * - **A job that succeeds does not release it, ever.** A `succeeded` row keeps its slot in the
 *   index for good, and that is precisely what "never twice for the same period" means.
 * - **A process that dies mid-run**, writing neither outcome, leaves a `running` row holding the
 *   slot. `leaseExpiresAt` bounds that: once it has passed, the next claim marks the abandoned run
 *   `failed` and retries its insert. Two claimers racing that takeover are serialised by the row
 *   lock the `update` takes — under READ COMMITTED the loser waits, then re-evaluates its `where`
 *   against the *updated* row, finds `status = 'failed'`, and matches nothing. Exactly one takeover
 *   happens, and which of them then gets the new run is decided by the unique index again.
 * - **A claim that committed but whose answer never arrived**, because the connection failed after
 *   the server had committed the insert. The claimer was never told it holds the row, so the row is
 *   in the position of the process that died mid-run above: it holds the slot until its lease has
 *   passed, and is then taken over. `writeJobRun` in `./index.ts` retries a claim after exactly this
 *   kind of failure; the retry meets this row in the index and skips. The worst case is a period run
 *   late, never a period run twice. Added by ticket #215.
 * - **Nothing holds a database transaction open for the length of a job.** The claim commits by
 *   itself, the job runs outside any transaction, and its outcome is a second short statement. The
 *   opposite arrangement — running the work inside a transaction that holds a `select … for update`
 *   — would release the lock on a crash for free, and was rejected for the reason the email queue
 *   gives in `src/lib/server/email/queue.ts`: it puts work of unbounded length inside a database
 *   transaction, which is how a connection pool runs out on the day that work gets slow.
 *
 * ## Why deleting history is a lock decision, not a housekeeping one
 *
 * Because the row *is* the lock, `pruneJobRuns` at the bottom of this file is not free to delete
 * whatever it likes: removing a `succeeded` row hands its `(job_name, period)` pair back, and the
 * job runs for that period again. That is why the pruning policy lives here, next to the index it
 * has to respect, rather than in whatever job happens to call it — and why its retention window is
 * derived from the longest period a schedule can produce rather than chosen for how much disk it
 * saves.
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
 *
 * It is also how long a period waits when its claim committed but the connection failed before the
 * answer arrived, and how long a run whose outcome could not be written stays `running`. See
 * `writeJobRun` in `./index.ts`.
 */
export const DEFAULT_LEASE_MILLISECONDS = 15 * 60 * 1000;

/** What `error` says on a run that was taken over because its lease had passed. */
export const ABANDONED_RUN_ERROR =
	'The process running this job stopped without recording an outcome, and its lease expired.';

/** How many days of finished history are kept. See `JOB_RUN_RETENTION_MILLISECONDS`. */
export const JOB_RUN_RETENTION_DAYS = 90;

/**
 * How long a finished run is kept before `pruneJobRuns` may remove it: ninety days.
 *
 * The number is derived, not chosen for taste. **Deleting a `succeeded` row releases the lock on
 * its period**, so the window has to comfortably outlast the longest period any schedule in
 * `../scheduler/registry.ts` can produce. That is a calendar month — at most thirty-one days — so a
 * window shorter than that would free a period that is still the current one and let its job run a
 * second time, which is the single thing this whole module exists to prevent. Ninety days is
 * nearly three times the longest period, which leaves the margin an operator needs to change a
 * schedule without having to think about this constant at all.
 *
 * What it costs is bounded, which is the point of having a policy: one row per job per window means
 * a job running every minute writes 1,440 rows a day and about half a million a year. Ninety days
 * of that is roughly 130,000 rows, and it stops growing there instead of accumulating for the life
 * of the installation.
 */
export const JOB_RUN_RETENTION_MILLISECONDS = JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * How many rows one prune removes at most.
 *
 * A prune is itself a scheduled job, and a job whose one statement deletes an unbounded number of
 * rows is a job that takes a long write lock the first time it meets a table nobody has pruned yet.
 * A daily prune bounded here drains any backlog over a few days and never takes long enough to
 * matter; a per-minute job only produces 1,440 rows a day, so the bound is never reached in a
 * steady state.
 */
export const MAXIMUM_PRUNED_PER_RUN = 10_000;

/**
 * The statuses a run may be pruned from. `running` is deliberately absent: such a row is a live
 * claim whose lease is what lets an abandoned run be taken over, and deleting it would hand the
 * period to a second runner while the first is still working.
 */
const PRUNABLE_STATUSES = [JOB_RUN_STATUS.succeeded, JOB_RUN_STATUS.failed];

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
 *
 * Safe to call again after a call whose answer was lost with its connection. Every statement in it
 * is decided by the unique index or by the row's own status, so repeating one that had already
 * taken effect either finds the pair held and answers `undefined`, or finds an expiry already done
 * and claims the freed pair. `writeJobRun` in `./index.ts` relies on this.
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
 *
 * That same condition makes it idempotent: once one call has taken effect the row is no longer
 * `running`, so a second call changes nothing. `writeJobRun` in `./index.ts` relies on this when it
 * repeats the call after a lost connection.
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
 * Refuses a row that is no longer `running`, for the same reason `completeJobRun` does, and is
 * idempotent for the same reason too.
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

/** One run as the backoff in `./index.ts` reads it: which period, how it ended, and when. */
export interface RecentJobRun {
	readonly period: string;
	readonly status: JobRunStatus;
	readonly startedAt: Date;
	readonly finishedAt: Date | null;
}

/**
 * The newest `limit` runs of one job, newest first, in the order `latestJobRun` uses. Added by
 * ticket #218 for the backoff in `./index.ts`, which reads how many of the newest runs are failures
 * of the current period.
 *
 * Deliberately not filtered by period. `job_runs_job_name_started_at_idx` on
 * `(job_name, started_at)` answers this with a backward scan that stops after `limit` rows. Adding
 * `period = …` would make the same scan walk every row of the job to find none when the period is
 * new, which for the email drain is some 130,000 rows on every tick. The caller stops at
 * the first row of another period instead: every job only ever runs for the period it is in now, so
 * the runs of the current period are the newest runs of that job.
 */
export async function recentJobRuns(
	db: Database,
	jobName: string,
	limit: number
): Promise<RecentJobRun[]> {
	return db
		.select({
			period: jobRuns.period,
			status: jobRuns.status,
			startedAt: jobRuns.startedAt,
			finishedAt: jobRuns.finishedAt
		})
		.from(jobRuns)
		.where(eq(jobRuns.jobName, jobName))
		.orderBy(desc(jobRuns.startedAt), desc(jobRuns.finishedAt))
		.limit(limit);
}

/**
 * How many runs of one job failed for one period. Added by ticket #218 for `/admin/jobs`.
 *
 * Two statements, both on `job_runs_job_name_started_at_idx` and neither needing another index.
 * The first finds the newest run of this job for any *other* period, walking back only over the
 * runs of this one. The second counts from that instant on, so it reads this period's runs and not
 * the job's whole history. Without that bound the count would read every row the job has, which
 * for the email drain is ninety days of one row a minute.
 */
export async function countFailedRuns(
	db: Database,
	jobName: string,
	period: string
): Promise<number> {
	const [previous] = await db
		.select({ startedAt: jobRuns.startedAt })
		.from(jobRuns)
		.where(and(eq(jobRuns.jobName, jobName), ne(jobRuns.period, period)))
		.orderBy(desc(jobRuns.startedAt))
		.limit(1);

	const conditions = [
		eq(jobRuns.jobName, jobName),
		eq(jobRuns.period, period),
		eq(jobRuns.status, JOB_RUN_STATUS.failed)
	];
	if (previous) {
		// `gte`, not `gt`: a run of this period that started at the very instant of the other one
		// (a fake clock that stood still) is still counted, and the period filter keeps the other out.
		conditions.push(gte(jobRuns.startedAt, previous.startedAt));
	}
	const [row] = await db
		.select({ failures: count() })
		.from(jobRuns)
		.where(and(...conditions));
	return row?.failures ?? 0;
}

/** What one prune is allowed to remove. */
export interface PruneJobRunsRequest {
	/** How long a finished run is kept. Defaults to `JOB_RUN_RETENTION_MILLISECONDS`. */
	readonly retentionMilliseconds?: number;
	/** How many rows to remove at most. Defaults to `MAXIMUM_PRUNED_PER_RUN`. */
	readonly limit?: number;
}

/**
 * Removes old `job_runs` rows and answers how many it removed.
 *
 * Three kinds of row are never removed, and each is a rule rather than a preference:
 *
 * 1. **A `running` row, whatever its age.** It is a live claim — see `PRUNABLE_STATUSES`.
 * 2. **A row younger than the retention window.** Deleting a `succeeded` row releases the lock on
 *    its period, so the window has to outlast the longest period a schedule produces — see
 *    `JOB_RUN_RETENTION_MILLISECONDS`, which is where the ninety days comes from.
 * 3. **The most recent run of each job name, however old.** It is exactly what `latestJobRun`
 *    answers and therefore what `/admin/jobs` shows, so pruning it would make a job that last ran a
 *    year ago read as one that has never run at all — and a screen that has lost the only evidence
 *    a job was ever wired up is worse than a screen showing an old date.
 *
 * @param clock the run's clock, so that a test decides what "ninety days ago" means without
 *   waiting for it or writing rows with a system timestamp.
 */
export async function pruneJobRuns(
	db: Database,
	clock: Clock,
	request: PruneJobRunsRequest = {}
): Promise<number> {
	const keptIds = await latestRunIdPerJobName(db);
	if (keptIds.length === 0) {
		// No job name appears in the table at all, so there is nothing to prune — and `notInArray`
		// below has no list to be given.
		return 0;
	}

	const cutoff = new Date(
		clock.now().getTime() - (request.retentionMilliseconds ?? JOB_RUN_RETENTION_MILLISECONDS)
	);
	const doomed = await db
		.select({ id: jobRuns.id })
		.from(jobRuns)
		.where(
			and(
				inArray(jobRuns.status, PRUNABLE_STATUSES),
				lt(jobRuns.startedAt, cutoff),
				notInArray(jobRuns.id, keptIds)
			)
		)
		.limit(request.limit ?? MAXIMUM_PRUNED_PER_RUN);

	if (doomed.length === 0) {
		return 0;
	}
	await db.delete(jobRuns).where(
		inArray(
			jobRuns.id,
			doomed.map((row) => row.id)
		)
	);
	return doomed.length;
}

/**
 * The id of the most recent run of every job name that appears in the table — including names no
 * job is registered under any more, because a job that was removed still has history worth one row.
 *
 * One query per name, the same shape and for the same reason as `listJobsWithLastRun` in
 * `./index.ts`: the table holds a handful of names rather than a table's worth, and going through
 * `latestJobRun` is what guarantees the row kept here is precisely the row the screen shows.
 */
async function latestRunIdPerJobName(db: Database): Promise<string[]> {
	const names = await db.selectDistinct({ jobName: jobRuns.jobName }).from(jobRuns);
	const ids: string[] = [];
	for (const { jobName } of names) {
		const latest = await latestJobRun(db, jobName);
		if (latest) {
			ids.push(latest.id);
		}
	}
	return ids;
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
