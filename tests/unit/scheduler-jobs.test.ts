import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { emailQueue, EMAIL_STATUS } from '$lib/server/db/schema/email';
import {
	jobRuns,
	JOB_RUN_STATUS,
	type JobRun,
	type JobRunStatus
} from '$lib/server/db/schema/scheduler';
import { testDatabase } from '$lib/server/db/test-helpers';
import {
	applicationEmailTemplates,
	emailQueueDrainJob,
	EMAIL_QUEUE_DRAIN_JOB_NAME,
	EMAIL_QUEUE_DRAIN_MINUTES,
	registerEmailJobs
} from '$lib/server/email/jobs';
import { enqueueEmail } from '$lib/server/email/queue';
import { INVITATION_KIND } from '$lib/server/email/templates/invitation';
import {
	PASSWORD_RESET_KIND,
	passwordResetPayload
} from '$lib/server/email/templates/password-reset';
import { VERIFY_EMAIL_KIND, verifyEmailPayload } from '$lib/server/email/templates/verify-email';
import { FakeClock, FakeEmailSender } from '$lib/server/ports/fakes';
import {
	claimJobRun,
	completeJobRun,
	JOB_RUN_RETENTION_MILLISECONDS,
	pruneJobRuns
} from '$lib/server/scheduler/lock';
import {
	applicationJobs,
	isSchedulerProcess,
	jobRunPruneJob,
	JobRegistry,
	JOB_OUTCOME,
	JOB_RUN_PRUNE_JOB_NAME,
	listJobsWithLastRun,
	runJob,
	startJobScheduler,
	stopJobScheduler,
	type JobContext,
	type JobDefinition,
	type Schedule
} from '$lib/server/scheduler';

/**
 * The two halves ticket #67 added: the periodic trigger that makes registered jobs run without
 * anyone pressing anything, and the email queue drain that is the first job registered into
 * `applicationJobs` by an owner outside the scheduler. Plus the history pruning policy, which is
 * tested here rather than with the lock because its rules are rules about what the lock means.
 *
 * Against a real PostgreSQL, like the lock tests, and for the same reason: "two instances produce
 * one execution" is a property of a partial unique index. The test under "two instances ticking at
 * once" forces the interleaving with a second connection holding an uncommitted claim, rather than
 * firing two calls at once and hoping — the first would ordinarily commit before the second reached
 * the index, so a version with no lock at all would pass that.
 */

const testDb = testDatabase();

/** The instant most clocks in this file start at. */
const START = '2026-01-01T00:00:00.000Z';

/** A minute of its own for the drain job, so two tests never claim one period. */
const DRAIN_SENDS_AT = '2026-01-01T00:01:00.000Z';

/** Another one, for the test that reads the drain job back off the superuser screen's own call. */
const DRAIN_LISTED_AT = '2026-01-01T00:02:00.000Z';

/** How often a scheduler under test ticks. Short, because these tests wait for real ticks. */
const TICK_MILLISECONDS = 20;

/** How long a test waits for something a background timer is supposed to do. */
const WAIT_TIMEOUT_MILLISECONDS = 5000;

/** How long a test waits to be satisfied that something is *not* going to happen. */
const SETTLE_MILLISECONDS = 250;

/** A lease long enough that nothing in this file ever expires one by accident. */
const LEASE_MILLISECONDS = 60_000;

/** What a job that is made to fail throws. */
const FAILURE_MESSAGE = 'this job always throws';

/** The address every queued email in this file is addressed to. */
const RECIPIENT = 'warga@komplek.local';

afterEach(() => {
	// Every scheduler is process-wide, so a test that started one must not leave it ticking into the
	// next test's schema.
	stopJobScheduler();
});

/** A schedule that puts every instant in one period, for tests that are not about time. */
function fixedSchedule(period: string): Schedule {
	return { description: `fixed at ${period}`, periodFor: () => period };
}

/**
 * A schedule that answers a period nobody has used before, every single time it is asked.
 *
 * That makes a job run on every tick rather than once, which is what lets a test count ticks — the
 * only way to tell a timer that is still running from one that fired once and stopped.
 */
function everyTickSchedule(prefix: string): Schedule {
	let asked = 0;
	return {
		description: 'a new period every time it is asked',
		periodFor: () => {
			asked += 1;
			return `${prefix}-${asked}`;
		}
	};
}

/** A job that counts its runs and remembers what it was handed. */
function countingJob(
	name: string,
	schedule: Schedule
): { definition: JobDefinition; contexts: JobContext[] } {
	const contexts: JobContext[] = [];
	return {
		contexts,
		definition: {
			name,
			schedule,
			run: async (context) => {
				contexts.push(context);
			}
		}
	};
}

/** A job that throws every time it is run. */
function alwaysFailingJob(name: string, schedule: Schedule): JobDefinition {
	return {
		name,
		schedule,
		run: async () => {
			throw new Error(FAILURE_MESSAGE);
		}
	};
}

/** A registry holding exactly these jobs. */
function registryOf(...jobs: JobDefinition[]): JobRegistry {
	const registry = new JobRegistry();
	for (const job of jobs) {
		registry.register(job);
	}
	return registry;
}

/** Waits for `milliseconds`, for a test that has to let a timer tick. */
function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Waits until `ready()` answers true, and answers whether it ever did. */
async function waitFor(ready: () => boolean): Promise<boolean> {
	const deadline = Date.now() + WAIT_TIMEOUT_MILLISECONDS;
	while (Date.now() < deadline && !ready()) {
		await pause(TICK_MILLISECONDS);
	}
	return ready();
}

/** A superuser, for the one test that calls a service `ACTION.manageJobs` guards. */
async function insertSuperuser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	await testDb.db.insert(userRoles).values({ userId: id, role: ROLE.superuser, createdAt: now });
	return id;
}

/** Every run of one job, oldest first. */
async function runsOf(jobName: string): Promise<JobRun[]> {
	return testDb.db
		.select()
		.from(jobRuns)
		.where(eq(jobRuns.jobName, jobName))
		.orderBy(asc(jobRuns.startedAt), asc(jobRuns.id));
}

/** The periods of one job's runs, oldest first, for asserting on what survived a prune. */
async function periodsOf(jobName: string): Promise<string[]> {
	return (await runsOf(jobName)).map((row) => row.period);
}

/** Writes one finished or running row straight into the history, at an age of the test's choosing. */
async function insertRun(row: {
	jobName: string;
	period: string;
	status: JobRunStatus;
	startedAt: Date;
}): Promise<void> {
	await testDb.db.insert(jobRuns).values({
		jobName: row.jobName,
		period: row.period,
		status: row.status,
		startedAt: row.startedAt,
		leaseExpiresAt: new Date(row.startedAt.getTime() + LEASE_MILLISECONDS),
		finishedAt: row.status === JOB_RUN_STATUS.running ? null : row.startedAt,
		error: null
	});
}

/** An instant `days` days before `START`, for writing history that is old enough to be pruned. */
function daysBeforeStart(days: number): Date {
	return new Date(Date.parse(START) - days * 24 * 60 * 60 * 1000);
}

/** How many days of retention the policy keeps, as a number this file can count in. */
const RETENTION_DAYS = JOB_RUN_RETENTION_MILLISECONDS / (24 * 60 * 60 * 1000);

/**
 * A second, independent connection into this file's own schema — a stand-in for a concurrent
 * instance of the application, with its own client and its own transaction.
 */
async function connectToSchema(): Promise<{ client: PoolClient; release: () => Promise<void> }> {
	const connection = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
		options: `-c search_path=${testDb.schemaName}`
	});
	const client = await connection.pool.connect();
	return {
		client,
		release: async () => {
			client.release();
			await connection.close();
		}
	};
}

/** Claims one run through a raw connection, leaving the transaction open. */
async function claimThroughOpenTransaction(
	client: PoolClient,
	jobName: string,
	period: string
): Promise<void> {
	await client.query('BEGIN');
	await client.query(
		`insert into job_runs (job_name, period, status, started_at, lease_expires_at)
		 values ($1, $2, $3, $4, $5)`,
		[
			jobName,
			period,
			JOB_RUN_STATUS.running,
			new Date(START),
			new Date(Date.parse(START) + LEASE_MILLISECONDS)
		]
	);
}

describe('applicationEmailTemplates', () => {
	it('carries exactly the kinds this application queues, and renders each one', () => {
		expect(Object.keys(applicationEmailTemplates).sort()).toEqual(
			[VERIFY_EMAIL_KIND, PASSWORD_RESET_KIND, INVITATION_KIND].sort()
		);
		expect(
			applicationEmailTemplates[VERIFY_EMAIL_KIND](
				verifyEmailPayload({ name: 'Warga', url: 'https://komplek.local/verify?token=x' })
			).subject
		).toBe('Verifikasi alamat email Anda');
	});
});

describe('the email queue drain job', () => {
	it('sends an email that was only ever put in the queue, with nobody intervening', async () => {
		const clock = new FakeClock(DRAIN_SENDS_AT);
		const sender = new FakeEmailSender();
		const queued = await enqueueEmail(testDb.db, clock, {
			recipient: RECIPIENT,
			kind: PASSWORD_RESET_KIND,
			payload: passwordResetPayload({
				name: 'Warga Lupa Sandi',
				url: 'https://komplek.local/set-password?token=t'
			})
		});

		const outcome = await runJob({ db: testDb.db, clock, job: emailQueueDrainJob({ sender }) });

		expect(outcome).toMatchObject({
			jobName: EMAIL_QUEUE_DRAIN_JOB_NAME,
			outcome: JOB_OUTCOME.succeeded
		});
		expect(sender.messages).toHaveLength(1);
		expect(sender.lastMessage).toMatchObject({
			to: RECIPIENT,
			subject: 'Atur ulang kata sandi Anda'
		});
		const [row] = await testDb.db.select().from(emailQueue).where(eq(emailQueue.id, queued.id));
		expect(row.status).toBe(EMAIL_STATUS.sent);
	});

	it('is registered in applicationJobs, on a schedule of one minute', () => {
		const registered = applicationJobs.get(EMAIL_QUEUE_DRAIN_JOB_NAME);

		expect(registered).toBeDefined();
		expect(registered?.schedule.description).toBe(`every ${EMAIL_QUEUE_DRAIN_MINUTES} minutes`);
	});

	it('is registered once however often the module that registers it is evaluated', () => {
		// `vite dev` re-executes a changed server module against the same registry. Registering has to
		// survive that rather than throwing on the duplicate name.
		expect(() => {
			registerEmailJobs();
			registerEmailJobs();
		}).not.toThrow();
		expect(
			applicationJobs.list().filter((job) => job.name === EMAIL_QUEUE_DRAIN_JOB_NAME)
		).toHaveLength(1);
	});
});

describe('the superuser screen, through the exact call /admin/jobs makes', () => {
	it('lists the email drain job and the history prune job with their last runs', async () => {
		// `src/routes/(app)/admin/jobs/+page.server.ts` calls `listJobsWithLastRun` with
		// `applicationJobs` and nothing else, so this is the whole of what that page will show — and
		// the reason registering the job needed no edit to the page.
		const superuserId = await insertSuperuser('Pengurus Pekerjaan Email');
		const clock = new FakeClock(DRAIN_LISTED_AT);
		await runJob({
			db: testDb.db,
			clock,
			job: emailQueueDrainJob({ sender: new FakeEmailSender() })
		});

		const listed = await listJobsWithLastRun({
			db: testDb.db,
			clock,
			registry: applicationJobs,
			actorId: superuserId
		});

		// The registry lists by name, and `email-queue-drain` sorts before `job-run-history-prune`.
		expect(listed.map((job) => job.name)).toEqual([
			EMAIL_QUEUE_DRAIN_JOB_NAME,
			JOB_RUN_PRUNE_JOB_NAME
		]);
		const drain = listed.find((job) => job.name === EMAIL_QUEUE_DRAIN_JOB_NAME);
		expect(drain?.currentPeriod).toBe(DRAIN_LISTED_AT);
		expect(drain?.lastRun).toMatchObject({
			period: DRAIN_LISTED_AT,
			status: JOB_RUN_STATUS.succeeded
		});
	});
});

describe('isSchedulerProcess', () => {
	it('is false while building, because there is no database at build time', () => {
		expect(isSchedulerProcess({ building: true, environment: {} })).toBe(false);
	});

	it('is false under Vitest, which this very test proves by asking about its own environment', () => {
		expect(process.env.VITEST).toBeDefined();
		expect(isSchedulerProcess({ building: false })).toBe(false);
	});

	it('is true in a running server, which is neither', () => {
		expect(isSchedulerProcess({ building: false, environment: {} })).toBe(true);
	});
});

describe('startJobScheduler', () => {
	it('runs due jobs over and over with nobody calling anything', async () => {
		const job = countingJob('tick-repeats', everyTickSchedule('tick-repeats'));
		startJobScheduler({
			db: testDb.db,
			clock: new FakeClock(START),
			registry: registryOf(job.definition),
			intervalMilliseconds: TICK_MILLISECONDS
		});

		// More than one: the first run could be the tick `startJobScheduler` fires immediately, and a
		// trigger that fired once and stopped would not be a periodic one.
		expect(await waitFor(() => job.contexts.length >= 2)).toBe(true);
	});

	it('leaves one failing job unable to stop the job after it in the same tick', async () => {
		const period = 'tick-one-period';
		const failing = alwaysFailingJob('tick-a-failing', fixedSchedule(period));
		const following = countingJob('tick-b-following', fixedSchedule(period));
		startJobScheduler({
			db: testDb.db,
			clock: new FakeClock(START),
			registry: registryOf(failing, following.definition),
			intervalMilliseconds: TICK_MILLISECONDS
		});

		expect(await waitFor(() => following.contexts.length >= 1)).toBe(true);
		const failures = await runsOf(failing.name);
		expect(failures[0]).toMatchObject({ status: JOB_RUN_STATUS.failed, error: FAILURE_MESSAGE });
	});

	it('replaces the trigger already running rather than adding a second one', async () => {
		// The `vite dev` reload case: the module that calls this is evaluated again. Two live
		// intervals would both keep ticking against the database, and nothing would hold the first.
		const first = countingJob('tick-first', everyTickSchedule('tick-first'));
		const second = countingJob('tick-second', everyTickSchedule('tick-second'));
		const options = {
			db: testDb.db,
			clock: new FakeClock(START),
			intervalMilliseconds: TICK_MILLISECONDS
		};

		startJobScheduler({ ...options, registry: registryOf(first.definition) });
		expect(await waitFor(() => first.contexts.length >= 1)).toBe(true);
		startJobScheduler({ ...options, registry: registryOf(second.definition) });
		expect(await waitFor(() => second.contexts.length >= 2)).toBe(true);

		// Stopping cancels the next tick, not a tick already waiting on the database, so the count is
		// taken once that one has had time to land rather than the instant the replacement happened.
		await pause(SETTLE_MILLISECONDS);
		const firstAfterReplacement = first.contexts.length;
		await pause(SETTLE_MILLISECONDS);

		expect(first.contexts).toHaveLength(firstAfterReplacement);
	});

	it('stops for good when it is stopped', async () => {
		const job = countingJob('tick-stops', everyTickSchedule('tick-stops'));
		startJobScheduler({
			db: testDb.db,
			clock: new FakeClock(START),
			registry: registryOf(job.definition),
			intervalMilliseconds: TICK_MILLISECONDS
		});
		expect(await waitFor(() => job.contexts.length >= 1)).toBe(true);

		stopJobScheduler();
		// The tick that was already awaiting the database when the interval was cleared still
		// finishes — stopping the trigger cancels the next tick, it does not abandon one in flight.
		await pause(SETTLE_MILLISECONDS);
		const afterStop = job.contexts.length;
		await pause(SETTLE_MILLISECONDS);

		expect(job.contexts).toHaveLength(afterStop);
	});
});

describe('two instances ticking at once', () => {
	it('still produces one execution per job name and period, because the tick takes the same lock', async () => {
		// The stand-in connection is the second application instance: it holds an uncommitted claim on
		// this exact pair, which is the window in which a check-then-insert would already have read
		// "nothing has run" and gone ahead. The periodic trigger must not run the job at all.
		const period = 'race-one-execution';
		const job = countingJob('race-periodic-tick', fixedSchedule(period));
		const other = await connectToSchema();
		try {
			await claimThroughOpenTransaction(other.client, job.definition.name, period);

			startJobScheduler({
				db: testDb.db,
				clock: new FakeClock(START),
				registry: registryOf(job.definition),
				intervalMilliseconds: TICK_MILLISECONDS
			});
			await pause(SETTLE_MILLISECONDS);
			expect(job.contexts).toHaveLength(0);

			await other.client.query('COMMIT');
			await pause(SETTLE_MILLISECONDS);

			// Unblocked, every tick from here on sees the committed row and skips. One row, no runs.
			expect(job.contexts).toHaveLength(0);
			expect(await runsOf(job.definition.name)).toHaveLength(1);
		} finally {
			await other.release();
		}
	});
});

describe('pruneJobRuns', () => {
	it('removes finished runs older than the retention window', async () => {
		const jobName = 'prune-old';
		await insertRun({
			jobName,
			period: 'old-1',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(RETENTION_DAYS + 10)
		});
		await insertRun({
			jobName,
			period: 'old-2',
			status: JOB_RUN_STATUS.failed,
			startedAt: daysBeforeStart(RETENTION_DAYS + 5)
		});
		await insertRun({
			jobName,
			period: 'recent',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(1)
		});

		const removed = await pruneJobRuns(testDb.db, new FakeClock(START));

		expect(removed).toBe(2);
		expect(await periodsOf(jobName)).toEqual(['recent']);
	});

	it('never removes a running row, however old it is, because it is a live claim', async () => {
		const jobName = 'prune-running';
		await insertRun({
			jobName,
			period: 'old-running',
			status: JOB_RUN_STATUS.running,
			startedAt: daysBeforeStart(RETENTION_DAYS + 100)
		});
		await insertRun({
			jobName,
			period: 'old-finished',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(RETENTION_DAYS + 50)
		});
		await insertRun({
			jobName,
			period: 'recent',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(1)
		});

		const removed = await pruneJobRuns(testDb.db, new FakeClock(START));

		expect(removed).toBe(1);
		expect(await periodsOf(jobName)).toEqual(['old-running', 'recent']);
	});

	it('never removes the most recent run of a job, however old that run is', async () => {
		// Otherwise a job that last ran a year ago reads on /admin/jobs as one that never ran at all.
		const jobName = 'prune-keeps-latest';
		await insertRun({
			jobName,
			period: 'older',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(RETENTION_DAYS + 200)
		});
		await insertRun({
			jobName,
			period: 'latest',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(RETENTION_DAYS + 100)
		});

		const removed = await pruneJobRuns(testDb.db, new FakeClock(START));

		expect(removed).toBe(1);
		expect(await periodsOf(jobName)).toEqual(['latest']);
	});

	it('leaves the lock on a period that is still current, which is why the window is ninety days', async () => {
		// The rule the retention window exists for: a succeeded row *is* the lock, so pruning one
		// would let its period run a second time. Nothing inside the window may be touched.
		const jobName = 'prune-current-period';
		const clock = new FakeClock(START);
		const currentPeriod = '2026-01';
		const claim = await claimJobRun(testDb.db, clock, { jobName, period: currentPeriod });
		if (!claim) {
			throw new TypeError('Expected this claim to be granted, and it was not.');
		}
		await completeJobRun(testDb.db, clock, claim.runId);
		await insertRun({
			jobName,
			period: 'long-gone',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(RETENTION_DAYS + 1)
		});

		const removed = await pruneJobRuns(testDb.db, clock);

		expect(removed).toBe(1);
		expect(await claimJobRun(testDb.db, clock, { jobName, period: currentPeriod })).toBeUndefined();
	});

	it('removes no more than it was asked to in one run', async () => {
		const jobName = 'prune-bounded';
		for (const index of [1, 2, 3, 4]) {
			await insertRun({
				jobName,
				period: `old-${index}`,
				status: JOB_RUN_STATUS.succeeded,
				startedAt: daysBeforeStart(RETENTION_DAYS + index)
			});
		}

		const removed = await pruneJobRuns(testDb.db, new FakeClock(START), { limit: 2 });

		expect(removed).toBe(2);
		// Four rows, the newest kept as the latest run, two of the other three taken.
		expect(await periodsOf(jobName)).toHaveLength(2);
	});

	it('leaves a job whose whole history is inside the window untouched', async () => {
		const jobName = 'prune-all-recent';
		await insertRun({
			jobName,
			period: 'a',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(2)
		});
		await insertRun({
			jobName,
			period: 'b',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(1)
		});

		await pruneJobRuns(testDb.db, new FakeClock(START));

		expect(await periodsOf(jobName)).toEqual(['a', 'b']);
	});

	it('does nothing at all against a history that is empty', async () => {
		// Last of this group on purpose: it empties the table to reach the one branch that cannot be
		// reached any other way, and the tests after it write their own rows.
		await testDb.db.delete(jobRuns);

		expect(await pruneJobRuns(testDb.db, new FakeClock(START))).toBe(0);
	});
});

describe('the history prune job', () => {
	it('is registered in applicationJobs, so a superuser can see it and run it', () => {
		expect(applicationJobs.get(JOB_RUN_PRUNE_JOB_NAME)).toBe(jobRunPruneJob);
	});

	it('trims the history when the scheduler runs it, like any other job', async () => {
		const jobName = 'prune-via-scheduler-target';
		await insertRun({
			jobName,
			period: 'long-gone',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(RETENTION_DAYS + 30)
		});
		await insertRun({
			jobName,
			period: 'recent',
			status: JOB_RUN_STATUS.succeeded,
			startedAt: daysBeforeStart(2)
		});

		const outcome = await runJob({
			db: testDb.db,
			clock: new FakeClock(START),
			job: jobRunPruneJob
		});

		expect(outcome.outcome).toBe(JOB_OUTCOME.succeeded);
		expect(await periodsOf(jobName)).toEqual(['recent']);
	});
});
