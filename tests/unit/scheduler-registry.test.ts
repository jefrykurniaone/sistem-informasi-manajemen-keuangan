import { describe, expect, it } from 'vitest';
import { applicationJobs, registerApplicationJobs } from '#lib/server/scheduler/index.ts';
import {
	dailySchedule,
	everyMinutesSchedule,
	JobRegistry,
	monthlySchedule,
	type JobDefinition,
	type Schedule
} from '#lib/server/scheduler/registry.ts';

/**
 * The job registry and the schedules jobs are registered with. Nothing here touches the database or
 * the clock: a schedule is a pure function from an instant to the period marker the lock is keyed
 * on, and this file is where that function is pinned down.
 */

/** The complex's own zone, seven hours ahead of UTC, which is what makes these cases interesting. */
const JAKARTA = 'Asia/Jakarta';

/** A job that does nothing, for tests about registration rather than about running. */
function job(name: string, schedule: Schedule = everyMinutesSchedule(1)): JobDefinition {
	return { name, schedule, run: async () => {} };
}

describe('JobRegistry', () => {
	it('gives back a job it was given, by name', () => {
		const registry = new JobRegistry();
		const registered = job('issue-invoices');

		registry.register(registered);

		expect(registry.get('issue-invoices')).toBe(registered);
	});

	it('knows nothing about a name it was never given', () => {
		const registry = new JobRegistry();

		expect(registry.get('never-registered')).toBeUndefined();
	});

	it('lists every job by name, whatever order they were registered in', () => {
		const registry = new JobRegistry();
		registry.register(job('send-reminders'));
		registry.register(job('drain-email-queue'));
		registry.register(job('issue-invoices'));

		expect(registry.list().map((entry) => entry.name)).toEqual([
			'drain-email-queue',
			'issue-invoices',
			'send-reminders'
		]);
	});

	it('lists nothing at all when nothing is registered', () => {
		expect(new JobRegistry().list()).toEqual([]);
	});

	it('refuses a second job under a name it already holds', () => {
		// Two jobs under one name would share one lock, so whichever ran first would make the other
		// look like an already-completed period and skip it — silently, once a month.
		const registry = new JobRegistry();
		registry.register(job('issue-invoices'));

		expect(() => registry.register(job('issue-invoices'))).toThrow(TypeError);
	});

	it.each(['', '   '])('refuses a job whose name is %p', (name) => {
		const registry = new JobRegistry();

		expect(() => registry.register(job(name))).toThrow(TypeError);
	});
});

describe('monthlySchedule', () => {
	it('marks every instant in one calendar month of its zone with that month', () => {
		const schedule = monthlySchedule(JAKARTA);

		expect(schedule.periodFor(new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-03');
		expect(schedule.periodFor(new Date('2026-03-31T16:59:59.000Z'))).toBe('2026-03');
	});

	it('changes month at the zone it was given, not at UTC midnight', () => {
		// 17:00 UTC on the last day of February is already the first of March in Jakarta, and a job
		// that issues that month's invoices has to agree with the calendar the residents read.
		const jakarta = monthlySchedule(JAKARTA);
		const utc = monthlySchedule('UTC');
		const instant = new Date('2026-02-28T17:30:00.000Z');

		expect(jakarta.periodFor(instant)).toBe('2026-03');
		expect(utc.periodFor(instant)).toBe('2026-02');
	});

	it('refuses a zone this runtime does not know, when the schedule is built', () => {
		expect(() => monthlySchedule('Mars/Olympus_Mons')).toThrow(RangeError);
	});
});

describe('dailySchedule', () => {
	it('marks every instant in one calendar day of its zone with that day', () => {
		const schedule = dailySchedule(JAKARTA);

		expect(schedule.periodFor(new Date('2026-03-15T00:00:00.000Z'))).toBe('2026-03-15');
		expect(schedule.periodFor(new Date('2026-03-15T16:59:00.000Z'))).toBe('2026-03-15');
	});

	it('changes day at the zone it was given, not at UTC midnight', () => {
		const schedule = dailySchedule(JAKARTA);

		expect(schedule.periodFor(new Date('2026-03-15T17:00:00.000Z'))).toBe('2026-03-16');
	});

	it('refuses a zone this runtime does not know, when the schedule is built', () => {
		expect(() => dailySchedule('Mars/Olympus_Mons')).toThrow(RangeError);
	});
});

describe('everyMinutesSchedule', () => {
	it('marks every instant in one window with the instant that window started at', () => {
		const schedule = everyMinutesSchedule(5);

		expect(schedule.periodFor(new Date('2026-03-15T07:30:00.000Z'))).toBe(
			'2026-03-15T07:30:00.000Z'
		);
		expect(schedule.periodFor(new Date('2026-03-15T07:34:59.999Z'))).toBe(
			'2026-03-15T07:30:00.000Z'
		);
	});

	it('marks the next window differently, so the job may run again', () => {
		const schedule = everyMinutesSchedule(5);

		expect(schedule.periodFor(new Date('2026-03-15T07:35:00.000Z'))).toBe(
			'2026-03-15T07:35:00.000Z'
		);
	});

	it.each([0, -1, 1.5, Number.NaN])('refuses %p as a number of minutes', (minutes) => {
		expect(() => everyMinutesSchedule(minutes)).toThrow(TypeError);
	});
});

describe('a schedule reading its own period markers back', () => {
	it.each([
		['a month, in Indonesian', monthlySchedule(JAKARTA), '2026-09', 'id', 'September 2026'],
		['a month, in English', monthlySchedule(JAKARTA), '2026-09', 'en', 'September 2026'],
		['a day, as its WIB date', dailySchedule(JAKARTA), '2026-09-24', 'en', '24 Sep 2026'],
		[
			'a window of minutes, as its WIB date and time',
			everyMinutesSchedule(1),
			'2026-09-24T07:36:00.000Z',
			'id',
			'24 Sep 2026, 14.36 WIB'
		],
		[
			'a window that is not an instant, as it is',
			everyMinutesSchedule(1),
			'not-an-instant',
			'id',
			'not-an-instant'
		]
	] as const)('reads %s', (_label, schedule, period, locale, expected) => {
		expect(schedule.formatPeriod?.(period, locale)).toBe(expected);
	});
});

describe('src/hooks.server.ts', () => {
	it('registers exactly the jobs registerApplicationJobs composes, and nothing else does', async () => {
		// Nothing in this file composes `applicationJobs`, so it is empty until the hooks module runs.
		// Importing it under Vitest starts no timer: `isSchedulerProcess` is false here.
		expect(applicationJobs.list()).toEqual([]);

		await import('../../src/hooks.server');

		const composed = new JobRegistry();
		registerApplicationJobs(composed);
		expect(applicationJobs.list().map((entry) => entry.name)).toEqual(
			composed.list().map((entry) => entry.name)
		);
		expect(applicationJobs.list()).toHaveLength(4);
	});
});

describe('every schedule', () => {
	it.each([
		{ schedule: monthlySchedule(JAKARTA) },
		{ schedule: dailySchedule(JAKARTA) },
		{ schedule: everyMinutesSchedule(1) }
	])('describes itself for a developer reading a log or a test name', ({ schedule }) => {
		expect(schedule.description).not.toBe('');
	});
});
