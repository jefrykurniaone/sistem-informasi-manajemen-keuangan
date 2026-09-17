import { clearInterval, setInterval } from 'node:timers';
import { recordAuditEntry } from '../audit';
import { ACTION, requirePermission } from '../authz';
import type { Database } from '../db';
import type { JobRun } from '../db/schema/scheduler';
import type { Clock } from '../ports/clock';
import { claimJobRun, completeJobRun, failJobRun, latestJobRun, pruneJobRuns } from './lock';
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
 *    testing needs.
 * 3. **A job that throws never propagates out of `runJob`.** The failure is recorded on the run and
 *    reported in the returned outcome. One failing job in a tick must not stop the jobs after it,
 *    the same rule `src/lib/server/email/worker.ts` follows for one failing email. What *does*
 *    propagate is a database failure while writing the outcome, because at that point nothing can
 *    be trusted to have been recorded at all.
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
 */

/** How much of a failure's message is kept on the run. Matches the email worker's own limit. */
const MAXIMUM_ERROR_LENGTH = 500;

/** The audit log's `action` for a run a superuser asked for by hand. */
export const JOB_TRIGGER_ACTION = 'job_trigger';

/** What one attempt at running a job came to. */
export const JOB_OUTCOME = {
	/** The job's function returned. This period will not be run again. */
	succeeded: 'succeeded',
	/** The job's function threw. The failure is on the run, and the period may be attempted again. */
	failed: 'failed',
	/** Something else holds the lock for this period, or already succeeded at it. Nothing ran. */
	skipped: 'skipped'
} as const;

/** One of the three things an attempt can come to. */
export type JobOutcomeKind = (typeof JOB_OUTCOME)[keyof typeof JOB_OUTCOME];

/** What one attempt did, in enough detail for a screen to explain it. */
export interface JobOutcome {
	readonly jobName: string;
	/** The period the attempt was for. */
	readonly period: string;
	readonly outcome: JobOutcomeKind;
	/** Why it failed, when it did. */
	readonly error?: string;
}

/** Everything one attempt needs. */
export interface RunJobOptions {
	readonly db: Database;
	/** Decides which period the attempt is for, and stamps every instant on the run. */
	readonly clock: Clock;
	readonly job: JobDefinition;
	/** How long this run's claim is honoured. Defaults to `DEFAULT_LEASE_MILLISECONDS`. */
	readonly leaseMilliseconds?: number;
}

/** Everything one tick of the whole registry needs. */
export interface RunDueJobsOptions {
	readonly db: Database;
	readonly clock: Clock;
	readonly registry: JobRegistry;
	readonly leaseMilliseconds?: number;
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
}

/**
 * Runs one job for the period the clock says it is in, unless that period is already claimed.
 *
 * Never throws because the job threw: the failure is written to the run and returned. See the lock
 * module for why a claim that is refused is a `skipped` outcome rather than an error.
 */
export async function runJob(options: RunJobOptions): Promise<JobOutcome> {
	const { db, clock, job } = options;
	const period = job.schedule.periodFor(clock.now());

	const claim = await claimJobRun(db, clock, {
		jobName: job.name,
		period,
		leaseMilliseconds: options.leaseMilliseconds
	});
	if (!claim) {
		return { jobName: job.name, period, outcome: JOB_OUTCOME.skipped };
	}

	try {
		await job.run({ db, clock, period, startedAt: claim.startedAt });
	} catch (thrown) {
		const error = describeFailure(thrown);
		await failJobRun(db, clock, claim.runId, error);
		return { jobName: job.name, period, outcome: JOB_OUTCOME.failed, error };
	}

	await completeJobRun(db, clock, claim.runId);
	return { jobName: job.name, period, outcome: JOB_OUTCOME.succeeded };
}

/**
 * One tick: every registered job, tried for the period it is in now. Safe to call as often as
 * anything likes — a job whose period has already run answers `skipped`.
 *
 * The jobs run one after another rather than all at once, so that a slow job costs time rather than
 * a connection from the pool, and so that a failure is attributable to one job.
 */
export async function runDueJobs(options: RunDueJobsOptions): Promise<readonly JobOutcome[]> {
	const outcomes: JobOutcome[] = [];
	for (const job of options.registry.list()) {
		outcomes.push(
			await runJob({
				db: options.db,
				clock: options.clock,
				job,
				leaseMilliseconds: options.leaseMilliseconds
			})
		);
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
		summaries.push({
			name: job.name,
			currentPeriod: job.schedule.periodFor(now),
			lastRun: await latestJobRun(options.db, job.name)
		});
	}
	return summaries;
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
	 * reaches here — `runJob` records that on the run — so anything arriving is a database failure
	 * while writing an outcome, which is worth a line in the server log. Defaults to
	 * `console.error`; a test passes its own so that a deliberate failure is not printed.
	 */
	readonly onTickError?: (error: unknown) => void;
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
			await runDueJobs({ db: options.db, clock: options.clock, registry: options.registry });
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
 */
function reportTickFailure(error: unknown): void {
	console.error('A scheduler tick could not be completed.', error);
}

/** The part of a failure worth keeping on the run: its message, shortened. */
function describeFailure(thrown: unknown): string {
	const message = thrown instanceof Error ? thrown.message : String(thrown);
	return message.slice(0, MAXIMUM_ERROR_LENGTH);
}

// The front door: a spec registering a job needs `JobDefinition` and a schedule, and importing
// those from here rather than from `./registry` keeps the module's public surface in one import.
export * from './registry';
