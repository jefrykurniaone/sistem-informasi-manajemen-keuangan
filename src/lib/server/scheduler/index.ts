import { recordAuditEntry } from '../audit';
import { ACTION, requirePermission } from '../authz';
import type { Database } from '../db';
import type { JobRun } from '../db/schema/scheduler';
import type { Clock } from '../ports/clock';
import { claimJobRun, completeJobRun, failJobRun, latestJobRun } from './lock';
import { JobRegistry, type JobDefinition } from './registry';

/**
 * The scheduler: what actually runs a registered job, having first taken the lock that makes sure
 * nothing else is running it for the same period. `./registry.ts` says what a job is, `./lock.ts`
 * owns the lock and the history, and this file is the only thing that puts the two together.
 *
 * Decisions settled here:
 *
 * 1. **There is no timer, and no process is started by importing this module.** `runDueJobs` is one
 *    tick: it asks each registered job which period the current instant falls in and tries to claim
 *    it. Whoever owns a loop — a later ticket's worker process, a cron entry, or a superuser
 *    pressing a button — decides how often that happens, and the lock makes ticking too often
 *    harmless rather than dangerous. A module that started an interval on import would run inside
 *    every `vite build`, every test file and every CLI command that happens to import it.
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
 * 4. **`applicationJobs` starts empty, and the email queue drain is deliberately not in it.**
 *    `processEmailQueue` in `src/lib/server/email/worker.ts` is the queue's drainer and the
 *    scheduler is its only intended caller, but registering it here would mean choosing, in this
 *    module, which templates the production worker knows and which mail server it talks to — the
 *    wiring belongs to whoever owns the outgoing-email composition, not to the scheduler. It would
 *    also be the first job frequent enough to make the history worth pruning: one `job_runs` row
 *    per window is right for a monthly job and is half a million rows a year for a minutely one.
 *    The registry is the mechanism; a spec with a job registers it.
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
 * The jobs this application runs. Empty until a spec registers one — see decision 4 above.
 *
 * A later spec registers its job at module scope, next to the function that does the work:
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

/** The part of a failure worth keeping on the run: its message, shortened. */
function describeFailure(thrown: unknown): string {
	const message = thrown instanceof Error ? thrown.message : String(thrown);
	return message.slice(0, MAXIMUM_ERROR_LENGTH);
}

// The front door: a spec registering a job needs `JobDefinition` and a schedule, and importing
// those from here rather than from `./registry` keeps the module's public surface in one import.
export * from './registry';
