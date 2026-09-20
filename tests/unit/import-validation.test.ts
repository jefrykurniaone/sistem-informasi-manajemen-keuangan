import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { readResidentRows } from '$lib/server/services/import/xlsx';
import {
	EmptyImportFileError,
	IMPORT_PROBLEM,
	ImportTooLargeError,
	MAX_IMPORT_ROWS,
	validateImportRows,
	type ImportProblemCode,
	type ImportRow
} from '$lib/server/services/import/validation';

/**
 * Every refusal a file carries in itself, decided without a database and without a workbook:
 * `validateImportRows` is handed rows of text and says which are usable.
 *
 * Reading a workbook into those rows is proved in `tests/unit/import-xlsx.test.ts`, which also
 * proves the header contract, because the header is read where the file is. The two reasons that
 * need stored data — a house already registered, an address that already has an account — are
 * proved there too, against a real PostgreSQL.
 */

/** One data row, as `readResidentRows` hands it over: five cells of text, in the header's order. */
function row(block: string, number: string, name: string, email: string, role: string): ImportRow {
	return [block, number, name, email, role];
}

/** One row nothing refuses, for the tests that only care about the rows around it. */
const GOOD_ROW = row('A', '1', 'Budi', 'budi@komplek.id', 'pemilik');

/** The committed fixture named by `name`, read as an upload would hand it over. */
function fixture(name: string): Buffer {
	return readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
}

/** Every reason code recorded against `rowNumber`, in the order they were recorded. */
function codesAt(rows: readonly ImportRow[], rowNumber: number): readonly ImportProblemCode[] {
	const problem = validateImportRows(rows).problems.find(
		(candidate) => candidate.rowNumber === rowNumber
	);
	return (problem?.reasons ?? []).map((reason) => reason.code);
}

describe('validateImportRows, whole-file refusals', () => {
	it('refuses a file carrying no data rows at all', () => {
		expect(() => validateImportRows([])).toThrow(EmptyImportFileError);
	});

	it('refuses a file carrying more rows than one import may write', () => {
		const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_unused, index) =>
			row('A', String(index + 1), `Warga ${index}`, `warga${index}@komplek.id`, 'pemilik')
		);

		expect(() => validateImportRows(rows)).toThrow(ImportTooLargeError);
	});
});

describe('validateImportRows, rows it accepts', () => {
	it('maps the Indonesian occupancy roles to the ones the schema stores', () => {
		const result = validateImportRows([
			GOOD_ROW,
			row('A', '2', 'Sari', 'sari@komplek.id', 'PENYEWA')
		]);

		expect(result.rows.map((accepted) => accepted.role)).toEqual([
			OCCUPANCY_ROLE.owner,
			OCCUPANCY_ROLE.tenant
		]);
	});

	it('trims every field and lowercases the address', () => {
		const result = validateImportRows([
			row(' A ', ' 12 ', ' Budi Santoso ', ' Budi@Komplek.ID ', ' pemilik ')
		]);

		expect(result.rows[0]).toMatchObject({
			rowNumber: 2,
			block: 'A',
			number: '12',
			name: 'Budi Santoso',
			email: 'budi@komplek.id'
		});
	});

	it('numbers a row by its position, counting the header as row 1', () => {
		const result = validateImportRows([
			GOOD_ROW,
			row('A', '2', 'Sari', 'sari@komplek.id', 'penyewa')
		]);

		expect(result.rows.map((accepted) => accepted.rowNumber)).toEqual([2, 3]);
	});

	it('accepts the committed hundred-row fixture whole, with no problem at all', async () => {
		const result = validateImportRows(await readResidentRows(fixture('residents-valid.xlsx')));

		expect(result).toMatchObject({ problems: [] });
		expect(result.rows).toHaveLength(100);
	});

	it('reads the numeric house numbers of that fixture back as text', async () => {
		const result = validateImportRows(await readResidentRows(fixture('residents-valid.xlsx')));

		// The fixture stores `nomor` as real numbers, which is what a spreadsheet does when somebody
		// types one. Every house in the first block is numbered 1 to 20, as text and without decimals.
		expect(result.rows.slice(0, 20).map((accepted) => accepted.number)).toEqual(
			Array.from({ length: 20 }, (_unused, index) => String(index + 1))
		);
	});
});

describe('validateImportRows, the reasons a row is refused', () => {
	it.each([
		['an empty block', row('', '1', 'Budi', 'budi@komplek.id', 'pemilik'), 'missingBlock'],
		['an empty number', row('A', '', 'Budi', 'budi@komplek.id', 'pemilik'), 'missingNumber'],
		['an empty name', row('A', '1', '', 'budi@komplek.id', 'pemilik'), 'missingName'],
		['an empty address', row('A', '1', 'Budi', '', 'pemilik'), 'missingEmail'],
		[
			'an address that is not one',
			row('A', '1', 'Budi', 'budi-komplek.id', 'pemilik'),
			'invalidEmail'
		],
		['an empty occupancy role', row('A', '1', 'Budi', 'budi@komplek.id', ''), 'missingRole'],
		[
			'an occupancy role nobody knows',
			row('A', '1', 'Budi', 'budi@komplek.id', 'juragan'),
			'unknownRole'
		]
	] as const)('reports %s at its own row number', (_description, refused, code) => {
		expect(codesAt([refused], 2)).toContain(code);
	});

	it('reports a row with fewer cells than the header promises', () => {
		// Nothing can build a workbook that produces this: a sheet always hands over five cells. The
		// rule is kept because this module is a pure function over rows from any source, and a caller
		// that shortened a row would otherwise have it silently read as a row of empty columns.
		expect(codesAt([['A', '1', 'Budi', 'budi@komplek.id']], 2)).toContain(
			IMPORT_PROBLEM.malformedRow
		);
	});

	it.each([
		['two at signs', 'budi@@komplek.id'],
		['nothing before the at sign', '@komplek.id'],
		['nothing after the at sign', 'budi@'],
		['no dot in the domain', 'budi@komplek'],
		['a domain ending in a dot', 'budi@komplek.'],
		['a space inside', 'budi santoso@komplek.id']
	])('refuses an address with %s', (_description, email) => {
		expect(codesAt([row('A', '1', 'Budi', email, 'pemilik')], 2)).toContain(
			IMPORT_PROBLEM.invalidEmail
		);
	});

	it('refuses every row of a house named twice, not only the second one', () => {
		const rows = [GOOD_ROW, row('A', '1', 'Sari', 'sari@komplek.id', 'penyewa')];

		expect(codesAt(rows, 2)).toContain(IMPORT_PROBLEM.duplicateUnitInFile);
		expect(codesAt(rows, 3)).toContain(IMPORT_PROBLEM.duplicateUnitInFile);
	});

	it('refuses every row carrying the same address, whatever its capitals', () => {
		const rows = [
			row('A', '1', 'Budi', 'Budi@Komplek.id', 'pemilik'),
			row('A', '2', 'Sari', 'budi@komplek.id', 'penyewa')
		];

		expect(codesAt(rows, 2)).toContain(IMPORT_PROBLEM.duplicateEmailInFile);
		expect(codesAt(rows, 3)).toContain(IMPORT_PROBLEM.duplicateEmailInFile);
	});

	it('records every reason one row breaks, not only the first', () => {
		expect(codesAt([row('', '', 'Budi', 'bukan-email', 'juragan')], 2)).toEqual([
			IMPORT_PROBLEM.missingBlock,
			IMPORT_PROBLEM.missingNumber,
			IMPORT_PROBLEM.invalidEmail,
			IMPORT_PROBLEM.unknownRole
		]);
	});

	it('quotes back what the row carried, so the message can name it', () => {
		const [problem] = validateImportRows([
			row('A', '1', 'Budi', 'budi@komplek.id', 'juragan')
		]).problems;

		expect(problem.reasons).toEqual([{ code: IMPORT_PROBLEM.unknownRole, value: 'juragan' }]);
	});

	it('keeps the rows that are fine and refuses only the ones that are not', async () => {
		const result = validateImportRows(await readResidentRows(fixture('residents-broken.xlsx')));

		// Rows 2 and 14 are the two the file itself has nothing against; every row between them
		// carries one reason or another. `malformedRow` is not among them — see the test above.
		expect(result.rows.map((accepted) => accepted.rowNumber)).toEqual([2, 14]);
		expect(result.problems.map((problem) => problem.rowNumber)).toEqual([
			3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
		]);
	});
});
