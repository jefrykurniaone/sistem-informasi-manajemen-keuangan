import { asc, DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { DatabaseError, type Pool, type PoolConfig, type QueryConfig } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createConnection,
	failureCode,
	isConnectionFailure,
	readDatabaseUrl,
	type Connection
} from '$lib/server/db';
import {
	jobRuns,
	JOB_RUN_STATUS,
	type JobRun,
	type JobRunStatus
} from '$lib/server/db/schema/scheduler';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	JOB_OUTCOME,
	JOB_STEP,
	JobRegistry,
	runDueJobs,
	type JobDefinition,
	type JobIncident,
	type JobOutcome,
	type JobOutcomeKind,
	type JobStep,
	type Schedule
} from '$lib/server/scheduler';
import { ABANDONED_RUN_ERROR, DEFAULT_LEASE_MILLISECONDS } from '$lib/server/scheduler/lock';

/**
 * What ticket #215 asked of the scheduler and of the pool under it, when the database ends a
 * connection from its side: the process does not crash, one job's failure does not stop the jobs
 * after it in the same tick, and the claim, the completion and the failure record are each retried
 * once after a connection failure without any job ever running twice for one period.
 *
 * Against a real PostgreSQL, like the lock tests, and with a real `pg_terminate_backend` wherever
 * the timing can be forced: an idle client, a client held inside a transaction, and a claim held in
 * flight on the unique index by another connection's uncommitted row. The cases that cannot be
 * timed that way, above all a claim the server committed whose answer was then lost, go through a
 * pool whose `query` throws the error PostgreSQL sends, `57P01`, before or after really running the
 * statement.
 *
 * `pg_terminate_backend` is only ever given a pid this file read off a connection it opened itself:
 * the server is shared with other test runs.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-01-01T00:00:00.000Z';

/** The one period every job in this file is in. */
const PERIOD = '2026-01';

/** How long `pg_terminate_backend` is given to see the backend actually gone before it answers. */
const TERMINATION_WAIT_MILLISECONDS = 5000;

/** How long a test waits for a state it polls the database for. */
const WAIT_TIMEOUT_MILLISECONDS = 5000;

/** How long between two polls. */
const POLL_MILLISECONDS = 20;

/** The SQLSTATE PostgreSQL sends when a session is terminated: admin_shutdown. */
const SESSION_TERMINATED = '57P01';

/** What PostgreSQL says with it. */
const SESSION_TERMINATED_MESSAGE = 'terminating connection due to administrator command';

/** What a job made to fail throws. */
const JOB_FAILURE_MESSAGE = 'this job throws';

/** Every connection a test opened, closed after it whatever it came to. */
const opened: Connection[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const connection of opened.splice(0)) {
		await connection.close();
	}
});

/** A connection built by the production factory, into this file's own schema. */
function connectUnderTest(settings: PoolConfig = {}): Connection {
	const connection = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
		...settings,
		options: `-c search_path=${testDb.schemaName}`
	});
	opened.push(connection);
	return connection;
}

/**
 * The backend pid of a client taken from `pool` and handed straight back, so that the pool is left
 * holding exactly that client idle.
 */
async function idleClientPid(pool: Pool): Promise<number> {
	const client = await pool.connect();
	try {
		const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
		return rows[0].pid;
	} finally {
		client.release();
	}
}

/**
 * Terminates the one backend `pid` names, from this file's own connection, and waits until it is
 * really gone. Never by any other filter: the server is shared with other test runs.
 */
async function terminateBackend(pid: number): Promise<void> {
	const result = await testDb.db.execute<{ terminated: boolean }>(
		sql`select pg_terminate_backend(${pid}::int, ${TERMINATION_WAIT_MILLISECONDS}::bigint) as terminated`
	);
	expect(result.rows[0]?.terminated).toBe(true);
}

/**
 * Resolves the next time `pool` drops a client. Deliberately not `events.once`: that helper adds an
 * `error` listener to the emitter while it waits, which is exactly the listener these tests are
 * about, and would hide its absence.
 */
function nextRemoval(pool: Pool): Promise<void> {
	return new Promise((resolve) => {
		pool.once('remove', () => resolve());
	});
}

/** Waits for `milliseconds`, between two polls of the database. */
function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Every run of one job, oldest first. */
async function runsOf(jobName: string): Promise<JobRun[]> {
	return testDb.db
		.select()
		.from(jobRuns)
		.where(eq(jobRuns.jobName, jobName))
		.orderBy(asc(jobRuns.startedAt), asc(jobRuns.id));
}

/** A schedule that puts every instant in `PERIOD`. */
const fixedSchedule: Schedule = { description: `fixed at ${PERIOD}`, periodFor: () => PERIOD };

/** A job that counts how often its function ran, and throws every time when asked to. */
function countingJob(
	name: string,
	behaviour: { readonly throws?: boolean; readonly schedule?: Schedule } = {}
): { readonly definition: JobDefinition; readonly runs: () => number } {
	let runs = 0;
	return {
		runs: () => runs,
		definition: {
			name,
			schedule: behaviour.schedule ?? fixedSchedule,
			run: async () => {
				runs += 1;
				if (behaviour.throws) {
					throw new Error(JOB_FAILURE_MESSAGE);
				}
			}
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

/** Each outcome as `[job name, outcome]`, for one comparison per tick. */
function outcomesOf(outcomes: readonly JobOutcome[]): [string, JobOutcomeKind][] {
	return outcomes.map((outcome) => [outcome.jobName, outcome.outcome]);
}

/** The error PostgreSQL sends with `code`, as the driver builds it. */
function databaseError(code: string, message: string): DatabaseError {
	const error = new DatabaseError(message, message.length, 'error');
	error.code = code;
	return error;
}

/** The error a connection the server terminated fails its statement with. */
function sessionTerminated(): DatabaseError {
	return databaseError(SESSION_TERMINATED, SESSION_TERMINATED_MESSAGE);
}

/** One scripted failure of the statements a pool is asked to run. */
interface QueryFault {
	/** Which statements it fails. */
	readonly hits: (text: string, values: readonly unknown[]) => boolean;
	/**
	 * Whether the statement is really carried out before the failure is thrown: the server committed
	 * it, and the answer was lost with the connection.
	 */
	readonly committed: boolean;
	readonly error: () => Error;
	/** How many more statements it fails. */
	remaining: number;
}

/**
 * Makes `pool` fail the statements `faults` describe. Drizzle runs every statement outside a
 * transaction through `pool.query`, which is what the scheduler's writes to `job_runs` are.
 */
function injectFaults(pool: Pool, ...faults: QueryFault[]): void {
	// Taken before the replacement below, which would otherwise be calling itself.
	const run = pool.query.bind(pool) as (config: QueryConfig, values: unknown[]) => Promise<unknown>;
	const faulty = async (config: QueryConfig, values: unknown[] = []): Promise<unknown> => {
		const fault = faults.find(
			(candidate) => candidate.remaining > 0 && candidate.hits(config.text, values)
		);
		if (!fault) {
			return run(config, values);
		}
		fault.remaining -= 1;
		if (fault.committed) {
			await run(config, values);
		}
		throw fault.error();
	};
	Object.defineProperty(pool, 'query', { value: faulty, configurable: true });
}

/** The claim `insert` of one job. Its first parameter is the job's name. */
function claimOf(jobName: string): QueryFault['hits'] {
	return (text, values) => text.startsWith('insert into "job_runs"') && values[0] === jobName;
}

/**
 * The `update` that records `status` on one run by its id. Not job-specific: the job these tests
 * fail is always first in the registry, so it records its outcome before any other job does.
 * `expireAbandonedRun` also writes `failed`, and is told apart by filtering on the job name.
 */
function recordingOf(status: JobRunStatus): QueryFault['hits'] {
	return (text, values) =>
		text.startsWith('update "job_runs"') && !text.includes('"job_name"') && values[0] === status;
}

/** Which statement a failure at `step` hits, for the job named `jobName`. */
function statementAt(step: JobStep, jobName: string): QueryFault['hits'] {
	if (step === JOB_STEP.complete) {
		return recordingOf(JOB_RUN_STATUS.succeeded);
	}
	if (step === JOB_STEP.fail) {
		return recordingOf(JOB_RUN_STATUS.failed);
	}
	return claimOf(jobName);
}

/** A connection whose statements at `step` fail `times` times with a terminated session. */
function faultyConnection(
	step: JobStep,
	jobName: string,
	fault: { readonly times: number; readonly committed: boolean }
): { readonly connection: Connection; readonly fault: QueryFault } {
	const connection = connectUnderTest();
	const scripted: QueryFault = {
		hits: statementAt(step, jobName),
		committed: fault.committed,
		error: sessionTerminated,
		remaining: fault.times
	};
	injectFaults(connection.pool, scripted);
	return { connection, fault: scripted };
}

/** An incident this file expects, for the one period every job here is in. */
function incident(
	jobName: string,
	step: JobStep,
	retrying: boolean,
	code = SESSION_TERMINATED
): JobIncident {
	return { jobName, period: PERIOD, step, code, retrying };
}

describe('failureCode and isConnectionFailure', () => {
	/** An error the way Drizzle hands it on: the driver's error as the cause of its own. */
	const wrapped = (cause: Error): DrizzleQueryError =>
		new DrizzleQueryError('insert into "job_runs" values ($1)', ['a parameter value'], cause);

	it.each([
		['57P01, the session terminated', wrapped(sessionTerminated()), '57P01', true],
		[
			'57P02, the server resetting after a crash',
			wrapped(databaseError('57P02', 'terminating connection because of crash')),
			'57P02',
			true
		],
		[
			'57P03, the server not accepting connections yet',
			wrapped(databaseError('57P03', 'the database system is starting up')),
			'57P03',
			true
		],
		[
			'08006, connection failure',
			wrapped(databaseError('08006', 'connection failure')),
			'08006',
			true
		],
		[
			'08P01, protocol violation',
			wrapped(databaseError('08P01', 'protocol violation')),
			'08P01',
			true
		],
		[
			'the socket closing under the driver',
			wrapped(new Error('Connection terminated unexpectedly')),
			'connection-terminated',
			true
		],
		[
			'the socket being reset',
			wrapped(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
			'ECONNRESET',
			true
		],
		[
			'57014, the statement timeout',
			wrapped(databaseError('57014', 'canceling statement due to statement timeout')),
			'57014',
			false
		],
		[
			'23505, a unique violation',
			wrapped(databaseError('23505', 'duplicate key value violates unique constraint')),
			'23505',
			false
		],
		[
			'the client-side query timeout',
			wrapped(new Error('Query read timeout')),
			'query-timeout',
			false
		],
		[
			'the wait for a free connection timing out',
			wrapped(new Error('timeout exceeded when trying to connect')),
			'connect-timeout',
			false
		],
		['an error with no code', new TypeError('not a database error'), 'TypeError', false],
		['something thrown that is not an error', 'a string', 'string', false]
	])('reads %s as %s', (_label, error, code, connectionFailure) => {
		expect(failureCode(error)).toBe(code);
		expect(isConnectionFailure(error)).toBe(connectionFailure);
	});
});

describe('the pool every connection is built with', () => {
	it('bounds every wait, and has the server cancel a statement before the client gives up on it', async () => {
		const underTest = connectUnderTest();

		const result = await underTest.db.execute<{ milliseconds: number }>(
			sql`select setting::int as milliseconds from pg_settings where name = 'statement_timeout'`
		);
		const statementTimeout = result.rows[0]?.milliseconds ?? 0;

		const { options } = underTest.pool;
		expect(options.keepAlive).toBe(true);
		expect(options.keepAliveInitialDelayMillis).toBeGreaterThan(0);
		expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
		expect(statementTimeout).toBeGreaterThan(0);
		expect(options.query_timeout).toBeGreaterThan(statementTimeout);
	});
});

describe('a pooled connection the server terminates', () => {
	it('is dropped while idle without an unhandled error, logged by its code, and replaced on demand', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const underTest = connectUnderTest();
		const pid = await idleClientPid(underTest.pool);
		const removed = nextRemoval(underTest.pool);

		await terminateBackend(pid);
		await removed;

		expect(underTest.pool.totalCount).toBe(0);
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0][0])).toContain(SESSION_TERMINATED);
		expect(await idleClientPid(underTest.pool)).not.toBe(pid);
	});

	it('fails the transaction holding it without an unhandled error, and the pool serves the next query', async () => {
		const underTest = connectUnderTest();

		const attempt = underTest.db.transaction(async (transaction) => {
			const { rows } = await transaction.execute<{ pid: number }>(
				sql`select pg_backend_pid() as pid`
			);
			await terminateBackend(rows[0].pid);
			await transaction.execute(sql`select 1`);
		});

		await expect(attempt).rejects.toThrow();
		expect(underTest.pool.totalCount).toBe(0);
		const after = await underTest.db.execute<{ one: number }>(sql`select 1 as one`);
		expect(after.rows[0]?.one).toBe(1);
	});
});

describe('runDueJobs when a write to job_runs loses its connection', () => {
	it.each([
		{
			write: 'the claim, before the server saw it',
			step: JOB_STEP.claim,
			committed: false,
			throws: false,
			outcome: JOB_OUTCOME.succeeded,
			status: JOB_RUN_STATUS.succeeded
		},
		{
			write: 'the completion, before the server saw it',
			step: JOB_STEP.complete,
			committed: false,
			throws: false,
			outcome: JOB_OUTCOME.succeeded,
			status: JOB_RUN_STATUS.succeeded
		},
		{
			write: 'the completion, after the server committed it',
			step: JOB_STEP.complete,
			committed: true,
			throws: false,
			outcome: JOB_OUTCOME.succeeded,
			status: JOB_RUN_STATUS.succeeded
		},
		{
			write: 'the failure record, before the server saw it',
			step: JOB_STEP.fail,
			committed: false,
			throws: true,
			outcome: JOB_OUTCOME.failed,
			status: JOB_RUN_STATUS.failed
		},
		{
			write: 'the failure record, after the server committed it',
			step: JOB_STEP.fail,
			committed: true,
			throws: true,
			outcome: JOB_OUTCOME.failed,
			status: JOB_RUN_STATUS.failed
		}
	])(
		'retries $write once in the same tick, and the job runs exactly once',
		async ({ step, committed, throws, outcome, status }) => {
			const first = countingJob(`a-once-${step}-${committed}`, { throws });
			const next = countingJob(`b-once-${step}-${committed}`);
			const { connection, fault } = faultyConnection(step, first.definition.name, {
				times: 1,
				committed
			});
			const incidents: JobIncident[] = [];

			const outcomes = await runDueJobs({
				db: connection.db,
				clock: new FakeClock(START),
				registry: registryOf(first.definition, next.definition),
				onIncident: (reported) => incidents.push(reported)
			});

			expect(fault.remaining).toBe(0);
			expect(outcomesOf(outcomes)).toEqual([
				[first.definition.name, outcome],
				[next.definition.name, JOB_OUTCOME.succeeded]
			]);
			expect([first.runs(), next.runs()]).toEqual([1, 1]);
			expect(incidents).toEqual([incident(first.definition.name, step, true)]);
			const runs = await runsOf(first.definition.name);
			expect(runs.map((run) => run.status)).toEqual([status]);
		}
	);

	it('skips a claim that committed but whose answer was lost, and runs the period once its lease has passed', async () => {
		// The case the retry's correctness argument is about: the server committed the claim, and the
		// connection failed before this process heard so. The retried insert meets that very row in
		// `job_runs_claim_unique` and skips, the row holds the period until its lease has passed, and
		// then a claim takes it over and runs the job, once.
		const first = countingJob('a-committed-claim');
		const next = countingJob('b-after-committed-claim');
		const { connection, fault } = faultyConnection(JOB_STEP.claim, first.definition.name, {
			times: 1,
			committed: true
		});
		const clock = new FakeClock(START);
		const incidents: JobIncident[] = [];
		const tick = async (): Promise<[string, JobOutcomeKind][]> =>
			outcomesOf(
				await runDueJobs({
					db: connection.db,
					clock,
					registry: registryOf(first.definition, next.definition),
					onIncident: (reported) => incidents.push(reported)
				})
			);

		expect(await tick()).toEqual([
			[first.definition.name, JOB_OUTCOME.skipped],
			[next.definition.name, JOB_OUTCOME.succeeded]
		]);
		expect(fault.remaining).toBe(0);
		expect(first.runs()).toBe(0);
		expect(incidents).toEqual([incident(first.definition.name, JOB_STEP.claim, true)]);
		expect((await runsOf(first.definition.name)).map((run) => run.status)).toEqual([
			JOB_RUN_STATUS.running
		]);

		// Still inside the lease, the claim nobody was told about holds the period.
		clock.advance(DEFAULT_LEASE_MILLISECONDS - 1);
		expect((await tick())[0]).toEqual([first.definition.name, JOB_OUTCOME.skipped]);
		expect(first.runs()).toBe(0);

		// Once it has passed, the claim is taken over as abandoned and the period runs.
		clock.advance(1);
		expect((await tick())[0]).toEqual([first.definition.name, JOB_OUTCOME.succeeded]);
		expect(first.runs()).toBe(1);

		// And never a second time for this period.
		expect((await tick())[0]).toEqual([first.definition.name, JOB_OUTCOME.skipped]);
		expect(first.runs()).toBe(1);
		expect(next.runs()).toBe(1);
		const runs = await runsOf(first.definition.name);
		expect(runs).toHaveLength(2);
		expect(runs[0]).toMatchObject({ status: JOB_RUN_STATUS.failed, error: ABANDONED_RUN_ERROR });
		expect(runs[1]).toMatchObject({ status: JOB_RUN_STATUS.succeeded });
	});

	it.each([
		{ write: 'claim', step: JOB_STEP.claim, throws: false, ran: 0, statuses: [] },
		{
			write: 'completion',
			step: JOB_STEP.complete,
			throws: false,
			ran: 1,
			statuses: [JOB_RUN_STATUS.running]
		},
		{
			write: 'failure record',
			step: JOB_STEP.fail,
			throws: true,
			ran: 1,
			statuses: [JOB_RUN_STATUS.running]
		}
	])(
		'interrupts only its own job when the $write fails twice, and the next job still runs',
		async ({ step, throws, ran, statuses }) => {
			const first = countingJob(`a-twice-${step}`, { throws });
			const next = countingJob(`b-twice-${step}`);
			const { connection, fault } = faultyConnection(step, first.definition.name, {
				times: 2,
				committed: false
			});
			const incidents: JobIncident[] = [];

			const outcomes = await runDueJobs({
				db: connection.db,
				clock: new FakeClock(START),
				registry: registryOf(first.definition, next.definition),
				onIncident: (reported) => incidents.push(reported)
			});

			expect(fault.remaining).toBe(0);
			expect(outcomesOf(outcomes)).toEqual([
				[first.definition.name, JOB_OUTCOME.interrupted],
				[next.definition.name, JOB_OUTCOME.succeeded]
			]);
			expect(outcomes[0].error).toContain(`(${SESSION_TERMINATED})`);
			expect([first.runs(), next.runs()]).toEqual([ran, 1]);
			expect(incidents).toEqual([
				incident(first.definition.name, step, true),
				incident(first.definition.name, step, false)
			]);
			expect((await runsOf(first.definition.name)).map((run) => run.status)).toEqual(statuses);
		}
	);

	it.each([
		{
			failure: 'the statement timeout',
			code: '57014',
			error: () => databaseError('57014', 'canceling statement due to statement timeout')
		},
		{
			failure: 'the client-side query timeout',
			code: 'query-timeout',
			error: () => new Error('Query read timeout')
		},
		{
			failure: 'a unique violation',
			code: '23505',
			error: () => databaseError('23505', 'duplicate key value violates unique constraint')
		}
	])(
		'does not retry a claim that failed with $failure, and the next job still runs',
		async ({ code, error }) => {
			const first = countingJob(`a-not-retried-${code}`);
			const next = countingJob(`b-not-retried-${code}`);
			const connection = connectUnderTest();
			const fault: QueryFault = {
				hits: claimOf(first.definition.name),
				committed: false,
				error,
				remaining: 1
			};
			injectFaults(connection.pool, fault);
			const incidents: JobIncident[] = [];

			const outcomes = await runDueJobs({
				db: connection.db,
				clock: new FakeClock(START),
				registry: registryOf(first.definition, next.definition),
				onIncident: (reported) => incidents.push(reported)
			});

			// Had it been retried, the retry would have got through and the job would have run.
			expect(outcomesOf(outcomes)).toEqual([
				[first.definition.name, JOB_OUTCOME.interrupted],
				[next.definition.name, JOB_OUTCOME.succeeded]
			]);
			expect(first.runs()).toBe(0);
			expect(incidents).toEqual([incident(first.definition.name, JOB_STEP.claim, false, code)]);
		}
	);

	it('reports a schedule that throws, and still runs the job after it', async () => {
		const broken = countingJob('a-broken-schedule', {
			schedule: {
				description: 'throws',
				periodFor: () => {
					throw new RangeError('no period for this instant');
				}
			}
		});
		const next = countingJob('b-after-broken-schedule');
		const incidents: JobIncident[] = [];

		const outcomes = await runDueJobs({
			db: testDb.db,
			clock: new FakeClock(START),
			registry: registryOf(broken.definition, next.definition),
			onIncident: (reported) => incidents.push(reported)
		});

		expect(outcomesOf(outcomes)).toEqual([[next.definition.name, JOB_OUTCOME.succeeded]]);
		expect(incidents).toEqual([
			{
				jobName: broken.definition.name,
				period: undefined,
				step: JOB_STEP.schedule,
				code: 'RangeError',
				retrying: false
			}
		]);
	});

	it('logs the job, its period, the step and the code, and never the query, its parameters or the connection string', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const first = countingJob('a-logged-claim');
		const { connection } = faultyConnection(JOB_STEP.claim, first.definition.name, {
			times: 2,
			committed: false
		});

		const outcomes = await runDueJobs({
			db: connection.db,
			clock: new FakeClock(START),
			registry: registryOf(first.definition)
		});

		expect(warn).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledOnce();
		const url = readDatabaseUrl('TEST_DATABASE_URL');
		const secrets = [url, new URL(url).host, decodeURIComponent(new URL(url).password)].filter(
			(secret) => secret !== ''
		);
		const written = [
			String(warn.mock.calls[0][0]),
			String(error.mock.calls[0][0]),
			String(outcomes[0].error)
		];
		for (const line of written) {
			expect(line).toContain(first.definition.name);
			expect(line).toContain(PERIOD);
			expect(line).toContain('claiming the period');
			expect(line).toContain(`(${SESSION_TERMINATED})`);
			expect(line).not.toContain('insert into');
			expect(line).not.toContain('params');
			for (const secret of secrets) {
				expect(line).not.toContain(secret);
			}
		}
	});

	it('retries a claim whose own connection the server terminated mid-statement, and runs the job exactly once', async () => {
		// A real `57P01` on the claim's own connection. Holding the claim in flight long enough to
		// terminate it takes a second connection with an uncommitted row on the same pair, which the
		// claim's insert waits on inside the unique index; the scheduler's pool has one connection, so
		// its pid is the claim's.
		const first = countingJob('a-terminated-claim');
		const next = countingJob('b-after-terminated-claim');
		const scheduler = connectUnderTest({ max: 1 });
		const schedulerPid = await idleClientPid(scheduler.pool);
		const blocker = await openBlockingClaim(first.definition.name);
		try {
			const incidents: JobIncident[] = [];
			let retried: () => void = () => undefined;
			const retrying = new Promise<void>((resolve) => {
				retried = resolve;
			});

			const tick = runDueJobs({
				db: scheduler.db,
				clock: new FakeClock(START),
				registry: registryOf(first.definition, next.definition),
				onIncident: (reported) => {
					incidents.push(reported);
					if (reported.retrying) {
						retried();
					}
				}
			});
			await waitUntilBlocked(schedulerPid, blocker.pid);
			await terminateBackend(schedulerPid);
			// Either the retry is reported, or the tick ends without one and the assertions below say
			// so, rather than this test waiting for a retry that is never coming.
			await Promise.race([retrying, tick]);
			// The retry is on a new connection and waits on the same row; letting it go is what a
			// second scheduler whose claim did not commit looks like.
			await blocker.rollback();

			expect(outcomesOf(await tick)).toEqual([
				[first.definition.name, JOB_OUTCOME.succeeded],
				[next.definition.name, JOB_OUTCOME.succeeded]
			]);
			expect([first.runs(), next.runs()]).toEqual([1, 1]);
			expect(incidents).toEqual([incident(first.definition.name, JOB_STEP.claim, true)]);
			expect((await runsOf(first.definition.name)).map((run) => run.status)).toEqual([
				JOB_RUN_STATUS.succeeded
			]);
		} finally {
			await blocker.release();
		}
	});
});

/**
 * A second connection holding an uncommitted `running` row for `jobName` in `PERIOD`, which a claim
 * on the same pair waits on in the unique index until it commits or rolls back.
 */
async function openBlockingClaim(jobName: string): Promise<{
	readonly pid: number;
	readonly rollback: () => Promise<void>;
	readonly release: () => Promise<void>;
}> {
	const connection = connectUnderTest();
	const client = await connection.pool.connect();
	const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
	await client.query('BEGIN');
	await client.query(
		`insert into job_runs (job_name, period, status, started_at, lease_expires_at)
		 values ($1, $2, $3, $4, $5)`,
		[
			jobName,
			PERIOD,
			JOB_RUN_STATUS.running,
			new Date(START),
			new Date(Date.parse(START) + DEFAULT_LEASE_MILLISECONDS)
		]
	);
	let released = false;
	return {
		pid: rows[0].pid,
		rollback: async () => {
			await client.query('ROLLBACK');
		},
		release: async () => {
			if (!released) {
				released = true;
				client.release();
			}
		}
	};
}

/**
 * Waits until the backend `pid` is waiting on a lock the backend `blockerPid` holds. Polled, because
 * PostgreSQL announces no event for a statement starting to wait.
 */
async function waitUntilBlocked(pid: number, blockerPid: number): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await testDb.db.execute<{ blocked: boolean }>(
			sql`select ${blockerPid}::int = any(pg_blocking_pids(${pid}::int)) as blocked`
		);
		if (result.rows[0]?.blocked) {
			return;
		}
		await pause(POLL_MILLISECONDS);
	}
	throw new Error(`Backend ${pid} never started waiting on backend ${blockerPid}.`);
}
