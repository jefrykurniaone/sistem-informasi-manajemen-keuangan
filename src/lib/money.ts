/**
 * The money value used across the whole application: whole rupiah, with no fractional unit.
 *
 * Decisions settled here and followed by every later spec:
 *
 * 1. **Whole rupiah, not cents.** The rupiah has no fractional unit in real-world use, so there
 *    is no factor of 100 anywhere. A `/ 100` or `* 100` appearing in financial code is a sign of
 *    a mistake, not a unit conversion.
 * 2. **`number`, not `bigint`.** The largest value `number` holds without losing precision is
 *    `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991 rupiah, roughly nine quadrillion). One
 *    housing complex's cash book will not approach that in centuries. `bigint` would trade a
 *    great deal of convenience (literals, `JSON.stringify`, mixed arithmetic, SvelteKit form
 *    serialisation) for headroom that will never be used. The safe bound is still enforced in
 *    `rupiah()`, so a value past it is rejected rather than silently rounded.
 * 3. **A branded type.** `Rupiah` is a branded `number`, so a plain `number` cannot reach a
 *    money-valued parameter without passing through `rupiah()`. The result of arithmetic
 *    (`a + b`) decays back to a plain `number` and has to be re-wrapped with `rupiah(a + b)` —
 *    that is deliberate: the re-wrap is where the integer check and the safe bound run again.
 * 4. **Fractional input is rejected, not rounded.** `rupiah(150.5)` and `parseRupiah('150,50')`
 *    throw. Silent rounding is how money disappears without a trace; rejecting the input forces
 *    the caller to decide what it actually meant.
 *
 * In the database this value is stored as `bigint` (`int8`), not `integer` (`int4`): the `int4`
 * ceiling is 2,147,483,647 rupiah, and one complex's cash book can pass it over a decade or two.
 * See `src/lib/server/db/schema/index.ts`.
 */

declare const rupiahBrand: unique symbol;

/** A money value in whole rupiah. Always an integer inside the safe `number` range. */
export type Rupiah = number & { readonly [rupiahBrand]: 'Rupiah' };

/** The currency prefix `formatRupiah` writes and `parseRupiah` accepts. */
const CURRENCY_PREFIX = 'Rp';

/** The Indonesian thousands separator. The comma is the decimal separator and is always rejected. */
const THOUSANDS_SEPARATOR = '.';

/**
 * The text shapes `parseRupiah` accepts:
 * an optional minus sign, an optional `Rp` prefix, then either bare digits (`150000`) or digits
 * correctly grouped in threes (`150.000`, `1.234.567`). Commas, decimal points and incorrect
 * grouping (`1234.567`) do not match and are therefore rejected.
 */
const RUPIAH_PATTERN = /^(-?)(?:Rp\s*)?(\d{1,3}(?:\.\d{3})+|\d+)$/;

/**
 * Wraps a `number` into a `Rupiah`.
 *
 * @throws {TypeError} when the value is not a finite integer — including any fraction, which is
 *   rejected and never rounded.
 * @throws {RangeError} when the value is an integer but outside the safe `number` range, so that
 *   later arithmetic on it would lose precision.
 */
export function rupiah(value: number): Rupiah {
	if (!Number.isInteger(value)) {
		throw new TypeError(
			`A rupiah value must be a whole number, not ${value}. The rupiah has no fractional unit, and rounding is never applied silently.`
		);
	}
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(
			`The rupiah value ${value} is outside the safe range ${Number.MAX_SAFE_INTEGER}; arithmetic on it would lose precision.`
		);
	}
	return value as Rupiah;
}

/**
 * Formats a money value as Indonesian text, for example `Rp 1.500.000` and `-Rp 25.000`.
 *
 * The grouping is done here rather than through `Intl.NumberFormat` so that the result does not
 * depend on whichever ICU data version happens to be installed in Node, Bun or the container —
 * they disagree about a plain space versus a non-breaking space after `Rp`, and tests comparing
 * exact text would disagree with them.
 */
export function formatRupiah(value: Rupiah): string {
	const sign = value < 0 ? '-' : '';
	return `${sign}${CURRENCY_PREFIX} ${groupThousands(Math.abs(value))}`;
}

/**
 * Parses text into a `Rupiah`. Accepts the output of `formatRupiah` and bare digits.
 *
 * @throws {TypeError} when the text is not a whole-rupiah shape — including any fractional form
 *   such as `150,50`, which is rejected and never rounded.
 * @throws {RangeError} when the value is outside the safe `number` range.
 */
export function parseRupiah(text: string): Rupiah {
	const match = RUPIAH_PATTERN.exec(text.trim());
	if (!match) {
		throw new TypeError(
			`"${text}" is not a valid rupiah value. Accepted shapes: "150000", "150.000", "${CURRENCY_PREFIX} 150.000", "-${CURRENCY_PREFIX} 150.000". Fractions are not accepted.`
		);
	}
	const [, sign, digits] = match;
	return rupiah(Number(`${sign}${digits.replaceAll(THOUSANDS_SEPARATOR, '')}`));
}

/** Inserts thousands separators into the digits of an unsigned integer. */
function groupThousands(value: number): string {
	const digits = String(value);
	let result = '';
	for (let end = digits.length; end > 0; end -= 3) {
		const chunk = digits.slice(Math.max(0, end - 3), end);
		result = result === '' ? chunk : `${chunk}${THOUSANDS_SEPARATOR}${result}`;
	}
	return result;
}
