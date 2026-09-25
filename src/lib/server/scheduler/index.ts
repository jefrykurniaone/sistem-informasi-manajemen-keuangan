import { clearInterval, setInterval } from 'node:timers';
import { recordAuditEntry } from '../audit';
import { ACTION, requirePermission } from '../authz';
import { failureCode, isConnectionFailure, type Database } from '../db';
import { JOB_RUN_STATUS, type JobRun } from '../db/schema/scheduler';
import type { Clock } from '../ports/clock';
import {
	claimJobRun,
	completeJobRun,
	countFailedRuns,
	failJobRun,
	latestJobRun,
	pruneJobRuns,
	recentJobRuns
} from './lock';
import { everyMinutesSchedule, JobRegistry, type JobDefinition } from './registry';

/**
 * The scheduler: what actually runs a registered job, having first taken the lock that makes sure
 * nothing else is running it for the same period. `./registry.ts` says what a job is, `./lock.ts`
 * owns the lock and the history, and this file is the only thing that puts the two together.
 *
 * Decisions settled here:
 *
 * 1. **Importing this module still starts nothing.** `runDueJobs` is one tick: it asks each
 *    registered job which period the current instant falls in and tries to claim it, and the lock
 *    makes ticking too often harmless rather than dangerous. A module that started an interval on
 *    import would run inside every `vite build`, every test file and every CLI command that happens
 *    to import it, so what ticks periodically is `startJobScheduler` — a function a composition
 *    root **calls**, handing in the database, the clock and the registry. `src/hooks.server.ts` is
 *    the one caller, and `isSchedulerProcess` below is the guard it asks first. See the section on
 *    the periodic trigger further down.
 * 2. **A manual trigger takes the same lock as a scheduled run.** "Run it now" means "try to run it
 *    for the period it is in now", so a job that has already succeeded for this period answers
 *    `skipped` and the screen says so. A trigger that bypassed the lock would be a button that
 *    issues a month's invoices twice, which is the one thing `spec-fondasi-v1.md` asks the
 *    scheduler to make impossible — and being able to press it on a fresh database is all manual
 *    testing needs. It does **not** wait out the backoff a tick keeps after a failure (ticket
 *    #218): a person pressing the button has usually just fixed the cause.
 * 3. **A job that throws never propagates out of `runJob`.** The failure is recorded on the run and
 *    reported in the returned outcome. One failing job in a tick must not stop the jobs after it,
 *    the same rule `src/lib/server/email/worker.ts` follows for one failing email. What *does*
 *    propagate out of `runJob` is a database failure while claiming the period or writing the
 *    outcome, once the single retry in `writeJobRun` has not got through either, because at that
 *    point nothing can be trusted to have been recorded at all; a manual trigger shows it as the
 *    error it is. **`runDueJobs` contains it**, since ticket #215: the failure is reported with the
 *    job's name, its period, the step and the code, that job's outcome is `interrupted`, and the
 *    next job in the tick is still tried. Before that, one lost connection ended the whole tick,
 *    and every job after the failing one in name order waited for the next tick.
 * 4. **`applicationJobs` holds the scheduler's own housekeeping and nothing else.** The one job
 *    registered here is `jobRunPruneJob`, which trims `job_runs`: that table is this module's, the
 *    rule for what may be deleted from it is a rule about the lock, and no other owner exists to
 *    put it with. Every other job is registered by whoever owns the work — the email queue drain
 *    lives in `src/lib/server/email/jobs.ts`, because registering it here would mean choosing, in
 *    this module, which templates the production worker knows and which mail server it talks to.
 *    The registry is the mechanism; a spec with a job registers its own.
 *
 * ## The periodic trigger
 *
 * `startJobScheduler` is the timer that makes a registered job run without anyone pressing
 * anything. It is a function rather than a side effect of importing this module, because the
 * composition root is the only place that knows whether this process should be ticking at all:
 *
 * - **Not while `building`.** SvelteKit evaluates `src/hooks.server.ts` during `vite build` to
 *   prerender, and a timer started there would tick against a database that is not running.
 * - **Not under Vitest.** A test file that happens to import the hooks module would otherwise get a
 *   background timer writing rows into its schema for the rest of the run. `isSchedulerProcess`
 *   below is the predicate that answers both, so that it can be asserted in a test rather than
 *   only read.
 * - **At most one per process, whatever re-evaluates the caller.** `vite dev` re-executes a server
 *   module when it or an importer changes, so a timer kept in a module-scope variable would leak
 *   one interval per edit — each of them still ticking against the database. The handle is kept on
 *   `globalThis` under a `Symbol.for` key, which is the one slot that survives a module being
 *   evaluated a second time, and starting a scheduler stops whichever one was there before.
 *
 * The interval is not the schedule. A tick asks every job which period *the current instant* falls
 * in, and a period nobody ticked during is never revisited — so the interval has to be shorter than
 * the shortest registered schedule's period, and ticking more often than that costs one refused
 * insert per job. See `DEFAULT_TICK_INTERVAL_MILLISECONDS`.
 *
 * ## When the database connection fails
 *
 * Added by ticket #215, after the Supabase pooler ended the scheduler's connections in production
 * (`57P01`, "terminating connection due to administrator command") and each time the tick stopped at
 * the claim that was on that connection. Three things now hold:
 *
 * - **An attempt's own writes to `job_runs` are retried once after a connection failure**: the
 *   claim, the completion and the failure record, and nothing else. `job.run` is never repeated
 *   within a tick. `writeJobRun` carries the argument for why the retry can never run a job twice.
 * - **One job's failure stays with that job.** `runDueJob` is the step of a tick that deals with one
 *   job for one period, and it catches whatever that job's attempt could not survive, so that the
 *   jobs after it still run. It is also the place for any later rule about one job in one tick,
 *   because it holds the job and its period.
 * - **What is logged is the job, its period, the step and a code**, never a message: see
 *   `failureCode` in `../db` for why a message is not safe to print.
 *
 * ## Backing off a period that keeps failing
 *
 * Added by ticket #218, after `issue-invoices` failed on every tick for want of a Tarif and wrote
 * 2,479 `failed` rows in under a day. A failed run releases its period (see `./lock.ts`), so without
 * this the next tick, thirty seconds later, tried again, and again, for as long as the cause stayed.
 *
 * - **After `n` recorded failures of one job for one period, a tick leaves that pair alone until
 *   the last failure's `finished_at` plus `backoffDelayMilliseconds(n)`**: 1, 5, 25, then 60
 *   minutes, and 60 from then on. The constants and why they are these numbers are below, at
 *   `BACKOFF_FIRST_DELAY_MILLISECONDS`.
 * - **It lives in `runDueJob`, not in the claim.** The pause is a rule about when a *tick* tries,
 *   and `runDueJob` is the step of a tick that holds one job and its period. The lock is untouched:
 *   a paused pair is simply not asked for, and "Jalankan sekarang" (`triggerJob`, through `runJob`)
 *   never passes through `runDueJob`, so it runs at once. Its failure is a `failed` row like any
 *   other and counts towards the next pause.
 * - **Only `failed` rows that were actually recorded count.** The single retry `writeJobRun` makes
 *   after a lost connection happens before anything is recorded, so it adds nothing here, and an
 *   attempt `interrupted` before its failure was written adds nothing either.
 * - **It applies to every job, whatever the error.** A job that fails for a reason nobody can fix
 *   in thirty seconds is the common case, not the Tarif alone, and a pause that only knew one error
 *   would miss the next one.
 * - **A new period starts clean.** Its pair has no failed rows, so the first tick in it tries at
 *   once, which is what makes a monthly job issue on the first of the month whatever happened in
 *   the month before.
 * - **The pause is advisory; the lock is not.** Two instances may both read "not paused" and both
 *   try to claim, and the unique index still lets exactly one of them run. Nothing about "exactly
 *   once" rests on the read below.
 */

/** How much of a failure's message is kept on the run. Matches the email worker's own limit. */
const MAXIMUM_ERROR_LENGTH = 500;

/** The audit log's `action` for a run a superuser asked for by hand. */
export const JOB_TRIGGER_ACTION = 'job_trigger';

/**
 * How long a tick waits after the first recorded failure of a job for one period: one minute.
 *
 * Short on purpose. The first failure is often passing (a mail server that blinked, a deploy in
 * progress), and a minute is two ticks, so a cause that has gone away costs almost nothing. It is
 * the same first delay the email queue gives a failed send (`FIRST_RETRY_DELAY_MILLISECONDS` in
 * `../email/worker.ts`), so the two retry policies in this application read the same way.
 */
export const BACKOFF_FIRST_DELAY_MILLISECONDS = 60 * 1000;

/**
 * How much longer each further failure makes the wait: five times, giving 1, 5 and 25 minutes. The
 * email queue's `RETRY_DELAY_FACTOR` again, for the same reason. A cause that outlasts three tries
 * in half an hour is one a person has to fix, such as a Tarif nobody has entered yet.
 */
export const BACKOFF_DELAY_FACTOR = 5;

/**
 * The longest a tick ever waits: sixty minutes, from the fourth failure on.
 *
 * The cap is what keeps the pause from hiding a fix. Once someone has fixed the cause (a Superuser
 * entered the Tarif, say), the job catches up within the hour even if nobody presses "Jalankan
 * sekarang", and a failing pair writes at most twenty-four rows a day instead of 2,880.
 */
export const BACKOFF_MAXIMUM_DELAY_MILLISECONDS = 60 * 60 * 1000;

/**
 * The number of failures at which the delay reaches `BACKOFF_MAXIMUM_DELAY_MILLISECONDS` (four,
 * with the numbers above), derived rather than written down so that changing one constant cannot
 * leave it wrong. It bounds how many runs `backoffEndsAt` needs to read.
 */
const FAILURES_UNTIL_MAXIMUM_DELAY = failuresUntilMaximumDelay();

/** What one attempt at running a job came to. */
export const JOB_OUTCOME = {
	/** The job's function returned. This period will not be run again. */
	succeeded: 'succeeded',
	/**
	 * The job's function threw. The failure is on the run, and the period may be attempted again:
	 * by a tick once its backoff has passed, by "Jalankan sekarang" at once.
	 */
	failed: 'failed',
	/** Something else holds the lock for this period, or already succeeded at it. Nothing ran. */
	skipped: 'skipped',
	/**
	 * The period failed recently and its backoff has not passed yet, so the tick did not try to claim
	 * it. Nothing ran and nothing was written. Only a tick answers this, never `runJob`; `retryAt`
	 * says when a tick will try again. Added by ticket #218.
	 */
	paused: 'paused',
	/**
	 * The database failed while the period was being claimed or the outcome recorded, and the one
	 * retry did not get through either. Only a tick answers this; `runJob` throws instead. `error`
	 * says which step and the code. Nothing ran when the claim failed; the job did run when recording
	 * its outcome failed, and its run then stays `running` until the lease expires.
	 */
	interrupted: 'interrupted'
} as const;

/** One of the five things an attempt can come to. */
export type JobOutcomeKind = (typeof JOB_OUTCOME)[keyof typeof JOB_OUTCOME];

/** The steps of an attempt that can go wrong without the job's own function having thrown. */
export const JOB_STEP = {
	/** Asking the job's schedule which period the current instant falls in. */
	schedule: 'schedule',
	/** Reading the period's recent failures, to decide whether it is paused. Added by ticket #218. */
	backoff: 'backoff',
	/** Claiming that period in `job_runs`. */
	claim: 'claim',
	/** Recording on the run that the job succeeded. */
	complete: 'complete',
	/** Recording on the run that the job threw. */
	fail: 'fail'
} as const;

/** One of the steps in `JOB_STEP`. */
export type JobStep = (typeof JOB_STEP)[keyof typeof JOB_STEP];

/**
 * Something that went wrong in one attempt other than the job throwing, which the run itself
 * records: a step that failed, and whether it is about to be tried again.
 */
export interface JobIncident {
	readonly jobName: string;
	/** The period of the attempt, or `undefined` when working it out is what failed. */
	readonly period: string | undefined;
	readonly step: JobStep;
	/** What went wrong, as `failureCode` in `../db` gives it: a code, never a message. */
	readonly code: string;
	/** `true` when the step is about to be tried once more, `false` when the attempt is given up. */
	readonly retrying: boolean;
}

/**
 * Where incidents go. Defaults to the server console; a test passes its own so that a deliberate
 * failure is asserted on rather than printed.
 */
export type JobIncidentReporter = (incident: JobIncident) => void;

/** What one attempt did, in enough detail for a screen to explain it. */
export interface JobOutcome {
	readonly jobName: string;
	/** The period the attempt was for. */
	readonly period: string;
	readonly outcome: JobOutcomeKind;
	/** Why it failed, when it did. */
	readonly error?: string;
	/** When a tick will try this period again, on a `paused` outcome and no other. */
	readonly retryAt?: Date;
}

/** Everything one attempt needs. */
export interface RunJobOptions {
	readonly db: Database;
	/** Decides which period the attempt is for, and stamps every instant on the run. */
	readonly clock: Clock;
	readonly job: JobDefinition;
	/** How long this run's claim is honoured. Defaults to `DEFAULT_LEASE_MILLISECONDS`. */
	readonly leaseMilliseconds?: number;
	/** Where a write that is about to be retried is reported. Defaults to the server console. */
	readonly onIncident?: JobIncidentReporter;
}

/** Everything one tick of the whole registry needs. */
export interface RunDueJobsOptions {
	readonly db: Database;
	readonly clock: Clock;
	readonly registry: JobRegistry;
	readonly leaseMilliseconds?: number;
	/** Where every incident of the tick is reported, retried or not. Defaults to the server console. */
	readonly onIncident?: JobIncidentReporter;
}

/** Who is asking to see the jobs. */
export interface ListJobsOptions {
	readonly db: Database;
	readonly clock: Clock;
	readonly registry: JobRegistry;
	/** Checked against `ACTION.manageJobs` before anything is read. */
	readonly actorId: string;
}

/** Who is asking to run which job by hand. */
export interface TriggerJobOptions extends ListJobsOptions {
	readonly jobName: string;
	readonly leaseMilliseconds?: number;
}

/** One job as the superuser screen shows it. */
export interface JobSummary {
	readonly name: string;
	/** The period this job is in right now, as its own schedule marks it. */
	readonly currentPeriod: string;
	/** Its most recent run, or `undefined` when it has never run. */
	readonly lastRun: JobRun | undefined;
	/** How many runs of this job failed for `currentPeriod`. Added by ticket #218. */
	readonly failuresInCurrentPeriod: number;
	/**
	 * The earliest instant a tick will try `currentPeriod` again, or `undefined` when the pair is not
	 * paused right now. The same reading the tick itself makes, so the screen and the tick agree.
	 * Added by ticket #218.
	 */
	readonly nextAttemptAt: Date | undefined;
}

/**
 * Runs one job for the period the clock says it is in, unless that period is already claimed.
 *
 * Never throws because the job threw: the failure is written to the run and returned. See the lock
 * module for why a claim that is refused is a `skipped` outcome rather than an error.
 *
 * @throws {Error} when claiming the period or recording its outcome failed and the one retry
 *   `writeJobRun` allows did not get through either. Its message names the job, the period, the step
 *   and the code; the database's own error is its `cause`.
 */
export async function runJob(options: RunJobOptions): Promise<JobOutcome> {
	return attemptJob(options, options.job.schedule.periodFor(options.clock.now()));
}

/**
 * One tick: every registered job, tried for the period it is in now. Safe to call as often as
 * anything likes — a job whose period has already run answers `skipped`.
 *
 * The jobs run one after another rather than all at once, so that a slow job costs time rather than
 * a connection from the pool, and so that a failure is attributable to one job. A job whose attempt
 * failed does not stop the ones after it: see `runDueJob`.
 *
 * @returns one outcome per job whose period could be worked out, in the registry's order.
 */
export async function runDueJobs(options: RunDueJobsOptions): Promise<readonly JobOutcome[]> {
	const report = options.onIncident ?? reportJobIncident;
	const outcomes: JobOutcome[] = [];
	for (const job of options.registry.list()) {
		const outcome = await runDueJob(job, options, report);
		if (outcome) {
			outcomes.push(outcome);
		}
	}
	return outcomes;
}

/**
 * Every registered job with the period it is in and the last thing that happened to it.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold a role that permits
 *   `ACTION.manageJobs`.
 */
export async function listJobsWithLastRun(
	options: ListJobsOptions
): Promise<readonly JobSummary[]> {
	await requirePermission(options.db, options.actorId, ACTION.manageJobs);

	const now = options.clock.now();
	const summaries: JobSummary[] = [];
	// One query per job. The registry holds a handful of jobs, not a table's worth, so a join
	// against a lateral "latest run per name" would be more SQL than the screen is worth.
	for (const job of options.registry.list()) {
		const currentPeriod = job.schedule.periodFor(now);
		const lastRun = await latestJobRun(options.db, job.name);
		// A job only runs for the period it is in now, so when its newest run is for another period
		// the current one has no runs at all, and there is nothing to count or to be paused by.
		const ranThisPeriod = lastRun?.period === currentPeriod;
		const retryAt = ranThisPeriod
			? await backoffEndsAt(options.db, job.name, currentPeriod)
			: undefined;
		summaries.push({
			name: job.name,
			currentPeriod,
			lastRun,
			failuresInCurrentPeriod: ranThisPeriod
				? await countFailedRuns(options.db, job.name, currentPeriod)
				: 0,
			nextAttemptAt: retryAt && now < retryAt ? retryAt : undefined
		});
	}
	return summaries;
}

/**
 * How long a tick waits after the `failures`-th recorded failure of one job for one period, before
 * it tries that period again. See `BACKOFF_FIRST_DELAY_MILLISECONDS` for the numbers.
 *
 * @param failures how many failed runs the pair has, at least one.
 */
export function backoffDelayMilliseconds(failures: number): number {
	const grown = BACKOFF_FIRST_DELAY_MILLISECONDS * BACKOFF_DELAY_FACTOR ** (failures - 1);
	return Math.min(grown, BACKOFF_MAXIMUM_DELAY_MILLISECONDS);
}

/**
 * The instant the backoff on one job's period ends, or `undefined` when the pair is not backing
 * off at all: its newest run is not a failure of this period (a new period, a run in flight, or a
 * success, which the claim then skips).
 *
 * Reads at most `FAILURES_UNTIL_MAXIMUM_DELAY` runs, because that is where the delay stops growing:
 * a pair that failed four times and one that failed four thousand times wait the same sixty
 * minutes, so counting past four would change nothing. Every run of a pair but the newest is
 * `failed` (a succeeded run holds the pair for good, and a running one is either the newest or has
 * since been failed), so the leading failures of this period in `recentJobRuns` are its failures.
 */
async function backoffEndsAt(
	db: Database,
	jobName: string,
	period: string
): Promise<Date | undefined> {
	const runs = await recentJobRuns(db, jobName, FAILURES_UNTIL_MAXIMUM_DELAY);
	let failures = 0;
	let lastFailedAt: Date | undefined;
	for (const run of runs) {
		if (run.period !== period || run.status !== JOB_RUN_STATUS.failed) {
			break;
		}
		failures += 1;
		lastFailedAt ??= run.finishedAt ?? run.startedAt;
	}
	if (lastFailedAt === undefined) {
		return undefined;
	}
	return new Date(lastFailedAt.getTime() + backoffDelayMilliseconds(failures));
}

/**
 * Runs one named job now, on a superuser's say-so, through exactly the path a scheduled run takes.
 *
 * @returns what the attempt came to, or `undefined` when no job of that name is registered — which
 *   is a request that does not match the screen it came from, not a permission problem and not a
 *   failure of the job.
 * @throws {PermissionDeniedError} when `actorId` does not hold a role that permits
 *   `ACTION.manageJobs`.
 */
export async function triggerJob(options: TriggerJobOptions): Promise<JobOutcome | undefined> {
	await requirePermission(options.db, options.actorId, ACTION.manageJobs);

	const job = options.registry.get(options.jobName);
	if (!job) {
		return undefined;
	}

	const outcome = await runJob({
		db: options.db,
		clock: options.clock,
		job,
		leaseMilliseconds: options.leaseMilliseconds
	});

	// Who asked for a run is not on the run itself, and a hand-triggered issuance of a month's
	// invoices is exactly the kind of thing the audit log exists to attribute to a person. There is
	// no surrounding transaction to share here on purpose — see the lock module on why the job runs
	// outside one — so this row is written on its own, after the outcome is known.
	await recordAuditEntry(options.db, options.clock, {
		actorId: options.actorId,
		action: JOB_TRIGGER_ACTION,
		targetId: job.name,
		after: { period: outcome.period, outcome: outcome.outcome }
	});

	return outcome;
}

/**
 * The jobs this application runs — see decision 4 above for what belongs in here and what does not.
 *
 * A spec registers its job next to the function that does the work, and the module that does so has
 * to be reached by the running server for the job to exist at all. `src/hooks.server.ts` is where
 * that happens:
 *
 * ```ts
 * applicationJobs.register({
 *   name: 'issue-invoices',
 *   schedule: monthlySchedule('Asia/Jakarta'),
 *   run: async ({ db, clock, period }) => { … }
 * });
 * ```
 */
export const applicationJobs = new JobRegistry();

/** The name `job_runs` trimming is registered and locked under. */
export const JOB_RUN_PRUNE_JOB_NAME = 'job-run-history-prune';

/**
 * How often the history is trimmed: once a day.
 *
 * Counted from the epoch rather than from midnight in some zone — `everyMinutesSchedule` takes no
 * time zone — because there is no civil date in this: trimming is housekeeping, nobody reads a
 * report of it, and a zone would be a decision about a complex that this module has no business
 * making. Daily rather than hourly because the thing being bounded is a year of growth, and once a
 * day is already twenty-four times more often than it needs to be to keep up with a per-minute job.
 */
const PRUNE_INTERVAL_MINUTES = 24 * 60;

/**
 * Trimming `job_runs`, as a registered job like any other: it takes the same lock, it is visible on
 * `/admin/jobs`, and a superuser can press it. The policy — what is kept, what is never touched and
 * why ninety days — is in `./lock.ts`, next to the index it has to respect.
 */
export const jobRunPruneJob: JobDefinition = {
	name: JOB_RUN_PRUNE_JOB_NAME,
	schedule: everyMinutesSchedule(PRUNE_INTERVAL_MINUTES),
	run: async ({ db, clock }) => {
		await pruneJobRuns(db, clock);
	}
};

applicationJobs.register(jobRunPruneJob);

/**
 * How often `startJobScheduler` ticks by default: every thirty seconds.
 *
 * It is half the shortest period any job registered in this application has — the email queue drain
 * runs in one-minute windows — and that ratio is the rule rather than the number. A tick asks each
 * job which period *now* falls in, so a window that no tick lands in is not run late, it is not run
 * at all; ticking at exactly the period length would lose a window to any drift or to one slow
 * tick. Ticking more often than necessary costs one refused insert per job per tick, which is what
 * the lock is for.
 */
export const DEFAULT_TICK_INTERVAL_MILLISECONDS = 30 * 1000;

/** Everything the periodic trigger needs. */
export interface StartJobSchedulerOptions {
	readonly db: Database;
	readonly clock: Clock;
	readonly registry: JobRegistry;
	/** Defaults to `DEFAULT_TICK_INTERVAL_MILLISECONDS`. */
	readonly intervalMilliseconds?: number;
	/**
	 * Where a tick that could not be completed at all is reported. A job that merely threw never
	 * reaches here, because `runJob` records that on the run, and since ticket #215 neither does a
	 * database failure in one job's attempt, which `runDueJob` contains and reports through
	 * `onIncident`. What is left is a defect in this module, which is worth a line in the server log.
	 * Defaults to `console.error`; a test passes its own so that a deliberate failure is not printed.
	 */
	readonly onTickError?: (error: unknown) => void;
	/** Where each tick's incidents are reported. See `RunDueJobsOptions.onIncident`. */
	readonly onIncident?: JobIncidentReporter;
}

/** A running periodic trigger. */
export interface JobSchedulerHandle {
	/** Stops the timer. Doing it twice, or after `stopJobScheduler`, does nothing further. */
	stop(): void;
}

/**
 * The slot the one running trigger is kept in.
 *
 * `globalThis` with a `Symbol.for` key rather than a module-scope variable: under `vite dev` a
 * server module is re-executed when it changes, and each fresh evaluation would otherwise get a
 * fresh `undefined` and start a second interval that nothing can reach to stop. This key is the
 * same one in every evaluation of every copy of this module.
 */
const RUNNING_SCHEDULER: unique symbol = Symbol.for('komplek.scheduler.running');

/** `globalThis`, seen as the one property this module puts on it. */
interface SchedulerHost {
	[RUNNING_SCHEDULER]?: JobSchedulerHandle;
}

/** The slot, typed. `globalThis` shares no declared property with it, hence the trip through `unknown`. */
function schedulerHost(): SchedulerHost {
	return globalThis as unknown as SchedulerHost;
}

/**
 * Whether this process is one that should be ticking.
 *
 * @param building SvelteKit's `$app/environment` flag, passed in because `$lib/server` code cannot
 *   import `$app/*` — that alias only resolves inside the SvelteKit build, and this module is also
 *   loaded by Vitest and by command-line tooling.
 * @param environment defaults to `process.env`. Vitest sets `VITEST` in every worker it runs, which
 *   is what keeps a background timer out of a test run that happens to import the hooks module.
 */
export function isSchedulerProcess(options: {
	readonly building: boolean;
	readonly environment?: NodeJS.ProcessEnv;
}): boolean {
	if (options.building) {
		return false;
	}
	return (options.environment ?? process.env).VITEST === undefined;
}

/**
 * Starts ticking `runDueJobs`, and answers a handle that stops it again.
 *
 * Stops whichever trigger was already running in this process first, so that however many times a
 * module reload calls this, exactly one timer is live. The timer is `unref`ed: it is the HTTP
 * server that decides a server process stays up, and a stray import must not be able to keep a
 * command-line process alive on its own.
 *
 * One tick runs immediately, so that an email queued just before a restart is not waiting out a
 * whole interval. Ticks never overlap: a tick that is still going when the next one is due is left
 * to finish, because the lock would make the second one skip anyway and a pile-up of them would
 * cost connections from the pool for nothing.
 */
export function startJobScheduler(options: StartJobSchedulerOptions): JobSchedulerHandle {
	stopJobScheduler();

	const report = options.onTickError ?? reportTickFailure;
	let ticking = false;
	const tick = async (): Promise<void> => {
		if (ticking) {
			return;
		}
		ticking = true;
		try {
			await runDueJobs({
				db: options.db,
				clock: options.clock,
				registry: options.registry,
				onIncident: options.onIncident
			});
		} catch (error) {
			report(error);
		} finally {
			ticking = false;
		}
	};

	const timer = setInterval(
		() => void tick(),
		options.intervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS
	);
	timer.unref();

	const handle: JobSchedulerHandle = {
		stop: () => {
			clearInterval(timer);
			if (schedulerHost()[RUNNING_SCHEDULER] === handle) {
				schedulerHost()[RUNNING_SCHEDULER] = undefined;
			}
		}
	};
	schedulerHost()[RUNNING_SCHEDULER] = handle;
	void tick();
	return handle;
}

/** Stops the periodic trigger running in this process, if there is one. */
export function stopJobScheduler(): void {
	const running = schedulerHost()[RUNNING_SCHEDULER];
	schedulerHost()[RUNNING_SCHEDULER] = undefined;
	running?.stop();
}

/**
 * Where a tick that failed outright goes by default. There is no logger in this application yet,
 * and a tick nobody hears about is a queue that quietly stops draining, so the console the server
 * already writes its errors to is the honest place for it.
 *
 * By its code alone since ticket #215: the error itself was printed before, and a Drizzle query
 * error prints the SQL text and every parameter value with it.
 */
function reportTickFailure(error: unknown): void {
	console.error(`A scheduler tick could not be completed (${failureCode(error)}).`);
}

/**
 * One job of one tick: works out its period, then attempts it, and turns whatever that attempt
 * could not survive into an incident and an `interrupted` outcome rather than letting it end the
 * tick. The jobs after this one in the registry are tried whatever happens here.
 *
 * @returns the outcome, or `undefined` when the job's schedule could not say which period it is in,
 *   in which case there was nothing to attempt and only the incident is reported.
 */
async function runDueJob(
	job: JobDefinition,
	options: RunDueJobsOptions,
	report: JobIncidentReporter
): Promise<JobOutcome | undefined> {
	const period = periodOrReport(job, options.clock, report);
	if (period === undefined) {
		return undefined;
	}

	try {
		// The backoff of ticket #218, read before the claim and never inside it: see "Backing off a
		// period that keeps failing" at the top of this file.
		const retryAt = await writeJobRun(
			{ jobName: job.name, period, step: JOB_STEP.backoff, report },
			() => backoffEndsAt(options.db, job.name, period)
		);
		if (retryAt && options.clock.now() < retryAt) {
			return { jobName: job.name, period, outcome: JOB_OUTCOME.paused, retryAt };
		}
		return await attemptJob(
			{
				db: options.db,
				clock: options.clock,
				job,
				leaseMilliseconds: options.leaseMilliseconds,
				onIncident: report
			},
			period
		);
	} catch (error) {
		// `attemptJob` catches everything the job throws and sends every write through
		// `writeJobRun`, so anything else reaching here is a defect in this module; it is left to end
		// the tick and reach `onTickError` rather than be filed under a step it did not happen in.
		if (!(error instanceof JobWriteError)) {
			throw error;
		}
		report(error.incident);
		return {
			jobName: job.name,
			period,
			outcome: JOB_OUTCOME.interrupted,
			error: describeIncident(error.incident)
		};
	}
}

/** The period `job` is in now, or `undefined` after reporting that its schedule threw. */
function periodOrReport(
	job: JobDefinition,
	clock: Clock,
	report: JobIncidentReporter
): string | undefined {
	try {
		return job.schedule.periodFor(clock.now());
	} catch (error) {
		report({
			jobName: job.name,
			period: undefined,
			step: JOB_STEP.schedule,
			code: failureCode(error),
			retrying: false
		});
		return undefined;
	}
}

/**
 * `runJob` for a period already worked out, so that `runDueJob` knows the period of an attempt that
 * fails. Every write goes through `writeJobRun`; the job's own function is called once, outside it.
 */
async function attemptJob(options: RunJobOptions, period: string): Promise<JobOutcome> {
	const { db, clock, job } = options;
	const report = options.onIncident ?? reportJobIncident;
	const writeAt = (step: JobWriteStep): JobWrite => ({ jobName: job.name, period, step, report });

	const claim = await writeJobRun(writeAt(JOB_STEP.claim), () =>
		claimJobRun(db, clock, {
			jobName: job.name,
			period,
			leaseMilliseconds: options.leaseMilliseconds
		})
	);
	if (!claim) {
		return { jobName: job.name, period, outcome: JOB_OUTCOME.skipped };
	}

	try {
		await job.run({ db, clock, period, startedAt: claim.startedAt });
	} catch (thrown) {
		const error = describeFailure(thrown);
		await writeJobRun(writeAt(JOB_STEP.fail), () => failJobRun(db, clock, claim.runId, error));
		return { jobName: job.name, period, outcome: JOB_OUTCOME.failed, error };
	}

	await writeJobRun(writeAt(JOB_STEP.complete), () => completeJobRun(db, clock, claim.runId));
	return { jobName: job.name, period, outcome: JOB_OUTCOME.succeeded };
}

/**
 * The steps that touch `job_runs`, which are the only ones `writeJobRun` runs: the three writes,
 * and since ticket #218 the one read the backoff makes before the claim.
 */
type JobWriteStep =
	typeof JOB_STEP.backoff | typeof JOB_STEP.claim | typeof JOB_STEP.complete | typeof JOB_STEP.fail;

/** Which write of which attempt `writeJobRun` is running, and where to report it. */
interface JobWrite {
	readonly jobName: string;
	readonly period: string;
	readonly step: JobWriteStep;
	readonly report: JobIncidentReporter;
}

/**
 * Runs one of an attempt's writes to `job_runs`, and runs it exactly once more when the first try
 * failed because the connection did (`isConnectionFailure` in `../db`), never for any other
 * failure. Only three writes come through here: the claim, `completeJobRun` and `failJobRun`.
 * `job.run` never does, and is never repeated within a tick.
 *
 * Since ticket #218 one read comes through here as well: the backoff's `backoffEndsAt`, which is
 * the first statement of a job's turn in a tick and so the one most likely to meet a connection the
 * server ended while it sat idle. It is a `select`, so repeating it changes nothing, and a read
 * that fails twice is an `interrupted` outcome like a claim that fails twice: nothing ran.
 *
 * ## Why the retry can never make a job run twice
 *
 * A connection failure leaves it unknown whether the statement took effect: the server may have
 * committed it and lost the connection before the answer reached this process. The retry is safe
 * for each of the three writes either way.
 *
 * - **The claim** is `claimJobRun`, whose deciding statement is an `insert … on conflict do nothing`
 *   that the partial unique index `job_runs_claim_unique` rules on (see `./lock.ts`). If the first
 *   try did not commit, the retry is an ordinary claim. If it did commit, this process holds a
 *   `running` row it was never told about: the retried insert conflicts with that very row and
 *   answers nothing, and the attempt is `skipped` without the job running. Nothing then holds that
 *   row but its lease, so once `DEFAULT_LEASE_MILLISECONDS` (fifteen minutes) has passed, a later
 *   claim takes it over as abandoned and runs the period. The worst case is a period run up to
 *   fifteen minutes late, never one run twice: the job only runs after a claim that returned a row,
 *   and the index lets one claim per period hold it at a time. The takeover inside `claimJobRun` is
 *   safe to repeat for the same reason: an expiry that committed has already moved the row out of
 *   the index, so the retry's insert simply succeeds.
 * - **`completeJobRun` and `failJobRun`** update one row by its id, and only while it is still
 *   `running`. If the first try committed, the row is no longer `running`, so the retry matches
 *   nothing and changes nothing; it cannot overwrite a later outcome, nor the takeover of a run
 *   whose lease expired.
 *
 * What the retry narrows but cannot remove: a completion that fails twice leaves the run `running`,
 * and once its lease expires its period is taken over and run a second time. That was already the
 * cost of a process dying between running a job and recording it (see `DEFAULT_LEASE_MILLISECONDS`),
 * and the jobs registered today are idempotent against it on their own: issuance skips a Unit whose
 * Tagihan for the Periode exists (`invoices_unit_id_period_unique`, through `issueInvoice` in
 * `../services/dues/invoice.ts`), the monthly report reads `email_queue` before queuing a Periode
 * for an address (`../services/report/notification.ts`), and the email drain and the history prune
 * are safe to repeat. The retry makes that case rarer; it does not create it.
 *
 * One retry, straight away, rather than a loop or a delay: `pg-pool` drops a connection whose query
 * failed, so the retry goes out on a new one, which is all it takes when one session was ended. A
 * failure that outlasts that is the next tick's to retry, thirty seconds later, rather than
 * something to hold this tick up for.
 *
 * @throws {JobWriteError} when the write failed for good, carrying the incident to report.
 */
async function writeJobRun<T>(write: JobWrite, statement: () => Promise<T>): Promise<T> {
	try {
		return await statement();
	} catch (error) {
		if (!isConnectionFailure(error)) {
			throw new JobWriteError(write, error);
		}
		write.report(incidentOf(write, error, true));
	}

	try {
		return await statement();
	} catch (error) {
		throw new JobWriteError(write, error);
	}
}

/**
 * A write to `job_runs` that failed for good. Its message is `describeIncident`'s, so it names the
 * job, the period, the step and the code and nothing else; the database's error is its `cause`.
 */
class JobWriteError extends Error {
	/** What `runDueJob` reports for it. */
	readonly incident: JobIncident;

	constructor(write: JobWrite, cause: unknown) {
		const incident = incidentOf(write, cause, false);
		super(describeIncident(incident), { cause });
		this.name = 'JobWriteError';
		this.incident = incident;
	}
}

/** The incident for one failed try of a write. */
function incidentOf(write: JobWrite, error: unknown, retrying: boolean): JobIncident {
	return {
		jobName: write.jobName,
		period: write.period,
		step: write.step,
		code: failureCode(error),
		retrying
	};
}

/** What each step was doing, and what it means for the period when it fails for good. */
const STEP_DESCRIPTIONS: Readonly<Record<JobStep, { doing: string; consequence: string }>> = {
	[JOB_STEP.schedule]: {
		doing: 'working out its period',
		consequence: 'Nothing ran, and the next tick asks again.'
	},
	[JOB_STEP.backoff]: {
		doing: 'reading its recent failures',
		consequence: 'Nothing ran, and the next tick reads them again.'
	},
	[JOB_STEP.claim]: {
		doing: 'claiming the period',
		consequence: 'Nothing ran here, and a later tick claims the period again.'
	},
	[JOB_STEP.complete]: {
		doing: 'recording that the job succeeded',
		consequence:
			'The job ran; its run stays running until the lease expires, and the period may then run again.'
	},
	[JOB_STEP.fail]: {
		doing: 'recording that the job failed',
		consequence:
			'Its run stays running until the lease expires, and the period is then tried again.'
	}
};

/** One incident as a sentence for the server log and for an `interrupted` outcome's `error`. */
function describeIncident(incident: JobIncident): string {
	const { doing, consequence } = STEP_DESCRIPTIONS[incident.step];
	const subject =
		incident.period === undefined
			? `Job "${incident.jobName}"`
			: `Job "${incident.jobName}" for period ${incident.period}`;
	const next = incident.retrying ? 'Retrying once.' : consequence;
	return `${subject}: ${doing} failed (${incident.code}). ${next}`;
}

/**
 * Where an incident goes by default: the console, for the reason `reportTickFailure` gives. A write
 * about to be retried is a warning, because it usually gets through; one given up on is an error.
 */
function reportJobIncident(incident: JobIncident): void {
	const line = `Scheduler: ${describeIncident(incident)}`;
	if (incident.retrying) {
		console.warn(line);
		return;
	}
	console.error(line);
}

/** What stands between a failure's name and its message on the run: `NoDuesRateError: No dues…`. */
const FAILURE_NAME_SEPARATOR = ': ';

/**
 * The part of a failure worth keeping on the run: its message, shortened, and since ticket #218
 * led by the error's `name` when that is anything more specific than a plain `Error`.
 *
 * The name is there so that a screen can recognise a failure without a schema change and without
 * reading the English message. `job_runs.error` is one text column and its class was lost before
 * this; the name is the one part of an error that a service sets on purpose and never rewords
 * (`NoDuesRateError` in `../services/dues/issuance.ts` declares its own). It leads the text, in
 * the shape `Error.prototype.toString` gives, so shortening the message can never cut it off. A
 * plain `Error` keeps its bare message, as every run recorded before this change does.
 */
function describeFailure(thrown: unknown): string {
	if (!(thrown instanceof Error)) {
		return String(thrown).slice(0, MAXIMUM_ERROR_LENGTH);
	}
	const named = thrown.name !== '' && thrown.name !== 'Error';
	const text = named ? `${thrown.name}${FAILURE_NAME_SEPARATOR}${thrown.message}` : thrown.message;
	return text.slice(0, MAXIMUM_ERROR_LENGTH);
}

/**
 * Whether a run's `error` was recorded for an error whose `name` is `name`: the reading side of
 * `describeFailure`, for a screen that explains one kind of failure in its own words. Added by
 * ticket #218 for `/admin/jobs`, which recognises a missing Tarif this way.
 *
 * A run recorded before ticket #218 carries no name and answers `false`, as does any failure that
 * was a plain `Error`.
 */
export function isFailureNamed(error: string | null | undefined, name: string): boolean {
	return error?.startsWith(`${name}${FAILURE_NAME_SEPARATOR}`) ?? false;
}

/** How many failures it takes for `backoffDelayMilliseconds` to reach its cap. */
function failuresUntilMaximumDelay(): number {
	let failures = 1;
	while (backoffDelayMilliseconds(failures) < BACKOFF_MAXIMUM_DELAY_MILLISECONDS) {
		failures += 1;
	}
	return failures;
}

// The front door: a spec registering a job needs `JobDefinition` and a schedule, and importing
// those from here rather than from `./registry` keeps the module's public surface in one import.
export * from './registry';
