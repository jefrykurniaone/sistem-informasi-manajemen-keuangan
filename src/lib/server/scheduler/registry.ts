import type { Database } from '../db';
import type { Clock } from '../ports/clock';

/**
 * What a scheduled job is, and the registry that holds every one of them.
 *
 * Nothing in this file touches the database or the clock: a registry is a map, and a schedule is a
 * pure function from an instant to the period that instant falls in. The lock and the history live
 * in `./lock.ts`, and `./index.ts` is what puts the two together.
 *
 * Decisions settled here:
 *
 * - **A schedule answers "which period is this instant in", not "when do I next fire".** There is
 *   no timer anywhere in this module, and there is no "last fired at" to keep. Running the whole
 *   registry means asking each job for the period the current instant falls in and trying to claim
 *   it; the claim is refused for a period that has already run. A monthly job therefore runs once a
 *   month whether the process ticks once an hour or once a second, and a process that was switched
 *   off for a week runs the job for the period it is in when it comes back rather than replaying
 *   the ones it missed. The alternative — storing the next fire time — is a second piece of state
 *   that can disagree with the history, and it is exactly the state that makes two processes
 *   double-fire.
 * - **A period marker is a string the schedule chooses.** `2026-03` for a monthly job, `2026-03-15`
 *   for a daily one, an ISO instant for a frequent one. The lock only compares markers for
 *   equality, so this stays the schedule's business — see `src/lib/server/db/schema/scheduler.ts`.
 * - **A civil-date schedule takes its time zone as an argument.** "Which month is it" has no answer
 *   without one, and the zone belongs to the complex, not to the clock — `./../ports/clock.ts`
 *   settles that `Clock` answers which *instant* it is and nothing else. A later spec that issues
 *   invoices on the first of the month passes the complex's zone in when it registers its job,
 *   rather than finding one hard-coded here.
 * - **A duplicate job name is refused.** Two jobs under one name would share a lock, so registering
 *   the second one would silently stop either of them from running whenever the other already had
 *   — the precise failure this whole module exists to prevent. It fails at registration instead.
 */

/** How many characters of an ISO date make up `YYYY-MM`. */
const MONTH_MARKER_LENGTH = 'YYYY-MM'.length;

/** How many milliseconds are in a minute. */
const MINUTE_MILLISECONDS = 60 * 1000;

/** When a job runs, expressed as the period any given instant belongs to. */
export interface Schedule {
	/**
	 * How this schedule reads, for a developer: an error message, a log line, a test name. It is
	 * never shown to a resident, so it stays in English like the rest of the identifiers.
	 */
	readonly description: string;

	/**
	 * The marker of the period `instant` falls in. Two instants in the same period must give the
	 * same string, and instants in different periods must give different ones — the lock compares
	 * nothing else.
	 */
	periodFor(instant: Date): string;
}

/** Everything a job's own function is handed when it runs. */
export interface JobContext {
	/** The application database. A job opens its own transactions if it needs them. */
	readonly db: Database;
	/** The clock the run was started with, so a job stamps its rows the way every service does. */
	readonly clock: Clock;
	/** The period this run covers, exactly as the lock holds it. */
	readonly period: string;
	/** The instant this run was claimed at. */
	readonly startedAt: Date;
}

/** One registered job: what it is called, when it runs, and what it does. */
export interface JobDefinition {
	/**
	 * The name the lock is keyed on, together with the period. It is written to `job_runs.job_name`
	 * and shown on the superuser screen, so it is stable: renaming a job makes every period it has
	 * already run for look unrun.
	 */
	readonly name: string;
	readonly schedule: Schedule;
	/**
	 * The work itself. Throwing is how a job reports failure — the scheduler catches it, records it
	 * on the run, and releases the lock so the period can be attempted again.
	 */
	run(context: JobContext): Promise<void>;
}

/**
 * Every job an application knows about.
 *
 * A registry is built and filled at module scope — see `applicationJobs` in `./index.ts` — and read
 * from there by whatever ticks it and by the superuser screen.
 */
export class JobRegistry {
	readonly #jobs = new Map<string, JobDefinition>();

	/**
	 * Adds a job.
	 *
	 * @throws {TypeError} when the name is blank, or when a job of that name is already registered.
	 */
	register(job: JobDefinition): void {
		if (job.name.trim() === '') {
			throw new TypeError('A job needs a name: the lock is keyed on it, together with a period.');
		}
		if (this.#jobs.has(job.name)) {
			throw new TypeError(
				`A job named "${job.name}" is already registered. Two jobs under one name would share one lock, so each would stop the other from running.`
			);
		}
		this.#jobs.set(job.name, job);
	}

	/** The job of that name, or `undefined` when nothing is registered under it. */
	get(name: string): JobDefinition | undefined {
		return this.#jobs.get(name);
	}

	/** Every registered job, by name, so that a screen and a tick both walk them in one order. */
	list(): readonly JobDefinition[] {
		return [...this.#jobs.values()].sort((left, right) => left.name.localeCompare(right.name));
	}
}

/**
 * A job that runs once per calendar month in `timeZone`. Its period marker is `2026-03`.
 *
 * @param timeZone an IANA zone name, for example `Asia/Jakarta`.
 * @throws {RangeError} when the zone is not one this runtime knows, at the moment the schedule is
 *   built rather than the first time the job is due.
 */
export function monthlySchedule(timeZone: string): Schedule {
	const formatter = civilDateFormatter(timeZone);
	return {
		description: `monthly in ${timeZone}`,
		periodFor: (instant) => civilDate(formatter, instant).slice(0, MONTH_MARKER_LENGTH)
	};
}

/**
 * A job that runs once per calendar day in `timeZone`. Its period marker is `2026-03-15`.
 *
 * @param timeZone an IANA zone name, for example `Asia/Jakarta`.
 * @throws {RangeError} when the zone is not one this runtime knows.
 */
export function dailySchedule(timeZone: string): Schedule {
	const formatter = civilDateFormatter(timeZone);
	return {
		description: `daily in ${timeZone}`,
		periodFor: (instant) => civilDate(formatter, instant)
	};
}

/**
 * A job that runs at most once in every window of `minutes` minutes. Its period marker is the
 * instant that window starts at, so no time zone is involved: the windows are counted from the
 * epoch, not from midnight anywhere.
 *
 * @throws {TypeError} when `minutes` is not a whole number of at least one.
 */
export function everyMinutesSchedule(minutes: number): Schedule {
	if (!Number.isInteger(minutes) || minutes < 1) {
		throw new TypeError(
			`A schedule repeats every whole number of minutes, at least one, not ${minutes}.`
		);
	}
	const windowMilliseconds = minutes * MINUTE_MILLISECONDS;
	return {
		description: `every ${minutes} minutes`,
		periodFor: (instant) => {
			const start = Math.floor(instant.getTime() / windowMilliseconds) * windowMilliseconds;
			return new Date(start).toISOString();
		}
	};
}

/** A formatter that renders an instant as a civil date in one zone. */
function civilDateFormatter(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
}

/**
 * `YYYY-MM-DD` for the civil date `instant` falls on, in whichever zone `formatter` was built for.
 * Built from the parts rather than from a formatted string so that the order never depends on the
 * locale.
 */
function civilDate(formatter: Intl.DateTimeFormat, instant: Date): string {
	const parts = formatter.formatToParts(instant);
	const partOfType = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${partOfType('year')}-${partOfType('month')}-${partOfType('day')}`;
}
