import { describe, expect, it } from 'vitest';
import {
	civilDayOf,
	civilMonthOf,
	COMPLEX_TIME_ZONE,
	formatDateTime,
	formatDay,
	formatMonthLabel,
	formatTime
} from '$lib/time';

/**
 * The complex's calendar. Every instant below is chosen to sit on a different side of midnight
 * in WIB than in UTC, so that a formatter which quietly fell back to UTC — the mistake this module
 * exists to end — fails here rather than on a screen.
 *
 * The exact strings are what the ICU data in Node and Bun print today. A runtime built with
 * `small-icu` would print `GMT+7` instead of `WIB`, and that is exactly the failure worth knowing
 * about (`docs/research-ui-ux-v1.md` §8).
 */

/** 21 Sep 2026, 00.30 WIB — still the twentieth in UTC. */
const PAST_WIB_MIDNIGHT = '2026-09-20T17:30:00Z';

/** 20 Sep 2026, 23.59.59 WIB — the last second before the day turns in the complex. */
const BEFORE_WIB_MIDNIGHT = '2026-09-20T16:59:59Z';

/** 20 Sep 2026, 10.30 WIB — the fixed date `docs/research-ui-ux-v1.md` §8 verified against. */
const MID_MORNING = '2026-09-20T03:30:00Z';

describe('COMPLEX_TIME_ZONE', () => {
	it('is the IANA name of the zone, not an offset', () => {
		expect(COMPLEX_TIME_ZONE).toBe('Asia/Jakarta');
	});
});

describe('civilDayOf', () => {
	it.each([
		{
			name: 'after WIB midnight and before UTC midnight',
			instant: PAST_WIB_MIDNIGHT,
			day: '2026-09-21'
		},
		{ name: 'one second before WIB midnight', instant: BEFORE_WIB_MIDNIGHT, day: '2026-09-20' },
		{ name: 'mid-morning, the same day in both zones', instant: MID_MORNING, day: '2026-09-20' },
		{
			name: 'the first instant of a new year in WIB',
			instant: '2026-12-31T17:00:00Z',
			day: '2027-01-01'
		}
	])('reads $name as the WIB day $day', ({ instant, day }) => {
		expect(civilDayOf(new Date(instant))).toBe(day);
	});
});

describe('civilMonthOf', () => {
	it.each([
		{
			name: 'one second before the WIB month turns',
			instant: '2026-08-31T16:59:59Z',
			month: '2026-08'
		},
		{
			name: 'the first instant of the WIB month',
			instant: '2026-08-31T17:00:00Z',
			month: '2026-09'
		},
		{
			name: 'the first instant of a new year in WIB',
			instant: '2026-12-31T17:00:00Z',
			month: '2027-01'
		}
	])('reads $name as the WIB month $month', ({ instant, month }) => {
		expect(civilMonthOf(new Date(instant))).toBe(month);
	});
});

describe('formatTime', () => {
	it.each([
		{ instant: PAST_WIB_MIDNIGHT, output: '00.30 WIB' },
		{ instant: BEFORE_WIB_MIDNIGHT, output: '23.59 WIB' },
		{ instant: MID_MORNING, output: '10.30 WIB' },
		{ instant: '2026-09-20T05:05:00Z', output: '12.05 WIB' }
	])('prints $instant as $output, twenty-four hour and labelled', ({ instant, output }) => {
		expect(formatTime(new Date(instant))).toBe(output);
	});
});

describe('formatDay', () => {
	it.each([
		{ instant: PAST_WIB_MIDNIGHT, output: '21 Sep 2026' },
		{ instant: MID_MORNING, output: '20 Sep 2026' },
		{ instant: '2026-09-05T03:00:00Z', output: '5 Sep 2026' },
		{ instant: '2026-05-20T05:05:00Z', output: '20 Mei 2026' }
	])('prints $instant as the WIB day $output', ({ instant, output }) => {
		expect(formatDay(new Date(instant))).toBe(output);
	});
});

describe('formatDateTime', () => {
	it.each([
		{ instant: MID_MORNING, output: '20 Sep 2026, 10.30 WIB' },
		{ instant: PAST_WIB_MIDNIGHT, output: '21 Sep 2026, 00.30 WIB' }
	])('prints $instant as $output', ({ instant, output }) => {
		expect(formatDateTime(new Date(instant))).toBe(output);
	});

	it('labels the zone WIB, never GMT+7, whatever the interface language', () => {
		const output = formatDateTime(new Date(MID_MORNING));
		expect(output).toContain('WIB');
		expect(output).not.toContain('GMT');
	});
});

describe('formatMonthLabel', () => {
	it.each([
		{ period: '2026-09', locale: 'id' as const, output: 'September 2026' },
		{ period: '2026-09', locale: 'en' as const, output: 'September 2026' },
		{ period: '2026-05', locale: 'id' as const, output: 'Mei 2026' },
		{ period: '2026-05', locale: 'en' as const, output: 'May 2026' },
		{ period: '2026-01', locale: 'id' as const, output: 'Januari 2026' },
		{ period: '2026-01', locale: 'en' as const, output: 'January 2026' }
	])('reads $period in locale $locale as $output', ({ period, locale, output }) => {
		expect(formatMonthLabel(period, locale)).toBe(output);
	});
});

describe('an invalid date', () => {
	it.each([
		{ name: 'formatDay', format: formatDay },
		{ name: 'formatDateTime', format: formatDateTime },
		{ name: 'formatTime', format: formatTime },
		{ name: 'civilDayOf', format: civilDayOf },
		{ name: 'civilMonthOf', format: civilMonthOf }
	])('is refused by $name rather than printed', ({ format }) => {
		// An invalid instant rendered as text would be a silent lie on a financial screen.
		expect(() => format(new Date(Number.NaN))).toThrow(RangeError);
	});
});
