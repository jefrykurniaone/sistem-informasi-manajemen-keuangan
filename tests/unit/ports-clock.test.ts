import { describe, expect, it } from 'vitest';
import { systemClock } from '$lib/server/ports/clock';
import { DEFAULT_FAKE_INSTANT, FakeClock } from '$lib/server/ports/fakes';

/** One minute, as the tests below count time. */
const MINUTE = 60 * 1000;

describe('systemClock', () => {
	it('reports the current instant', () => {
		const before = Date.now();
		const now = systemClock.now().getTime();
		expect(now).toBeGreaterThanOrEqual(before);
	});

	it("hands out a fresh Date, so a caller cannot move everyone else's idea of the time", () => {
		const first = systemClock.now();
		first.setFullYear(1999);
		expect(systemClock.now().getFullYear()).toBeGreaterThan(1999);
	});
});

describe('FakeClock', () => {
	it('starts at a fixed instant, so a test reads the same time on every run', () => {
		expect(new FakeClock().now()).toEqual(DEFAULT_FAKE_INSTANT);
	});

	it('starts wherever the test says', () => {
		const clock = new FakeClock('2026-03-17T08:30:00.000Z');
		expect(clock.now().toISOString()).toBe('2026-03-17T08:30:00.000Z');
	});

	it('is moved to an instant by set()', () => {
		const clock = new FakeClock();
		clock.set(new Date('2027-12-31T23:59:59.000Z'));
		expect(clock.now().toISOString()).toBe('2027-12-31T23:59:59.000Z');
	});

	it('goes backwards only through set()', () => {
		const clock = new FakeClock('2026-06-01T00:00:00.000Z');
		clock.set('2026-05-01T00:00:00.000Z');
		expect(clock.now().toISOString()).toBe('2026-05-01T00:00:00.000Z');
	});

	it('is moved forward by advance()', () => {
		const clock = new FakeClock('2026-01-01T00:00:00.000Z');
		clock.advance(90 * MINUTE);
		expect(clock.now().toISOString()).toBe('2026-01-01T01:30:00.000Z');
	});

	it('accumulates several advances', () => {
		const clock = new FakeClock('2026-01-01T00:00:00.000Z');
		clock.advance(MINUTE);
		clock.advance(4 * MINUTE);
		clock.advance(25 * MINUTE);
		expect(clock.now().toISOString()).toBe('2026-01-01T00:30:00.000Z');
	});

	it('accepts an advance of nothing at all', () => {
		const clock = new FakeClock();
		clock.advance(0);
		expect(clock.now()).toEqual(DEFAULT_FAKE_INSTANT);
	});

	it.each([
		{ name: 'a negative number of milliseconds', input: -1 },
		{ name: 'a whole negative minute', input: -MINUTE },
		{ name: 'not a number', input: Number.NaN },
		{ name: 'infinity', input: Number.POSITIVE_INFINITY }
	])('refuses to advance by $name', ({ input }) => {
		// A clock that silently runs backwards turns the failure it causes into a puzzle in
		// another file; a test that meant to go back says so with set().
		expect(() => new FakeClock().advance(input)).toThrow(TypeError);
	});

	it('refuses an instant that is not a date', () => {
		expect(() => new FakeClock('not a date')).toThrow(TypeError);
	});

	it('hands out a fresh Date, so a caller mutating it does not move the clock', () => {
		const clock = new FakeClock('2026-01-01T00:00:00.000Z');
		const now = clock.now();
		now.setFullYear(2030);
		expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
	});
});
