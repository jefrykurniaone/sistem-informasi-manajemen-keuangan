import { describe, expect, it } from 'vitest';
import { parseRupiah } from '#lib/money.ts';
import {
	caretAfterDigits,
	countDigits,
	editRupiahField,
	readRupiahField
} from '#lib/rupiah-field.ts';

/**
 * The text of a nominal field, sorted (#340). The field used to keep the digits of whatever was
 * typed, so `12,5` was recorded as Rp 125; every refused row below is a text that once became a
 * different whole amount that way.
 */

/** Built rather than typed, for the reason `tests/unit/money.test.ts` gives. */
const NON_BREAKING_SPACE = String.fromCodePoint(0xa0);

describe('readRupiahField', () => {
	it.each([
		{ name: 'a fraction with a decimal comma', input: '12,5' },
		{ name: 'a mobile-banking paste with ,00', input: '1.500.000,00' },
		{ name: 'an abbreviation with letters', input: '150rb' },
		{ name: 'a minus sign', input: '-150.000' },
		{ name: 'a fraction with a decimal point', input: '12.5' },
		{ name: 'a minus sign before the prefix', input: '-Rp 25.000' },
		{ name: 'a minus zero', input: '-0' },
		{ name: 'incorrect grouping', input: '1234.567' },
		{ name: 'an unfinished group', input: '150.' },
		{ name: 'the prefix alone', input: 'Rp' },
		{ name: 'an amount past the safe range', input: '9007199254740993' }
	])('refuses $name and keeps "$input" exactly as typed', ({ input }) => {
		const field = readRupiahField(input);
		expect(field).toEqual({ kind: 'invalid', display: input, posted: input });
	});

	it.each([
		{ input: 'Rp 1.500.000', amount: 1_500_000, display: '1.500.000', posted: '1500000' },
		{ input: '1 500 000', amount: 1_500_000, display: '1.500.000', posted: '1500000' },
		{ input: '1500000', amount: 1_500_000, display: '1.500.000', posted: '1500000' },
		{ input: '150.000', amount: 150_000, display: '150.000', posted: '150000' },
		{
			input: `1${NON_BREAKING_SPACE}500${NON_BREAKING_SPACE}000`,
			amount: 1_500_000,
			display: '1.500.000',
			posted: '1500000'
		},
		{ input: ' Rp150.000 ', amount: 150_000, display: '150.000', posted: '150000' },
		{ input: '5', amount: 5, display: '5', posted: '5' },
		{ input: '0', amount: 0, display: '0', posted: '0' },
		{ input: '007', amount: 7, display: '007', posted: '007' }
	])('reads "$input" as $amount, shown as $display', ({ input, amount, display, posted }) => {
		const field = readRupiahField(input);
		expect(field).toEqual({ kind: 'valid', amount, display, posted });
		// The server reads the same money out of the text the person typed and out of what is posted.
		expect(parseRupiah(input)).toBe(amount);
		expect(parseRupiah(posted)).toBe(amount);
	});

	it.each(['', '   ', NON_BREAKING_SPACE])('reads %j as an empty field, not as a zero', (input) => {
		expect(readRupiahField(input)).toEqual({ kind: 'empty', display: '', posted: '' });
	});

	it('reads a number handed in by a form the same way as the digits of it', () => {
		// `dues-rate-form.svelte` passes the stored Tarif amount, a number, as the field's value.
		expect(readRupiahField(String(150_000))).toMatchObject({ kind: 'valid', display: '150.000' });
	});
});

describe('editRupiahField', () => {
	/** Types `text` one character at a time into an empty field, as a keyboard does. */
	function typeIntoEmptyField(text: string): ReturnType<typeof editRupiahField> {
		let field = readRupiahField('');
		for (const character of text) {
			field = editRupiahField(field.display, `${field.display}${character}`);
		}
		return field;
	}

	it.each([
		{ typed: '1500000', display: '1.500.000' },
		{ typed: '150.000', display: '150.000' },
		{ typed: '1.500.000', display: '1.500.000' },
		{ typed: 'Rp 150.000', display: '150.000' },
		{ typed: '1 500 000', display: '1.500.000' }
	])('typing "$typed" key by key ends as the amount $display', ({ typed, display }) => {
		expect(typeIntoEmptyField(typed)).toMatchObject({ kind: 'valid', display });
	});

	it.each(['12,5', '1.500.000,00', '150rb', '-150.000', '12.5'])(
		'typing "%s" key by key ends refused and untouched',
		(typed) => {
			expect(typeIntoEmptyField(typed)).toEqual({
				kind: 'invalid',
				display: typed,
				posted: typed
			});
		}
	);

	it('reads a digit typed into a grouped amount as a digit, not as a decimal fraction', () => {
		// `1.5000` is wrongly grouped on its own, but the separator was the field's, not the person's.
		expect(editRupiahField('1.500', '1.5000')).toMatchObject({ kind: 'valid', display: '15.000' });
		expect(editRupiahField('1.500', '1.0500')).toMatchObject({ kind: 'valid', display: '10.500' });
	});

	it('reflows a grouped amount when a digit is deleted from it', () => {
		expect(editRupiahField('1.250', '1.25')).toMatchObject({ kind: 'valid', display: '125' });
		expect(editRupiahField('15.000', '1.000')).toMatchObject({ kind: 'valid', display: '1.000' });
	});

	it('puts back a separator removed by Backspace, leaving the amount unchanged', () => {
		expect(editRupiahField('1.500', '1500')).toMatchObject({ kind: 'valid', display: '1.500' });
	});

	it('empties the field when every digit is deleted', () => {
		expect(editRupiahField('5', '')).toEqual({ kind: 'empty', display: '', posted: '' });
	});

	it('gives no separator reading to text the person punctuated themselves', () => {
		// `12.` is not a grouped display, so the `.` in `12.5` is the person's and the text is refused.
		expect(editRupiahField('12.', '12.5')).toMatchObject({ kind: 'invalid', display: '12.5' });
		// A `.` put into a grouped amount is the person's too.
		expect(editRupiahField('1.500', '1.5.00')).toMatchObject({ kind: 'invalid' });
		expect(editRupiahField('12', '12.')).toMatchObject({ kind: 'invalid', display: '12.' });
	});

	it('reads a paste over a grouped amount as the pasted text', () => {
		expect(editRupiahField('1.500', '12,5')).toMatchObject({ kind: 'invalid', display: '12,5' });
		expect(editRupiahField('1.500', 'Rp 2.000.000')).toMatchObject({
			kind: 'valid',
			display: '2.000.000'
		});
	});

	it('puts a corrected text back to an amount', () => {
		expect(editRupiahField('12,5', '125')).toMatchObject({ kind: 'valid', display: '125' });
		expect(editRupiahField('1.500.000,00', '1.500.000')).toMatchObject({
			kind: 'valid',
			display: '1.500.000'
		});
	});

	it('refuses digits typed past the safe range, keeping the typed text', () => {
		const grouped = '9.007.199.254.740.991';
		expect(readRupiahField(grouped)).toMatchObject({ kind: 'valid' });
		expect(editRupiahField(grouped, `${grouped}1`)).toEqual({
			kind: 'invalid',
			display: `${grouped}1`,
			posted: `${grouped}1`
		});
	});
});

describe('caretAfterDigits', () => {
	it.each([
		{ display: '15.000', count: 0, caret: 0 },
		{ display: '15.000', count: 2, caret: 2 },
		{ display: '15.000', count: 3, caret: 4 },
		{ display: '1.500.000', count: 4, caret: 5 },
		{ display: '1.500', count: 9, caret: 5 }
	])('puts the caret after $count digits of $display at $caret', ({ display, count, caret }) => {
		expect(caretAfterDigits(display, count)).toBe(caret);
	});

	it('counts the digits to the left of a caret in any text', () => {
		expect(countDigits('Rp 1.50')).toBe(3);
		expect(countDigits('')).toBe(0);
	});
});
