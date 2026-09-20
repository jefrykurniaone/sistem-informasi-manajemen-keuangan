import { describe, expect, it } from 'vitest';
import { combineCivilDateTime } from '$lib/server/services/post/time';

/**
 * `combineCivilDateTime` reads a `date-time-fields.svelte` date box and time box as WIB wall-clock
 * time, whatever the runtime's own zone is — `src/lib/server/services/post/time.ts`'s doc comment
 * records the argument. The two combining cases below are chosen the same way
 * `tests/unit/time.test.ts` chooses its fixed instants: one where the WIB day is the same as the UTC
 * day, and one where WIB midnight is still the previous day in UTC.
 */

describe('combineCivilDateTime', () => {
	it('reads 19:00 WIB as the UTC instant seven hours earlier, same day', () => {
		expect(combineCivilDateTime('2026-09-20', '19:00')).toEqual(
			new Date('2026-09-20T12:00:00.000Z')
		);
	});

	it('reads WIB midnight as the previous evening in UTC', () => {
		expect(combineCivilDateTime('2026-01-01', '00:00')).toEqual(
			new Date('2025-12-31T17:00:00.000Z')
		);
	});

	it('returns null when both the date and the time are empty', () => {
		expect(combineCivilDateTime('', '')).toBeNull();
	});

	it.each([
		{ name: 'midnight written as 24:00', date: '2026-09-20', time: '24:00' },
		{ name: 'a 12-hour clock with an am/pm marker', date: '2026-09-20', time: '7pm' },
		{ name: 'a minute past 59', date: '2026-09-20', time: '19:60' },
		{ name: 'an hour with no leading zero', date: '2026-09-20', time: '9:00' },
		{ name: 'a date filled in with no time', date: '2026-09-20', time: '' }
	])('rejects $name', ({ date, time }) => {
		expect(() => combineCivilDateTime(date, time)).toThrow(RangeError);
	});
});
