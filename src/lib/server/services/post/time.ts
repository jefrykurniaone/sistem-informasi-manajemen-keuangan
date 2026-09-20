import { COMPLEX_TIME_ZONE } from '$lib/time';

/**
 * Turns what `date-time-fields.svelte` posts — a `YYYY-MM-DD` date box and an `HH:mm` time box —
 * into the instant they mean, always read as wall-clock time in `COMPLEX_TIME_ZONE`.
 *
 * `docs/spec-post-editor-v1.md` settles that a kegiatan's start and end are entered as WIB wall-clock
 * time regardless of the browser's locale or the server's own zone, and that `19:00` typed into the
 * time box is always seven in the evening WIB — never the server's local time, and never shifted by
 * whatever the visiting browser's `Intl` would guess. This module is where that reading happens.
 *
 * `date-time-fields.svelte`'s own `pattern` — `([01][0-9]|2[0-3]):[0-5][0-9]` — is the one true
 * definition of a valid time box, and `TIME_PATTERN` below is the same regular expression, so a value
 * the client's own `pattern` attribute would already refuse is refused again here rather than trusted
 * because it happened to arrive as a POST body.
 */

/** `YYYY-MM-DD`, the shape `<input type="date">` posts. No calendar validity check beyond the shape —
 *  a native date picker never hands back a day that does not exist. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:mm`, twenty-four hour, matching `date-time-fields.svelte`'s own `pattern` exactly. */
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * `date` and `time` as the instant they mean in `COMPLEX_TIME_ZONE`, or `null` when both are empty —
 * the shape a pengumuman's four event-time fields arrive in, or a kegiatan whose end was left open.
 *
 * @throws {RangeError} when exactly one of `date` and `time` is empty, or either is filled but does
 *   not match its shape — `24:00`, `7pm`, `19:60` and `9:00` (no leading zero) are all refused here
 *   the same way they are refused by the time box's own `pattern` before a browser ever submits them.
 */
export function combineCivilDateTime(date: string, time: string): Date | null {
	if (date === '' && time === '') {
		return null;
	}
	if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) {
		throw new RangeError(
			`"${date}" and "${time}" together are not a valid "YYYY-MM-DD" date and a 24-hour "HH:mm" time.`
		);
	}
	return zonedCivilDateTimeToInstant(date, time, COMPLEX_TIME_ZONE);
}

/**
 * `date` and `time`, read as wall-clock time in `timeZone`, as the UTC instant that reading means.
 *
 * Generic over the zone through `Intl.DateTimeFormat`, never a fixed `+07:00` offset:
 * `combineCivilDateTime` always calls this with `COMPLEX_TIME_ZONE`, but the arithmetic itself does
 * not know that constant exists, so a complex that turned out to sit in WITA or WIT would need only a
 * different zone name here, not a different formula.
 *
 * The method is the standard one for turning a civil (zone-local) date and time into an instant with
 * nothing but `Intl`: treat the wall-clock digits as if they were already UTC to get a first guess,
 * read what that guessed instant prints as inside `timeZone`, and correct the guess by the difference.
 * `COMPLEX_TIME_ZONE` (`Asia/Jakarta`) has never observed daylight saving, so that single correction is
 * exact for every instant this application ever combines — a zone that does observe DST could in
 * principle need a second pass right at a transition, which this function never has to reason about
 * because the one zone it is actually called with has none.
 */
function zonedCivilDateTimeToInstant(date: string, time: string, timeZone: string): Date {
	const [year, month, day] = date.split('-').map(Number);
	const [hour, minute] = time.split(':').map(Number);

	const guess = Date.UTC(year, month - 1, day, hour, minute);
	const offsetMinutes = offsetMinutesAt(new Date(guess), timeZone);
	return new Date(guess - offsetMinutes * 60_000);
}

/**
 * `timeZone`'s offset from UTC at `instant`, in minutes, positive east of Greenwich — matching
 * `Date.getTimezoneOffset`'s sign convention flipped, which is what makes `guess - offset` in
 * `zonedCivilDateTimeToInstant` read as "subtract how far ahead of UTC the zone is".
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(instant);
	const partOfType = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '0';

	const printedAsUtc = Date.UTC(
		Number(partOfType('year')),
		Number(partOfType('month')) - 1,
		Number(partOfType('day')),
		Number(partOfType('hour')),
		Number(partOfType('minute')),
		Number(partOfType('second'))
	);
	return (printedAsUtc - instant.getTime()) / 60_000;
}
