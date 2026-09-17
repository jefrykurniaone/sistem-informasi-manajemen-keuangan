/**
 * `Clock` — the port that tells the application what time it is.
 *
 * Decisions settled here and used by every later spec:
 *
 * 1. **One method, `now()`.** Everything else a caller might want — a deadline, a delay, "the
 *    first day of next month" — is a pure function of an instant, and a pure function is easier
 *    to test than a port method. Growing this interface is how a fake stops being trivial to
 *    write, so it does not grow: a later spec that needs "one month from now" writes that as a
 *    function taking a `Date`, not as a `Clock` method.
 * 2. **A `Date`, not epoch milliseconds.** Drizzle hands back a `Date` for every
 *    `timestamp({ withTimezone: true })` column and takes one on the way in, so a `Date` is what
 *    the surrounding code already holds. Returning a number would put a conversion at every call
 *    site, and a conversion at every call site is a rounding mistake waiting to happen.
 * 3. **An instant, not a civil date.** `now()` answers "which moment is it", never "which day is
 *    it in Jakarta". Those are different questions: the second one needs a time zone, and a time
 *    zone is a property of the complex, not of the clock. A later spec that issues invoices on
 *    the first of the month converts the instant with its own zone-aware helper and must not add
 *    a zone parameter here — otherwise every caller has to know a zone it does not care about.
 * 4. **No sleeping, no timers, no scheduling.** Deciding *when* work runs belongs to the
 *    scheduler; this port only reports the time when asked. A `sleep()` here would be the first
 *    step towards a scheduler hidden inside a fake.
 *
 * The real implementation is `systemClock`. The fake is `FakeClock` in `../ports/fakes.ts`, and
 * it is the only clock a test should use: a test that reads the system clock is a test that
 * behaves differently at midnight and on the last day of a month.
 */

/** The application's source of time. */
export interface Clock {
	/**
	 * The current instant.
	 *
	 * Always a fresh `Date`, so that a caller mutating the value it got back cannot move anyone
	 * else's idea of the time.
	 */
	now(): Date;
}

/** The real clock: the operating system's wall clock. */
export const systemClock: Clock = Object.freeze({
	now: (): Date => new Date()
});
