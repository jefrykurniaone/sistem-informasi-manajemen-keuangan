import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { jobRuns, JOB_RUN_STATUS, type JobRun } from '$lib/server/db/schema/scheduler';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	BACKOFF_DELAY_FACTOR,
	BACKOFF_FIRST_DELAY_MILLISECONDS,
	BACKOFF_MAXIMUM_DELAY_MILLISECONDS,
	backoffDelayMilliseconds,
	isFailureNamed,
	JobRegistry,
	JOB_OUTCOME,
	listJobsWithLastRun,
	monthlySchedule,
	runDueJobs,
	runJob,
	triggerJob,
	type JobDefinition,
	type JobIncident,
	type JobOutcome,
	type Schedule
} from '$lib/server/scheduler';
import { COMPLEX_TIME_ZONE } from '$lib/time';
import { invoiceIssuanceJob } from '$lib/server/services/dues/jobs';
import { _describeRunError, _formatPeriod } from '../../src/routes/(app)/admin/jobs/+page.server';

/**
 * Ticket #218: a tick backs off a (job, period) pair that keeps failing, by 1, 5 and 25 minutes and
 * then 60, while "Jalankan sekarang" still runs at once, a new period is tried at once, and the
 * superuser screen says how often the pair failed and when it is tried next. Plus the one failure
 * that screen explains in its own words, a missing Tarif.
 *
 * Against a real PostgreSQL through the same seam as `tests/unit/scheduler-jobs.test.ts`: a fake
 * clock that the test moves, and `runDueJobs`, which is exactly one tick of the periodic trigger.
 * The pause is read from `job_runs`, so only the rows the tick really wrote can prove it.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at, unless a test is about a month boundary. */
const START = '2026-01-01T00:00:00.000Z';

/** One minute, the unit the backoff is counted in. */
const MINUTE = 60 * 1000;

/** How often the production trigger ticks. The tests tick at least this often. */
const TICK = 30 * 1000;

/** What a job made to fail throws. */
const FAILURE_MESSAGE = 'this job always throws';

/** The instant `minutes` minutes after `START`. */
function afterStart(minutes: number): Date {
	return new Date(Date.parse(START) + minutes * MINUTE);
}

/** A schedule that puts every instant in one period. */
function fixedSchedule(period: string): Schedule {
	return { description: `fixed at ${period}`, periodFor: () => period };
}

/** A schedule whose period the test moves by hand. */
function movableSchedule(first: string): { schedule: Schedule; moveTo: (period: string) => void } {
	let current = first;
	return {
		schedule: { description: 'moved by the test', periodFor: () => current },
		moveTo: (period) => {
			current = period;
		}
	};
}

/**
 * A schedule that answers a period nobody has used before every time it is asked, so that its job
 * runs on every tick and a test can count ticks by it.
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

/**
 * A job that records the instant of every run, and throws on every run until it is told to stop,
 * or for as many runs as `failures` says.
 */
function recordingJob(
	name: string,
	schedule: Schedule,
	failures = Number.POSITIVE_INFINITY
): { definition: JobDefinition; ranAt: Date[] } {
	const ranAt: Date[] = [];
	return {
		ranAt,
		definition: {
			name,
			schedule,
			run: async ({ clock }) => {
				ranAt.push(clock.now());
				if (ranAt.length <= failures) {
					throw new Error(FAILURE_MESSAGE);
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

/** One tick of `registry` at the clock's current instant, failing the test on any incident. */
async function tick(clock: FakeClock, registry: JobRegistry): Promise<readonly JobOutcome[]> {
	const incidents: JobIncident[] = [];
	const outcomes = await runDueJobs({
		db: testDb.db,
		clock,
		registry,
		onIncident: (incident) => incidents.push(incident)
	});
	expect(incidents).toEqual([]);
	return outcomes;
}

/** The one outcome of a tick of a registry holding one job. */
async function tickOne(clock: FakeClock, registry: JobRegistry): Promise<JobOutcome> {
	const [outcome] = await tick(clock, registry);
	return outcome;
}

/** Minutes since `START`, for comparing run instants in the unit the backoff is written in. */
function minutesSinceStart(instant: Date): number {
	return (instant.getTime() - Date.parse(START)) / MINUTE;
}

/** Every run of one job, oldest first. */
async function runsOf(jobName: string): Promise<JobRun[]> {
	return testDb.db
		.select()
		.from(jobRuns)
		.where(eq(jobRuns.jobName, jobName))
		.orderBy(asc(jobRuns.startedAt), asc(jobRuns.id));
}

/** A superuser, for the calls `ACTION.manageJobs` guards. */
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

describe('the backoff delay', () => {
	it('is 1, 5 and 25 minutes, then 60 minutes for every failure after that', () => {
		expect(BACKOFF_FIRST_DELAY_MILLISECONDS).toBe(MINUTE);
		expect(BACKOFF_DELAY_FACTOR).toBe(5);
		expect(BACKOFF_MAXIMUM_DELAY_MILLISECONDS).toBe(60 * MINUTE);
		expect([1, 2, 3, 4, 5, 6, 100].map((n) => backoffDelayMilliseconds(n) / MINUTE)).toEqual([
			1, 5, 25, 60, 60, 60, 60
		]);
	});
});

describe('a tick, for a job that keeps failing for one period', () => {
	it('tries again exactly 1, 5, 25, 60 and 60 minutes after the failure before, never in between', async () => {
		const job = recordingJob('backoff-steady', fixedSchedule('backoff-steady-period'));
		const registry = registryOf(job.definition);
		const clock = new FakeClock(START);
		// The due instants the backoff promises, and the millisecond before each: the tick has to be
		// paused at the one and run at the other, which a thirty-second grid alone would not show.
		const dueMinutes = [0, 1, 6, 31, 91, 151];
		const instants = new Set<number>();
		for (let minutes = 0; minutes <= 211; minutes += TICK / MINUTE) {
			instants.add(afterStart(minutes).getTime());
		}
		for (const due of dueMinutes.slice(1)) {
			instants.add(afterStart(due).getTime() - 1);
		}

		const paused: JobOutcome[] = [];
		for (const instant of [...instants].sort((left, right) => left - right)) {
			clock.set(new Date(instant));
			const outcome = await tickOne(clock, registry);
			if (outcome.outcome === JOB_OUTCOME.paused) {
				paused.push(outcome);
			} else {
				expect(outcome).toMatchObject({ outcome: JOB_OUTCOME.failed, error: FAILURE_MESSAGE });
			}
		}

		// 211 is 151 plus the sixty minutes of the sixth failure: the seventh run happens exactly there.
		expect(job.ranAt.map(minutesSinceStart)).toEqual([...dueMinutes, 211]);
		// Every tick that did not run was paused, and said until when.
		expect(paused.length).toBe(instants.size - job.ranAt.length);
		for (const due of dueMinutes.slice(1)) {
			const justBefore = paused.find((outcome) => {
				return outcome.retryAt?.getTime() === afterStart(due).getTime();
			});
			expect(justBefore).toBeDefined();
		}
		// A paused tick writes nothing: one row per run, all of them failed.
		const rows = await runsOf(job.definition.name);
		expect(rows).toHaveLength(job.ranAt.length);
		expect(new Set(rows.map((row) => row.status))).toEqual(new Set([JOB_RUN_STATUS.failed]));
	});

	it('runs at once when a superuser presses Jalankan sekarang during the pause, and counts that failure', async () => {
		const superuserId = await insertSuperuser('Pengurus Jeda Pekerjaan');
		const job = recordingJob('backoff-manual', fixedSchedule('backoff-manual-period'));
		const registry = registryOf(job.definition);
		const clock = new FakeClock(START);
		expect((await tickOne(clock, registry)).outcome).toBe(JOB_OUTCOME.failed);

		clock.set(afterStart(0.5));
		expect(await tickOne(clock, registry)).toMatchObject({
			outcome: JOB_OUTCOME.paused,
			retryAt: afterStart(1)
		});

		const manual = await triggerJob({
			db: testDb.db,
			clock,
			registry,
			actorId: superuserId,
			jobName: job.definition.name
		});

		expect(manual).toMatchObject({ outcome: JOB_OUTCOME.failed, error: FAILURE_MESSAGE });
		expect(job.ranAt.map(minutesSinceStart)).toEqual([0, 0.5]);
		// That was the second failure, so the tick now waits five minutes from it, not one from the
		// first.
		clock.set(afterStart(5.5 - 1 / MINUTE));
		expect(await tickOne(clock, registry)).toMatchObject({
			outcome: JOB_OUTCOME.paused,
			retryAt: afterStart(5.5)
		});
		clock.set(afterStart(5.5));
		expect((await tickOne(clock, registry)).outcome).toBe(JOB_OUTCOME.failed);
		expect(job.ranAt).toHaveLength(3);
	});

	it('tries a new period at once, whatever the period before it is waiting out', async () => {
		// 23:59:30 on 31 August in Jakarta, then midnight: the monthly period turns while August is
		// still paused, and September's first tick must not inherit that pause.
		const job = recordingJob('backoff-new-period', monthlySchedule(COMPLEX_TIME_ZONE));
		const registry = registryOf(job.definition);
		const clock = new FakeClock('2026-08-31T16:59:30.000Z');

		expect(await tickOne(clock, registry)).toMatchObject({
			period: '2026-08',
			outcome: JOB_OUTCOME.failed
		});
		clock.set('2026-08-31T16:59:45.000Z');
		expect(await tickOne(clock, registry)).toMatchObject({
			period: '2026-08',
			outcome: JOB_OUTCOME.paused
		});
		clock.set('2026-08-31T17:00:00.000Z');
		expect(await tickOne(clock, registry)).toMatchObject({
			period: '2026-09',
			outcome: JOB_OUTCOME.failed
		});
		expect(job.ranAt).toHaveLength(2);
	});

	it('does not hold back another job in the same tick', async () => {
		// Named so that the paused job comes first in the tick and the other one after it.
		const paused = recordingJob('backoff-a-paused', fixedSchedule('backoff-a-period'));
		const other = recordingJob('backoff-b-other', everyTickSchedule('backoff-b'), 0);
		const registry = registryOf(paused.definition, other.definition);
		const clock = new FakeClock(START);

		const first = await tick(clock, registry);
		clock.set(afterStart(0.5));
		const second = await tick(clock, registry);

		expect(first.map((outcome) => outcome.outcome)).toEqual([
			JOB_OUTCOME.failed,
			JOB_OUTCOME.succeeded
		]);
		expect(second.map((outcome) => outcome.outcome)).toEqual([
			JOB_OUTCOME.paused,
			JOB_OUTCOME.succeeded
		]);
		expect(other.ranAt).toHaveLength(2);
	});

	it('never tries a period again once it has succeeded, as before', async () => {
		const job = recordingJob('backoff-then-succeeds', fixedSchedule('backoff-succeeds'), 1);
		const registry = registryOf(job.definition);
		const clock = new FakeClock(START);

		expect((await tickOne(clock, registry)).outcome).toBe(JOB_OUTCOME.failed);
		clock.set(afterStart(1));
		expect((await tickOne(clock, registry)).outcome).toBe(JOB_OUTCOME.succeeded);
		for (const minutes of [1.5, 2, 30, 61, 600]) {
			clock.set(afterStart(minutes));
			expect((await tickOne(clock, registry)).outcome).toBe(JOB_OUTCOME.skipped);
		}

		expect(job.ranAt).toHaveLength(2);
	});
});

describe('the superuser screen, through listJobsWithLastRun', () => {
	it('says how often the current period failed and when a tick tries it next', async () => {
		const superuserId = await insertSuperuser('Pengurus Hitung Kegagalan');
		const movable = movableSchedule('backoff-listed-old');
		const job = recordingJob('backoff-listed', movable.schedule);
		const registry = registryOf(job.definition);
		const clock = new FakeClock(START);
		const list = async (): Promise<{ failures: number; next: Date | undefined }> => {
			const [summary] = await listJobsWithLastRun({
				db: testDb.db,
				clock,
				registry,
				actorId: superuserId
			});
			return { failures: summary.failuresInCurrentPeriod, next: summary.nextAttemptAt };
		};

		// Two failures of an earlier period, which the current one must not count.
		await runJob({ db: testDb.db, clock, job: job.definition });
		clock.set(afterStart(1));
		await runJob({ db: testDb.db, clock, job: job.definition });
		movable.moveTo('backoff-listed-now');
		expect(await list()).toEqual({ failures: 0, next: undefined });

		// Three failures of the current period through the tick, at 2, 3 and 8 minutes.
		for (const minutes of [2, 3, 8]) {
			clock.set(afterStart(minutes));
			expect((await tickOne(clock, registry)).outcome).toBe(JOB_OUTCOME.failed);
		}
		clock.set(afterStart(8.5));
		expect(await list()).toEqual({ failures: 3, next: afterStart(33) });

		// Once the pause has passed, nothing is waited for, and the count stays.
		clock.set(afterStart(33));
		expect(await list()).toEqual({ failures: 3, next: undefined });

		// Pressed by hand six more times: the count keeps going, and the wait stays at sixty minutes.
		for (const seconds of [1, 2, 3, 4, 5, 6]) {
			clock.set(new Date(afterStart(33).getTime() + seconds * 1000));
			await runJob({ db: testDb.db, clock, job: job.definition });
		}
		expect(await list()).toEqual({
			failures: 9,
			next: new Date(afterStart(33).getTime() + 6 * 1000 + 60 * MINUTE)
		});
	});

	it('says nothing is waited for by a job that never ran', async () => {
		const superuserId = await insertSuperuser('Pengurus Pekerjaan Baru');
		const job = recordingJob('backoff-never-ran', fixedSchedule('backoff-never'));

		const [summary] = await listJobsWithLastRun({
			db: testDb.db,
			clock: new FakeClock(START),
			registry: registryOf(job.definition),
			actorId: superuserId
		});

		expect(summary).toMatchObject({ failuresInCurrentPeriod: 0, nextAttemptAt: undefined });
	});
});

describe('a missing Tarif, as /admin/jobs explains it', () => {
	it('is recognised on the run the real issuance job records, and read as a sentence in id and en', async () => {
		await testDb.db
			.insert(units)
			.values({ block: 'JEDA', number: '1', isActive: true, createdAt: new Date(START) });
		// 10:00 on 1 September in Jakarta, with no Tarif in `dues_rates` at all.
		const clock = new FakeClock('2026-09-01T03:00:00.000Z');

		const outcome = await runJob({
			db: testDb.db,
			clock,
			job: invoiceIssuanceJob({ report: () => undefined })
		});

		expect(outcome).toMatchObject({ period: '2026-09', outcome: JOB_OUTCOME.failed });
		const [row] = (await runsOf(outcome.jobName)).filter((run) => run.period === '2026-09');
		expect(isFailureNamed(row.error, 'NoDuesRateError')).toBe(true);
		expect(_describeRunError(row.error, row.period, 'id')).toBe(
			'Belum ada Tarif yang berlaku pada 1 September 2026, jadi Tagihan September 2026 belum terbit. Isi Tarif, lalu Jalankan sekarang.'
		);
		expect(_describeRunError(row.error, row.period, 'en')).toBe(
			'No dues rate is in force on 1 September 2026, so the invoices for September 2026 have not been issued. Set a dues rate, then press Run now.'
		);
	});

	it.each([
		['a failure that was a plain Error', FAILURE_MESSAGE],
		[
			'a Tarif failure recorded before ticket #218, with no name in front',
			'No dues rate is in force on 2026-09-01, so no invoice was issued for period 2026-09.'
		],
		['a failure of some other named error', 'TypeError: something else went wrong']
	])('shows %s as the text that was recorded', (_label, error) => {
		expect(_describeRunError(error, '2026-09', 'id')).toBe(error);
		expect(_describeRunError(error, '2026-09', 'en')).toBe(error);
	});

	it('shows no message for a run that has none', () => {
		expect(_describeRunError(null, '2026-09', 'id')).toBeUndefined();
	});
});

describe('a period marker, as /admin/jobs shows it', () => {
	/** What the page must never show: a raw ISO instant. */
	const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:/;

	it.each([
		['a month, in Indonesian', '2026-09', 'id', 'September 2026'],
		['a month, in English', '2026-09', 'en', 'September 2026'],
		['a day, as its WIB date', '2026-09-24', 'id', '24 Sep 2026'],
		[
			'a window of minutes, as its WIB date and time',
			'2026-09-24T07:36:00.000Z',
			'en',
			'24 Sep 2026, 14.36 WIB'
		],
		[
			'the daily prune window, which starts at 07:00 WIB',
			'2026-09-24T00:00:00.000Z',
			'id',
			'24 Sep 2026, 07.00 WIB'
		]
	] as const)('reads %s', (_label, period, locale, expected) => {
		const formatted = _formatPeriod(period, locale);

		expect(formatted).toBe(expected);
		expect(formatted).not.toMatch(ISO_INSTANT);
	});
});
