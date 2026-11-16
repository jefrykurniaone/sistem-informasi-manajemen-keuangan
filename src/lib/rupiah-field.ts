import { groupThousands, matchRupiahText, rupiah, type Rupiah } from '#lib/money.ts';

/**
 * What a nominal field (`src/lib/components/rupiah-input.svelte`) makes of the text in it (#340).
 *
 * The field used to keep the digits of whatever was typed and drop everything else, so `12,5`
 * became `125` and `-150.000` became `150000`: a fraction or a sign turned silently into a
 * different whole amount before the server's `parseRupiah` could refuse it. This module is the rule
 * that replaced that. It never turns text into a different number: text is either an amount, shown
 * grouped, or it is left exactly as it was typed and refused.
 *
 * ## The three kinds
 *
 * - **`empty`**: nothing but spacing. Shown as nothing and posted as nothing, so `required` still
 *   means "fill this in". Never a refusal of its own: an empty required field is the browser's.
 * - **`valid`**: the grammar of `parseRupiah` (`matchRupiahText` in `src/lib/money.ts`, the same
 *   function, not a copy of its pattern) without a minus sign, and inside the range `rupiah()`
 *   accepts. Bare digits, digits grouped with `.`, digits spaced apart, an `Rp` in front. Shown
 *   grouped (`1.500.000`), posted as plain digits (`1500000`), and `parseRupiah` reads the same
 *   amount out of both the text and the digits.
 * - **`invalid`**: everything else, which is a comma (`12,5`, `1.500.000,00`), a decimal point
 *   (`12.5`), letters (`150rb`), a minus sign (`-150.000`), or an amount past the safe range. Shown
 *   and posted exactly as typed, so the server refuses the same text the person sees, and refills the
 *   field with it.
 *
 * The minus sign is refused here although `parseRupiah` accepts it (spec #344): every amount one of
 * these fields carries is positive, with the direction of a Transaksi Kas coming from its Kategori
 * rather than from a sign, so a typed minus is a mistake to point at, never a sign to drop.
 */
export type RupiahField = EmptyRupiahField | ValidRupiahField | InvalidRupiahField;

/** Text with nothing in it but spacing. */
export interface EmptyRupiahField {
	readonly kind: 'empty';
	/** What the visible input shows: always `''`. */
	readonly display: '';
	/** What the hidden input posts: always `''`. */
	readonly posted: '';
}

/** Text that is a whole, non-negative amount in the shape `parseRupiah` accepts. */
export interface ValidRupiahField {
	readonly kind: 'valid';
	/** The amount the text names. `parseRupiah` of the text and of `posted` both answer this. */
	readonly amount: Rupiah;
	/** The digits grouped in threes: `1.500.000`. */
	readonly display: string;
	/** The plain digits, leading zeros kept: `1500000`. */
	readonly posted: string;
}

/** Text that is not an amount this field accepts. Shown and posted untouched. */
export interface InvalidRupiahField {
	readonly kind: 'invalid';
	/** The text exactly as typed. */
	readonly display: string;
	/** The text exactly as typed, so the server refuses what the person sees. */
	readonly posted: string;
}

/** The empty field, of which there is only one. */
const EMPTY_FIELD: EmptyRupiahField = { kind: 'empty', display: '', posted: '' };

/** The separator `groupThousands` writes, which is the only non-digit a grouped display holds. */
const GROUP_SEPARATOR = '.';

/** A run of digits and nothing else, the empty run included. */
const DIGITS_ONLY_PATTERN = /^\d*$/;

/** Digits and grouping separators and nothing else. */
const DIGITS_AND_SEPARATORS_PATTERN = /^[\d.]*$/;

/** One digit, for walking a string character by character. */
const DIGIT_PATTERN = /^\d$/;

/** Every digit in a string, for counting them. */
const DIGIT_GLOBAL_PATTERN = /\d/g;

/** Sorts the text of a nominal field into one of the three kinds above. */
export function readRupiahField(text: string): RupiahField {
	if (text.trim() === '') {
		return EMPTY_FIELD;
	}
	const shape = matchRupiahText(text);
	if (shape === undefined || shape.sign === '-') {
		return invalid(text);
	}
	const value = Number(shape.digits);
	if (!Number.isSafeInteger(value)) {
		// `rupiah()` would throw a RangeError, and so would the server's `parseRupiah`.
		return invalid(text);
	}
	return {
		kind: 'valid',
		amount: rupiah(value),
		display: groupThousands(shape.digits),
		posted: shape.digits
	};
}

/**
 * What the field holds after one edit: `typed` is the input's text right after a keystroke, a
 * paste, a cut or an undo, and `previousDisplay` is what the field showed just before it.
 *
 * Usually that is `readRupiahField(typed)`. The one exception is an edit that only adds or removes
 * digits in a grouped display the field wrote itself, and it is what keeps typing into a grouped
 * amount working. Typing `0` at the end of `1.500` leaves `1.5000` in the input; read on its own,
 * that is wrongly grouped and so refused by the grammar, yet nobody typed a decimal point: the
 * separator was the field's. So when `previousDisplay` is a grouped display and the edit put in
 * nothing but digits, every `.` left in `typed` is one of the field's own separators, and is
 * dropped before the text is read: `1.5000` is `15000`, and shows as `15.000`.
 *
 * Text the person grouped or punctuated themselves gets no such reading, because a display that is
 * not grouped (`12.` on its way to `12.5`) does not qualify, and neither does an edit that put in a
 * `.` or any other non-digit. That is what keeps `12.5` refused when it is typed character by
 * character, and `150.000` accepted.
 */
export function editRupiahField(previousDisplay: string, typed: string): RupiahField {
	if (isGroupedDisplay(previousDisplay) && insertsOnlyDigits(previousDisplay, typed)) {
		const regrouped = readRupiahField(typed.replaceAll(GROUP_SEPARATOR, ''));
		if (regrouped.kind !== 'invalid') {
			return regrouped;
		}
	}
	return readRupiahField(typed);
}

/** How many digits `text` holds. */
export function countDigits(text: string): number {
	return text.match(DIGIT_GLOBAL_PATTERN)?.length ?? 0;
}

/**
 * The position in `display` that has exactly `count` digits to its left.
 *
 * This is the whole caret-restoration rule of the nominal field. Counting digits is what makes it
 * survive a separator appearing or disappearing in the middle of the value: comparing string lengths
 * before and after grouping puts the caret one character out the moment `1.500` becomes `15.000`,
 * and two out when a paste adds several separators at once.
 */
export function caretAfterDigits(display: string, count: number): number {
	if (count === 0) {
		return 0;
	}
	let seen = 0;
	let index = 0;
	for (const character of display) {
		index += 1;
		if (DIGIT_PATTERN.test(character)) {
			seen += 1;
			if (seen === count) {
				return index;
			}
		}
	}
	return display.length;
}

/** The invalid field holding `text` untouched. */
function invalid(text: string): InvalidRupiahField {
	return { kind: 'invalid', display: text, posted: text };
}

/**
 * Whether `display` is digits grouped in threes exactly as `groupThousands` writes them, so that
 * every `.` in it is a thousands separator rather than something somebody typed as a decimal point.
 */
function isGroupedDisplay(display: string): boolean {
	return (
		DIGITS_AND_SEPARATORS_PATTERN.test(display) &&
		groupThousands(display.replaceAll(GROUP_SEPARATOR, '')) === display
	);
}

/**
 * Whether turning `before` into `after` put in nothing but digits, and took out nothing but digits
 * and separators. The edit is the stretch between the longest common prefix and the longest common
 * suffix of the two; whatever lies outside it was in `before` already.
 */
function insertsOnlyDigits(before: string, after: string): boolean {
	const shorter = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < shorter && before[prefix] === after[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < shorter - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}
	const removed = before.slice(prefix, before.length - suffix);
	const inserted = after.slice(prefix, after.length - suffix);
	return DIGITS_ONLY_PATTERN.test(inserted) && DIGITS_AND_SEPARATORS_PATTERN.test(removed);
}
