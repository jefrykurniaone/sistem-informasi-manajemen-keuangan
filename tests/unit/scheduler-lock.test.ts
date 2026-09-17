import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { jobRuns, JOB_RUN_STATUS, type JobRun } from '$lib/server/db/schema/scheduler';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	ABANDONED_RUN_ERROR,
	claimJobRun,
	completeJobRun,
	failJobRun,
	latestJobRun,
	type JobClaim
} from '$lib/server/scheduler/lock';
import {
	JOB_OUTCOME,
	JOB_TRIGGER_ACTION,
	JobRegistry,
	listJobsWithLastRun,
	monthlySchedule,
	runDueJobs,
	runJob,
	triggerJob,
	type JobContext,
	type JobDefinition,
	type Schedule
} from '$lib/server/scheduler';

/**
 * The lock that makes a scheduled job run exactly once per period, and the scheduler built on it —
 * against a real PostgreSQL, because the guarantee is a property of a unique index and of what
 * PostgreSQL does when two transactions reach it at once. Nothing here could be proven against a
 * fake.
 *
 * Two of these tests are the ones that matter, and both work by *forcing* an interleaving rather
 * than hoping for one. Firing two claims at once and seeing one winner proves nothing: the first
 * usually commits before the second reaches the index, so a version with no lock at all would pass
 * it. The tests under "two claimers racing for the same period" instead open a second connection
 * into this file's schema, leave an uncommitted claim sitting in it, and assert that the real
 * `claimJobRun` is still *blocked* several hundred milliseconds later — which is the only direct
 * evidence that the index, and not luck, is what decides.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-01-01T00:00:00.000Z';

/** The period marker most tests here claim. */
const PERIOD = '2026-01';

/** A second period, for the tests about a job being free to run again in the next one. */
const NEXT_PERIOD = '2026-02';

/** What a job that is made to fail throws. */
const FAILURE_MESSAGE = 'the job could not finish';

/** A short lease, so that a test can move a fake clock past it without waiting. */
const SHORT_LEASE_MILLISECONDS = 60_000;

/** How long a claim is given to prove it is genuinely blocked rather than merely slow. */
const BLOCKED_FOR_MILLISECONDS = 300;

/** A schedule that puts every instant in one period, for tests that are not about time. */
function fixedSchedule(period: string): Schedule {
	return { description: `fixed at ${period}`, periodFor: () => period };
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

/** A job that throws the first time it is run and succeeds afterwards. */
function flakyJob(
	name: string,
	schedule: Schedule
): { definition: JobDefinition; runs: () => number } {
	let attempts = 0;
	return {
		runs: () => attempts,
		definition: {
			name,
			schedule,
			run: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error(FAILURE_MESSAGE);
				}
			}
		}
	};
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
async function insertUser(name: string): Promise<string> {
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
	return id;
}

/** A superuser, for every test that needs a caller `ACTION.manageJobs` lets through. */
async function insertSuperuser(name: string): Promise<string> {
	const id = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId: id, role: ROLE.superuser, createdAt: new Date(START) });
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

/**
 * The claim a test was granted. A test that reached here without one has nothing left to check, so
 * it stops at the point the expectation was broken rather than a few lines later.
 */
function requireClaim(claim: JobClaim | undefined): JobClaim {
	if (!claim) {
		throw new TypeError('Expected this claim to be granted, and it was not.');
	}
	return claim;
}

/** One run, read straight back from the table. */
async function readRun(runId: string): Promise<JobRun> {
	const [row] = await testDb.db.select().from(jobRuns).where(eq(jobRuns.id, runId));
	return row;
}

/**
 * A second, independent connection into this file's own schema — a stand-in for a concurrent
 * scheduler, with its own client and its own transaction, never sharing one with `testDb.db`.
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
			new Date(Date.parse(START) + SHORT_LEASE_MILLISECONDS)
		]
	);
}

/** Whether `promise` has settled yet, either way. */
function settlementOf(promise: Promise<unknown>): () => boolean {
	let settled = false;
	const remember = (): void => {
		settled = true;
	};
	promise.then(remember, remember);
	return () => settled;
}

/** Waits long enough that a query which has not answered is genuinely waiting on a lock. */
async function waitOutABlockedQuery(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, BLOCKED_FOR_MILLISECONDS));
}

describe('claimJobRun', () => {
	it('grants the lock and opens a running row, stamped with the clock it was given', async () => {
		const jobName = 'claim-opens-a-row';

		const claim = await claimJobRun(testDb.db, new FakeClock(START), {
			jobName,
			period: PERIOD,
			leaseMilliseconds: SHORT_LEASE_MILLISECONDS
		});

		expect(claim).toMatchObject({ jobName, period: PERIOD });
		const row = await readRun(requireClaim(claim).runId);
		expect(row).toMatchObject({
			jobName,
			period: PERIOD,
			status: JOB_RUN_STATUS.running,
			finishedAt: null,
			error: null
		});
		expect(row.startedAt.getTime()).toBe(Date.parse(START));
		expect(row.leaseExpiresAt.getTime()).toBe(Date.parse(START) + SHORT_LEASE_MILLISECONDS);
	});

	it('refuses a second claim on the same job and period, by answering nothing rather than throwing', async () => {
		const jobName = 'claim-refused-twice';
		await claimJobRun(testDb.db, new FakeClock(START), { jobName, period: PERIOD });

		const second = await claimJobRun(testDb.db, new FakeClock(START), { jobName, period: PERIOD });

		expect(second).toBeUndefined();
		expect(await runsOf(jobName)).toHaveLength(1);
	});

	it('grants a claim for another period of the same job, and for another job in the same period', async () => {
		const jobName = 'claim-other-period';
		await claimJobRun(testDb.db, new FakeClock(START), { jobName, period: PERIOD });

		const nextPeriod = await claimJobRun(testDb.db, new FakeClock(START), {
			jobName,
			period: NEXT_PERIOD
		});
		const otherJob = await claimJobRun(testDb.db, new FakeClock(START), {
			jobName: 'claim-other-job',
			period: PERIOD
		});

		expect(nextPeriod).toMatchObject({ period: NEXT_PERIOD });
		expect(otherJob).toMatchObject({ jobName: 'claim-other-job' });
	});
});

describe('a run that has finished', () => {
	it('holds its lock forever once it succeeded, so the period is never run again', async () => {
		const jobName = 'succeeded-holds-forever';
		const clock = new FakeClock(START);
		const claim = await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });
		clock.advance(SHORT_LEASE_MILLISECONDS);
		await completeJobRun(testDb.db, clock, requireClaim(claim).runId);

		// Far beyond any lease: a successful run is not abandoned, it is done.
		clock.advance(365 * 24 * 60 * 60 * 1000);
		const again = await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });

		expect(again).toBeUndefined();
		const [row] = await runsOf(jobName);
		expect(row).toMatchObject({ status: JOB_RUN_STATUS.succeeded, error: null });
		expect(row.finishedAt?.getTime()).toBe(Date.parse(START) + SHORT_LEASE_MILLISECONDS);
	});

	it('releases its lock when it failed, and stays as the record that it failed', async () => {
		const jobName = 'failed-releases';
		const clock = new FakeClock(START);
		const claim = await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });
		clock.advance(1000);
		await failJobRun(testDb.db, clock, requireClaim(claim).runId, FAILURE_MESSAGE);

		const again = await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });

		expect(again).toMatchObject({ jobName, period: PERIOD });
		const rows = await runsOf(jobName);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ status: JOB_RUN_STATUS.failed, error: FAILURE_MESSAGE });
		expect(rows[1]).toMatchObject({ status: JOB_RUN_STATUS.running, period: PERIOD });
	});
});

describe('a claim whose process died without recording an outcome', () => {
	it('still holds the lock while its lease has not passed', async () => {
		const jobName = 'lease-still-held';
		const clock = new FakeClock(START);
		await claimJobRun(testDb.db, clock, {
			jobName,
			period: PERIOD,
			leaseMilliseconds: SHORT_LEASE_MILLISECONDS
		});

		clock.advance(SHORT_LEASE_MILLISECONDS - 1);

		expect(await claimJobRun(testDb.db, clock, { jobName, period: PERIOD })).toBeUndefined();
	});

	it('is taken over once its lease has passed, and left as a failure that says why', async () => {
		const jobName = 'lease-taken-over';
		const clock = new FakeClock(START);
		const abandoned = await claimJobRun(testDb.db, clock, {
			jobName,
			period: PERIOD,
			leaseMilliseconds: SHORT_LEASE_MILLISECONDS
		});

		clock.advance(SHORT_LEASE_MILLISECONDS);
		const taken = await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });

		expect(taken).toMatchObject({ jobName, period: PERIOD });
		expect(await readRun(requireClaim(abandoned).runId)).toMatchObject({
			status: JOB_RUN_STATUS.failed,
			error: ABANDONED_RUN_ERROR
		});
	});

	it('cannot be finished afterwards by the process that abandoned it', async () => {
		// The lost process comes back and writes its outcome. The row is no longer its own — another
		// run holds the period now — so the write has to do nothing at all.
		const jobName = 'lease-late-finisher';
		const clock = new FakeClock(START);
		const abandoned = await claimJobRun(testDb.db, clock, {
			jobName,
			period: PERIOD,
			leaseMilliseconds: SHORT_LEASE_MILLISECONDS
		});
		clock.advance(SHORT_LEASE_MILLISECONDS);
		await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });

		await completeJobRun(testDb.db, clock, requireClaim(abandoned).runId);

		expect(await readRun(requireClaim(abandoned).runId)).toMatchObject({
			status: JOB_RUN_STATUS.failed,
			error: ABANDONED_RUN_ERROR
		});
	});
});

describe('two claimers racing for the same period', () => {
	it('blocks the second claim until the first transaction ends, and then skips it', async () => {
		// The stand-in connection holds an uncommitted claim on this exact pair — the window in
		// which a `select`-then-`insert` would already have read "nothing has run yet" and gone
		// ahead. The real `claimJobRun` must not get an answer at all while that window is open.
		const jobName = 'race-blocked-then-skips';
		const other = await connectToSchema();
		try {
			await claimThroughOpenTransaction(other.client, jobName, PERIOD);

			const claim = claimJobRun(testDb.db, new FakeClock(START), { jobName, period: PERIOD });
			const hasSettled = settlementOf(claim);

			await waitOutABlockedQuery();
			expect(hasSettled()).toBe(false);

			await other.client.query('COMMIT');

			// Unblocked, it sees the committed row and skips — the outcome a second scheduler must
			// reach, and the one an unlocked check would have got wrong by running the job twice.
			await expect(claim).resolves.toBeUndefined();
			expect(await runsOf(jobName)).toHaveLength(1);
		} finally {
			await other.release();
		}
	});

	it('grants the second claim when the first transaction rolls back', async () => {
		// The mirror image: nothing was really claimed, so the waiting claimer has to end up with the
		// lock rather than skipping a period that never ran.
		const jobName = 'race-blocked-then-claims';
		const other = await connectToSchema();
		try {
			await claimThroughOpenTransaction(other.client, jobName, PERIOD);

			const claim = claimJobRun(testDb.db, new FakeClock(START), { jobName, period: PERIOD });
			const hasSettled = settlementOf(claim);

			await waitOutABlockedQuery();
			expect(hasSettled()).toBe(false);

			await other.client.query('ROLLBACK');

			await expect(claim).resolves.toMatchObject({ jobName, period: PERIOD });
			expect(await runsOf(jobName)).toHaveLength(1);
		} finally {
			await other.release();
		}
	});
});

describe('runJob', () => {
	it('runs the job and records that it succeeded', async () => {
		const job = countingJob('run-once-succeeds', fixedSchedule(PERIOD));
		const clock = new FakeClock(START);

		const outcome = await runJob({ db: testDb.db, clock, job: job.definition });

		expect(outcome).toEqual({
			jobName: job.definition.name,
			period: PERIOD,
			outcome: JOB_OUTCOME.succeeded
		});
		expect(job.contexts).toHaveLength(1);
		const [row] = await runsOf(job.definition.name);
		expect(row).toMatchObject({ status: JOB_RUN_STATUS.succeeded, period: PERIOD, error: null });
	});

	it('runs the same job for the same period exactly once, however often it is asked to', async () => {
		const job = countingJob('run-twice-one-execution', fixedSchedule(PERIOD));
		const clock = new FakeClock(START);

		const first = await runJob({ db: testDb.db, clock, job: job.definition });
		const second = await runJob({ db: testDb.db, clock, job: job.definition });

		expect(first.outcome).toBe(JOB_OUTCOME.succeeded);
		expect(second.outcome).toBe(JOB_OUTCOME.skipped);
		expect(job.contexts).toHaveLength(1);
		expect(await runsOf(job.definition.name)).toHaveLength(1);
	});

	it('hands the job the period it is running for, the clock, and the instant it was claimed at', async () => {
		const job = countingJob('run-context', fixedSchedule(PERIOD));
		const clock = new FakeClock(START);

		await runJob({ db: testDb.db, clock, job: job.definition });

		expect(job.contexts[0].db).toBe(testDb.db);
		expect(job.contexts[0].clock).toBe(clock);
		expect(job.contexts[0].period).toBe(PERIOD);
		expect(job.contexts[0].startedAt.getTime()).toBe(Date.parse(START));
	});

	it('records a failure without throwing, and lets the next attempt at that period run', async () => {
		const job = flakyJob('run-fails-then-runs', fixedSchedule(PERIOD));
		const clock = new FakeClock(START);

		const failed = await runJob({ db: testDb.db, clock, job: job.definition });
		clock.advance(1000);
		const retried = await runJob({ db: testDb.db, clock, job: job.definition });

		expect(failed).toMatchObject({ outcome: JOB_OUTCOME.failed, error: FAILURE_MESSAGE });
		expect(retried.outcome).toBe(JOB_OUTCOME.succeeded);
		expect(job.runs()).toBe(2);
		const rows = await runsOf(job.definition.name);
		expect(rows[0]).toMatchObject({ status: JOB_RUN_STATUS.failed, error: FAILURE_MESSAGE });
		expect(rows[1]).toMatchObject({ status: JOB_RUN_STATUS.succeeded, error: null });
	});

	it('runs again once the clock has moved into the next period', async () => {
		const job = countingJob('run-next-period', monthlySchedule('UTC'));
		const clock = new FakeClock(START);

		const first = await runJob({ db: testDb.db, clock, job: job.definition });
		const sameMonth = await runJob({ db: testDb.db, clock, job: job.definition });
		clock.set('2026-02-01T00:00:00.000Z');
		const nextMonth = await runJob({ db: testDb.db, clock, job: job.definition });

		expect([first.period, sameMonth.period, nextMonth.period]).toEqual([
			PERIOD,
			PERIOD,
			NEXT_PERIOD
		]);
		expect([first.outcome, sameMonth.outcome, nextMonth.outcome]).toEqual([
			JOB_OUTCOME.succeeded,
			JOB_OUTCOME.skipped,
			JOB_OUTCOME.succeeded
		]);
		expect(job.contexts).toHaveLength(2);
	});
});

describe('runDueJobs', () => {
	it('runs every registered job, and one that throws does not stop the rest', async () => {
		const failing = flakyJob('tick-failing', fixedSchedule(PERIOD));
		const following = countingJob('tick-following', fixedSchedule(PERIOD));
		const registry = new JobRegistry();
		registry.register(failing.definition);
		registry.register(following.definition);

		const outcomes = await runDueJobs({ db: testDb.db, clock: new FakeClock(START), registry });

		expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
			JOB_OUTCOME.failed,
			JOB_OUTCOME.succeeded
		]);
		expect(following.contexts).toHaveLength(1);
	});
});

describe('listJobsWithLastRun', () => {
	it('refuses a caller who is not a superuser', async () => {
		const residentId = await insertUser('Warga Penasaran Pekerjaan');

		await expect(
			listJobsWithLastRun({
				db: testDb.db,
				clock: new FakeClock(START),
				registry: new JobRegistry(),
				actorId: residentId
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	it('gives a superuser every job, the period it is in, and what happened to it last', async () => {
		const superuserId = await insertSuperuser('Pengurus Daftar Pekerjaan');
		const job = countingJob('list-with-last-run', fixedSchedule(PERIOD));
		const registry = new JobRegistry();
		registry.register(job.definition);
		const clock = new FakeClock(START);
		await runJob({ db: testDb.db, clock, job: job.definition });

		const listed = await listJobsWithLastRun({
			db: testDb.db,
			clock,
			registry,
			actorId: superuserId
		});

		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ name: job.definition.name, currentPeriod: PERIOD });
		expect(listed[0].lastRun).toMatchObject({
			period: PERIOD,
			status: JOB_RUN_STATUS.succeeded
		});
	});

	it('says a job has never run when nothing has ever claimed it', async () => {
		const superuserId = await insertSuperuser('Pengurus Pekerjaan Baru');
		const registry = new JobRegistry();
		registry.register(countingJob('list-never-run', fixedSchedule(PERIOD)).definition);

		const listed = await listJobsWithLastRun({
			db: testDb.db,
			clock: new FakeClock(START),
			registry,
			actorId: superuserId
		});

		expect(listed[0].lastRun).toBeUndefined();
	});
});

describe('triggerJob', () => {
	it('refuses a caller who is not a superuser, and runs nothing', async () => {
		const residentId = await insertUser('Warga Tak Berhak Memicu');
		const job = countingJob('trigger-refused', fixedSchedule(PERIOD));
		const registry = new JobRegistry();
		registry.register(job.definition);

		await expect(
			triggerJob({
				db: testDb.db,
				clock: new FakeClock(START),
				registry,
				actorId: residentId,
				jobName: job.definition.name
			})
		).rejects.toThrow(PermissionDeniedError);
		expect(job.contexts).toHaveLength(0);
	});

	it('answers nothing for a name no job is registered under', async () => {
		const superuserId = await insertSuperuser('Pengurus Nama Salah');

		const outcome = await triggerJob({
			db: testDb.db,
			clock: new FakeClock(START),
			registry: new JobRegistry(),
			actorId: superuserId,
			jobName: 'nothing-is-registered-under-this'
		});

		expect(outcome).toBeUndefined();
	});

	it('runs the job now and records in the audit log who asked for it', async () => {
		const superuserId = await insertSuperuser('Pengurus Pemicu');
		const job = countingJob('trigger-runs', fixedSchedule(PERIOD));
		const registry = new JobRegistry();
		registry.register(job.definition);

		const outcome = await triggerJob({
			db: testDb.db,
			clock: new FakeClock(START),
			registry,
			actorId: superuserId,
			jobName: job.definition.name
		});

		expect(outcome).toMatchObject({ outcome: JOB_OUTCOME.succeeded, period: PERIOD });
		expect(job.contexts).toHaveLength(1);
		const entries = await auditEntriesFor(testDb.db, job.definition.name);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: JOB_TRIGGER_ACTION,
			targetId: job.definition.name,
			after: { period: PERIOD, outcome: JOB_OUTCOME.succeeded }
		});
	});

	it('skips a period that has already run rather than running it a second time', async () => {
		const superuserId = await insertSuperuser('Pengurus Pemicu Dua Kali');
		const job = countingJob('trigger-twice', fixedSchedule(PERIOD));
		const registry = new JobRegistry();
		registry.register(job.definition);
		const request = {
			db: testDb.db,
			clock: new FakeClock(START),
			registry,
			actorId: superuserId,
			jobName: job.definition.name
		};
		await triggerJob(request);

		const second = await triggerJob(request);

		expect(second).toMatchObject({ outcome: JOB_OUTCOME.skipped, period: PERIOD });
		expect(job.contexts).toHaveLength(1);
	});
});

describe('latestJobRun', () => {
	it('is nothing at all for a job that has never run', async () => {
		expect(await latestJobRun(testDb.db, 'latest-never-run')).toBeUndefined();
	});

	it('is the most recently started run, not the first one', async () => {
		const jobName = 'latest-most-recent';
		const clock = new FakeClock(START);
		const first = await claimJobRun(testDb.db, clock, { jobName, period: PERIOD });
		await failJobRun(testDb.db, clock, requireClaim(first).runId, FAILURE_MESSAGE);
		clock.advance(SHORT_LEASE_MILLISECONDS);
		await claimJobRun(testDb.db, clock, { jobName, period: NEXT_PERIOD });

		expect(await latestJobRun(testDb.db, jobName)).toMatchObject({
			period: NEXT_PERIOD,
			status: JOB_RUN_STATUS.running
		});
	});
});
