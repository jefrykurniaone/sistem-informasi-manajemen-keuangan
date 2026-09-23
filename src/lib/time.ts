/**
 * The complex's calendar: one time zone, and the formatters that print an instant in it.
 *
 * Every timestamp the application stores is an instant (a `Date`, UTC in the database). Which
 * *day* or *month* that instant falls on, and how it reads on a screen, is a question about a
 * place, and the place is the housing complex. Before this module each screen answered it for
 * itself with its own `Intl.DateTimeFormat`, and three of them answered "UTC"; the service layer
 * answered `Asia/Jakarta` from three separate copies of the same `formatToParts` helper.
 * `docs/spec-waktu-rupiah-v1.md` settles it once, here.
 *
 * Decisions settled here and followed by every later spec:
 *
 * 1. **`COMPLEX_TIME_ZONE` lives here** and nowhere else. `src/lib/server/services/dues/issuance.ts`
 *    re-exports it under the same name so that its existing callers keep compiling; a new caller
 *    imports it from `$lib/time`.
 * 2. **The formatting locale is `id-ID`, whatever the interface language.** The label the spec
 *    wants on every clock time is `WIB`, and only the Indonesian locale prints it —
 *    `en-US` prints `GMT+7` for the same zone (`docs/research-ui-ux-v1.md` §8). Paraglide still
 *    chooses the language of the words around the time; it never chooses this locale.
 * 3. **The label is never assembled by string concatenation.** `timeZoneName: 'short'` produces
 *    `WIB` from the zone itself, so a complex that turns out to sit in WITA or WIT changes the
 *    constant and every label follows.
 * 4. **Component options, never `dateStyle`/`timeStyle`.** ICU throws `TypeError` when
 *    `dateStyle` is combined with `timeZoneName`, and `formatDay` uses the same day components as
 *    `formatDateTime` so the two agree on how a date reads.
 * 5. **No imports.** This module is read by Svelte components, by `scripts/*.ts` run under plain
 *    `bun run` with no Vite and no `$app`, and by the server; it depends on `Intl` alone.
 *
 * What the output looks like (from the ICU data Node and Bun ship on this machine, locked by
 * `tests/unit/time.test.ts`):
 *
 * | Function            | `2026-09-20T03:30:00Z` reads as |
 * |---------------------|---------------------------------|
 * | `formatDay`         | `20 Sep 2026`                   |
 * | `formatTime`        | `10.30 WIB`                     |
 * | `formatDateTime`    | `20 Sep 2026, 10.30 WIB`        |
 * | `civilDayOf`        | `2026-09-20`                    |
 * | `civilMonthOf`      | `2026-09`                       |
 *
 * `id-ID` separates hours and minutes with a full stop, not a colon; that is the locale's own
 * convention and is left alone. The `YYYY-MM-DD` and `YYYY-MM` strings are the vocabulary the
 * occupancy, dues and report services already compare against, and they sort correctly as plain
 * strings.
 *
 * Every function takes a `Date` and throws `RangeError` for an invalid one, as `Intl` itself
 * does: an invalid instant printed as text would be a silent lie on a financial screen.
 */

/**
 * The IANA time zone the complex keeps its calendar in. Every calendar day, month and displayed
 * clock time in the application is read in this zone.
 *
 * `Asia/Jakarta` rather than a fixed `+07:00` offset, so the runtime's own tz database answers the
 * question. The zone has no daylight saving and has not changed offset in living memory, so every
 * `YYYY-MM` this module produces marks exactly one stretch of instants, with no hour that belongs
 * to two months and none that belongs to neither.
 */
export const COMPLEX_TIME_ZONE = 'Asia/Jakarta';

/**
 * The locale every human-readable time is printed in. Locked to Indonesian regardless of the
 * interface language, because it is what makes `timeZoneName: 'short'` print `WIB`.
 */
const FORMAT_LOCALE = 'id-ID';

/** The calendar-day components: `20 Sep 2026`. Shared by `formatDay` and `formatDateTime`. */
const DAY_OPTIONS = {
	timeZone: COMPLEX_TIME_ZONE,
	day: 'numeric',
	month: 'short',
	year: 'numeric'
} as const satisfies Intl.DateTimeFormatOptions;

/**
 * The clock-time components: `10.30 WIB`. `hourCycle: 'h23'` is the locale's own default, pinned
 * so that a CLDR revision cannot turn midnight into `24.30` or add an AM/PM marker.
 */
const TIME_OPTIONS = {
	timeZone: COMPLEX_TIME_ZONE,
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
	timeZoneName: 'short'
} as const satisfies Intl.DateTimeFormatOptions;

// Each formatter is built once: a fresh `Intl.DateTimeFormat` is not free to construct, and a
// table renders one per row.
const DAY_FORMAT = new Intl.DateTimeFormat(FORMAT_LOCALE, DAY_OPTIONS);
const TIME_FORMAT = new Intl.DateTimeFormat(FORMAT_LOCALE, TIME_OPTIONS);
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(FORMAT_LOCALE, {
	...DAY_OPTIONS,
	...TIME_OPTIONS
});

/**
 * The formatter `civilDayOf` and `civilMonthOf` read their parts from. The locale is irrelevant
 * because only the parts are used, never the formatted string; `en-US` is the one every runtime
 * carries even in a `small-icu` build.
 */
const CIVIL_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
	timeZone: COMPLEX_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/**
 * The calendar day `instant` falls on in the complex's zone, as Indonesian text: `20 Sep 2026`.
 *
 * @throws {RangeError} when `instant` is an invalid date.
 */
export function formatDay(instant: Date): string {
	return DAY_FORMAT.format(instant);
}

/**
 * The calendar day and clock time of `instant` in the complex's zone, labelled with the zone:
 * `20 Sep 2026, 10.30 WIB`.
 *
 * @throws {RangeError} when `instant` is an invalid date.
 */
export function formatDateTime(instant: Date): string {
	return DATE_TIME_FORMAT.format(instant);
}

/**
 * The clock time of `instant` in the complex's zone, labelled with the zone: `10.30 WIB`. Twenty-four
 * hour, so midnight is `00.30 WIB`, never `12.30 AM`.
 *
 * @throws {RangeError} when `instant` is an invalid date.
 */
export function formatTime(instant: Date): string {
	return TIME_FORMAT.format(instant);
}

/**
 * The interface languages `formatMonthLabel` spells a month name in — the same two `locales` the
 * Paraglide runtime carries. Declared locally, not imported from `$lib/paraglide/runtime`, so this
 * module keeps taking no imports (see the module doc, point 5); the two literal types are
 * structurally identical, so a `Locale` from that runtime is accepted here without a cast.
 */
export type InterfaceLocale = 'id' | 'en';

/** The month-and-year components: `September 2026`. One formatter per interface language. */
const MONTH_LABEL_OPTIONS = {
	timeZone: COMPLEX_TIME_ZONE,
	month: 'long',
	year: 'numeric'
} as const satisfies Intl.DateTimeFormatOptions;

const MONTH_LABEL_FORMAT: Readonly<Record<InterfaceLocale, Intl.DateTimeFormat>> = {
	id: new Intl.DateTimeFormat('id-ID', MONTH_LABEL_OPTIONS),
	en: new Intl.DateTimeFormat('en-US', MONTH_LABEL_OPTIONS)
};

/**
 * `"2026-09"` read as `"September 2026"` in `locale` — the WIB month a Periode or a Laporan
 * Bulanan is named by, spelled out for a heading. Added by ticket #177, moved here from the
 * Beranda's own loader so the Beranda and Laporan Bulanan share one formatter instead of each
 * keeping a copy.
 *
 * Day 15: never near a month boundary, whatever the zone's own offset, so the formatted month can
 * never slip to the one before or after.
 */
export function formatMonthLabel(period: string, locale: InterfaceLocale): string {
	const [year, month] = period.split('-').map(Number);
	return MONTH_LABEL_FORMAT[locale].format(new Date(Date.UTC(year, month - 1, 15)));
}

/**
 * The calendar day `instant` falls on in the complex's zone, as `YYYY-MM-DD` — the shape the
 * `date` columns store and the occupancy, dues and report services compare against.
 *
 * `2026-09-20T17:30:00Z` is still the twentieth in UTC and already `2026-09-21` here.
 *
 * @throws {RangeError} when `instant` is an invalid date.
 */
export function civilDayOf(instant: Date): string {
	const { year, month, day } = civilPartsOf(instant);
	return `${year}-${month}-${day}`;
}

/**
 * The calendar month `instant` falls on in the complex's zone, as `YYYY-MM` — the shape a Periode
 * and a Laporan Bulanan are named by.
 *
 * `2026-08-31T16:59:59Z` is `2026-08`; one second later is `2026-09`.
 *
 * @throws {RangeError} when `instant` is an invalid date.
 */
export function civilMonthOf(instant: Date): string {
	const { year, month } = civilPartsOf(instant);
	return `${year}-${month}`;
}

/**
 * The year, month and day of `instant` in the complex's zone, each as zero-padded digits. Read from
 * the formatter's parts rather than its formatted string so that the order never depends on the
 * locale.
 */
function civilPartsOf(instant: Date): { year: string; month: string; day: string } {
	const parts = CIVIL_DATE_FORMAT.formatToParts(instant);
	const partOfType = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return { year: partOfType('year'), month: partOfType('month'), day: partOfType('day') };
}
