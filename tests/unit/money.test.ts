import { describe, expect, it } from 'vitest';
import { formatRupiah, groupThousands, parseRupiah, rupiah, type Rupiah } from '$lib/money';

describe('rupiah', () => {
	it.each([
		{ name: 'zero', input: 0 },
		{ name: 'one rupiah', input: 1 },
		{ name: 'one month of dues', input: 150_000 },
		{ name: 'a negative value for a cash correction', input: -25_000 },
		{ name: 'the safe number bound', input: Number.MAX_SAFE_INTEGER }
	])('accepts $name', ({ input }) => {
		expect(rupiah(input)).toBe(input);
	});

	it.each([
		{ name: 'half a rupiah', input: 150.5 },
		{ name: 'one hundredth', input: 1.01 },
		{ name: 'a very small fraction', input: 1.000000001 },
		{ name: 'not a number', input: Number.NaN },
		{ name: 'infinity', input: Number.POSITIVE_INFINITY }
	])('rejects $name instead of rounding it', ({ input }) => {
		expect(() => rupiah(input)).toThrow(TypeError);
	});

	it.each([
		{ name: 'above the safe bound', input: Number.MAX_SAFE_INTEGER + 2 },
		{ name: 'below the safe bound', input: Number.MIN_SAFE_INTEGER - 2 }
	])('rejects a value $name', ({ input }) => {
		expect(() => rupiah(input)).toThrow(RangeError);
	});
});

describe('groupThousands', () => {
	// The shared grouping of `formatRupiah` and of `rupiah-input.svelte`, so that a nominal being
	// typed and the same number in a table are never two different shapes.
	it.each([
		{ input: '', output: '' },
		{ input: '5', output: '5' },
		{ input: '999', output: '999' },
		{ input: '1000', output: '1.000' },
		{ input: '1500000', output: '1.500.000' },
		{ input: '1234567', output: '1.234.567' },
		{ input: '1000000000', output: '1.000.000.000' }
	])('groups "$input" as "$output"', ({ input, output }) => {
		expect(groupThousands(input)).toBe(output);
	});

	it('leaves an empty field empty rather than turning it into a zero', () => {
		// What lets `required` keep meaning "fill this in" on a nominal field: a blank field that
		// formatted itself as "0" would satisfy the browser and post a real amount nobody typed.
		expect(groupThousands('')).toBe('');
	});
});

describe('formatRupiah', () => {
	it.each([
		{ input: 0, output: 'Rp 0' },
		{ input: 1, output: 'Rp 1' },
		{ input: 999, output: 'Rp 999' },
		{ input: 1_000, output: 'Rp 1.000' },
		{ input: 150_000, output: 'Rp 150.000' },
		{ input: 1_234_567, output: 'Rp 1.234.567' },
		{ input: 1_000_000_000, output: 'Rp 1.000.000.000' },
		{ input: -25_000, output: '-Rp 25.000' }
	])('formats $input as $output', ({ input, output }) => {
		expect(formatRupiah(rupiah(input))).toBe(output);
	});

	it('never shows a fractional unit, because the rupiah has none', () => {
		// The mistake prevented here: treating the value as cents and dividing it by 100, which
		// would turn one rupiah into "Rp 0,01".
		expect(formatRupiah(rupiah(1))).toBe('Rp 1');
	});
});

describe('parseRupiah', () => {
	it.each([
		{ input: '0', output: 0 },
		{ input: '150000', output: 150_000 },
		{ input: '150.000', output: 150_000 },
		{ input: '1.234.567', output: 1_234_567 },
		{ input: 'Rp 150.000', output: 150_000 },
		{ input: 'Rp150.000', output: 150_000 },
		{ input: '  Rp 150.000  ', output: 150_000 },
		{ input: '-Rp 25.000', output: -25_000 },
		{ input: '-150.000', output: -150_000 }
	])('parses "$input" as $output', ({ input, output }) => {
		expect(parseRupiah(input)).toBe(output);
	});

	it.each([
		{ name: 'a fraction with an Indonesian decimal comma', input: '150.000,50' },
		{ name: 'a fraction without a thousands separator', input: '1500,5' },
		{ name: 'an English-style fraction', input: '1500.50' },
		{ name: 'incorrect thousands grouping', input: '1234.567' },
		{ name: 'empty text', input: '' },
		{ name: 'not a number', input: 'seratus ribu' },
		{ name: 'another currency', input: 'USD 150' }
	])('rejects $name instead of rounding it', ({ input }) => {
		expect(() => parseRupiah(input)).toThrow(TypeError);
	});

	it('rejects a value outside the safe range instead of truncating it', () => {
		expect(() => parseRupiah('9007199254740993')).toThrow(RangeError);
	});
});

describe('parseRupiah of a pasted amount', () => {
	// Built rather than typed: a literal non-breaking space in a test file is invisible, and a later
	// reformatting pass or editor would be free to turn it into a plain one without anybody noticing
	// that the case it exists for had stopped being tested.
	const nonBreakingSpace = String.fromCodePoint(0xa0);

	// The shapes one and a half million rupiah really arrives in when somebody copies it out of a
	// spreadsheet, a bank statement or this application's own tables. All of them are the same money.
	it.each([
		{ name: 'this application own formatting', input: 'Rp 1.500.000' },
		{ name: 'bare digits', input: '1500000' },
		{ name: 'grouped digits without the prefix', input: '1.500.000' },
		{ name: 'spaced digits with stray outer spaces', input: ' 1 500 000 ' },
		{ name: 'spaced digits', input: '1 500 000' },
		{
			name: 'digits spaced with non-breaking spaces',
			input: `1${nonBreakingSpace}500${nonBreakingSpace}000`
		},
		{ name: 'a non-breaking space after the prefix', input: `Rp${nonBreakingSpace}1.500.000` }
	])('reads $name as 1500000', ({ input }) => {
		expect(parseRupiah(input)).toBe(1_500_000);
	});

	it.each([
		{ name: 'a fraction', input: '1.500,50' },
		{ name: 'letters', input: 'abc' },
		{ name: 'a fraction spelled with a point', input: '1 500 000.50' },
		{ name: 'letters among spaced digits', input: '1 500 abc' }
	])('still rejects $name', ({ input }) => {
		expect(() => parseRupiah(input)).toThrow(TypeError);
	});
});

describe('round trip', () => {
	const values = [0, 1, 999, 1_000, 150_000, 1_234_567, 987_654_321_098, -25_000, -1_000_000];

	it.each(values)('parses the format of %i back without losing a single rupiah', (value) => {
		expect(parseRupiah(formatRupiah(rupiah(value)))).toBe(value);
	});

	it('sums a thousand invoices without a rounding error', () => {
		// The value is chosen so that the total would be off if there were a fractional step in
		// between: 1000 x 150,001 is exactly 150,001,000.
		const oneMonth = rupiah(150_001);
		let total = 0;
		for (let i = 0; i < 1000; i += 1) {
			total += oneMonth;
		}
		expect(rupiah(total)).toBe(150_001_000);
	});

	it('keeps the branded type across format and parse', () => {
		const before: Rupiah = rupiah(150_000);
		const after: Rupiah = parseRupiah(formatRupiah(before));
		expect(after).toBe(before);
	});
});
