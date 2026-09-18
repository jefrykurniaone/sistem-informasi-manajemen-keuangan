import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import {
	EmptyImportFileError,
	IMPORT_CSV_HEADER,
	IMPORT_PROBLEM,
	ImportHeaderError,
	ImportTooLargeError,
	MAX_IMPORT_ROWS,
	parseCsvRecords,
	validateImportCsv,
	type ImportProblemCode
} from '$lib/server/services/import/validation';

/**
 * Reading a resident CSV without a database: the quoting rules, the header contract, and every
 * reason a row is refused for something the file alone can see. The two reasons that need stored
 * data — a house already registered, an address that already has an account — are proved in
 * `tests/unit/import-csv.test.ts` against a real PostgreSQL.
 */

const HEADER = IMPORT_CSV_HEADER.join(',');

/** U+FEFF, built from its code point rather than typed: a literal one is invisible in a diff. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** The committed fixture named by `name`, read as the upload would hand it over. */
function fixture(name: string): string {
	return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

/** A file made of `HEADER` and the given data lines. */
function file(...lines: readonly string[]): string {
	return [HEADER, ...lines].join('\n');
}

/** Every reason code recorded against `rowNumber`, in the order they were recorded. */
function codesAt(content: string, rowNumber: number): readonly ImportProblemCode[] {
	const problem = validateImportCsv(content).problems.find((row) => row.rowNumber === rowNumber);
	return (problem?.reasons ?? []).map((reason) => reason.code);
}

describe('parseCsvRecords', () => {
	it('keeps a quoted field carrying a comma as one field', () => {
		const [record] = parseCsvRecords('A,1,"Budi, S.T.",budi@komplek.id,pemilik');

		expect(record.fields).toEqual(['A', '1', 'Budi, S.T.', 'budi@komplek.id', 'pemilik']);
	});

	it('reads a doubled quote inside a quoted field as one quote', () => {
		const [record] = parseCsvRecords('A,1,"Budi ""Bud"" Santoso",budi@komplek.id,pemilik');

		expect(record.fields[2]).toBe('Budi "Bud" Santoso');
	});

	it('reads CRLF line endings, and numbers the lines as a person counts them', () => {
		const records = parseCsvRecords(`${HEADER}\r\nA,1,Budi,budi@komplek.id,pemilik\r\n`);

		expect(records.map((record) => record.lineNumber)).toEqual([1, 2]);
	});

	it('skips the blank line a file ending in a newline leaves behind', () => {
		const records = parseCsvRecords(`${HEADER}\nA,1,Budi,budi@komplek.id,pemilik\n\n`);

		expect(records).toHaveLength(2);
	});

	it('drops the byte-order mark a spreadsheet writes in front of the header', () => {
		const [record] = parseCsvRecords(`${BYTE_ORDER_MARK}${HEADER}`);

		expect(record.fields[0]).toBe('blok');
	});

	it('counts a line break inside a quoted field, so later rows keep their real line number', () => {
		const records = parseCsvRecords(`${HEADER}\nA,1,"Budi\nSantoso",budi@komplek.id,pemilik\nB,2`);

		expect(records.at(-1)?.lineNumber).toBe(4);
	});
});

describe('validateImportCsv, whole-file refusals', () => {
	it('refuses a file whose header is not the expected one', () => {
		expect(() =>
			validateImportCsv('block,number,name,email,role\nA,1,Budi,b@k.id,pemilik')
		).toThrow(ImportHeaderError);
	});

	it('accepts a header written in capitals and with stray spaces around it', () => {
		const result = validateImportCsv(` BLOK , Nomor ,NAMA,Email, Peran \nA,1,Budi,b@k.id,pemilik`);

		expect(result.rows).toHaveLength(1);
	});

	it('refuses a file carrying nothing but the header', () => {
		expect(() => validateImportCsv(HEADER)).toThrow(EmptyImportFileError);
	});

	it('refuses an empty file', () => {
		expect(() => validateImportCsv('')).toThrow(ImportHeaderError);
	});

	it('refuses a file carrying more rows than one import may write', () => {
		const rows = Array.from(
			{ length: MAX_IMPORT_ROWS + 1 },
			(_, index) => `A,${index + 1},Warga ${index},warga${index}@komplek.id,pemilik`
		);

		expect(() => validateImportCsv(file(...rows))).toThrow(ImportTooLargeError);
	});
});

describe('validateImportCsv, rows it accepts', () => {
	it('maps the Indonesian occupancy roles to the ones the schema stores', () => {
		const result = validateImportCsv(
			file('A,1,Budi,budi@komplek.id,pemilik', 'A,2,Sari,sari@komplek.id,PENYEWA')
		);

		expect(result.rows.map((row) => row.role)).toEqual([
			OCCUPANCY_ROLE.owner,
			OCCUPANCY_ROLE.tenant
		]);
	});

	it('trims every field and lowercases the address', () => {
		const result = validateImportCsv(file(' A , 12 , Budi Santoso , Budi@Komplek.ID , pemilik '));

		expect(result.rows[0]).toMatchObject({
			rowNumber: 2,
			block: 'A',
			number: '12',
			name: 'Budi Santoso',
			email: 'budi@komplek.id'
		});
	});

	it('numbers a row by its line in the file, counting the header as line 1', () => {
		const result = validateImportCsv(
			file('A,1,Budi,budi@komplek.id,pemilik', 'A,2,Sari,sari@komplek.id,penyewa')
		);

		expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
	});

	it('accepts the committed hundred-row fixture whole, with no problem at all', () => {
		const result = validateImportCsv(fixture('residents-valid.csv'));

		expect(result).toMatchObject({ problems: [] });
		expect(result.rows).toHaveLength(100);
	});
});

describe('validateImportCsv, the reasons a row is refused', () => {
	it.each([
		['a row with fewer columns than the header', 'A,1,Budi,budi@komplek.id', 'malformedRow'],
		['an empty block', ',1,Budi,budi@komplek.id,pemilik', 'missingBlock'],
		['an empty number', 'A,,Budi,budi@komplek.id,pemilik', 'missingNumber'],
		['an empty name', 'A,1,,budi@komplek.id,pemilik', 'missingName'],
		['an empty address', 'A,1,Budi,,pemilik', 'missingEmail'],
		['an address that is not one', 'A,1,Budi,budi-komplek.id,pemilik', 'invalidEmail'],
		['an empty occupancy role', 'A,1,Budi,budi@komplek.id,', 'missingRole'],
		['an occupancy role nobody knows', 'A,1,Budi,budi@komplek.id,juragan', 'unknownRole']
	] as const)('reports %s at its own line number', (_description, line, code) => {
		expect(codesAt(file(line), 2)).toContain(code);
	});

	it.each([
		['two at signs', 'budi@@komplek.id'],
		['nothing before the at sign', '@komplek.id'],
		['nothing after the at sign', 'budi@'],
		['no dot in the domain', 'budi@komplek'],
		['a domain ending in a dot', 'budi@komplek.'],
		['a space inside', 'budi santoso@komplek.id']
	])('refuses an address with %s', (_description, email) => {
		expect(codesAt(file(`A,1,Budi,${email},pemilik`), 2)).toContain(IMPORT_PROBLEM.invalidEmail);
	});

	it('refuses every row of a house named twice, not only the second one', () => {
		const content = file('A,1,Budi,budi@komplek.id,pemilik', 'A,1,Sari,sari@komplek.id,penyewa');

		expect(codesAt(content, 2)).toContain(IMPORT_PROBLEM.duplicateUnitInFile);
		expect(codesAt(content, 3)).toContain(IMPORT_PROBLEM.duplicateUnitInFile);
	});

	it('refuses every row carrying the same address, whatever its capitals', () => {
		const content = file('A,1,Budi,Budi@Komplek.id,pemilik', 'A,2,Sari,budi@komplek.id,penyewa');

		expect(codesAt(content, 2)).toContain(IMPORT_PROBLEM.duplicateEmailInFile);
		expect(codesAt(content, 3)).toContain(IMPORT_PROBLEM.duplicateEmailInFile);
	});

	it('records every reason one row breaks, not only the first', () => {
		expect(codesAt(file(',,Budi,bukan-email,juragan'), 2)).toEqual([
			IMPORT_PROBLEM.missingBlock,
			IMPORT_PROBLEM.missingNumber,
			IMPORT_PROBLEM.invalidEmail,
			IMPORT_PROBLEM.unknownRole
		]);
	});

	it('quotes back what the row carried, so the message can name it', () => {
		const [problem] = validateImportCsv(file('A,1,Budi,budi@komplek.id,juragan')).problems;

		expect(problem.reasons).toEqual([{ code: IMPORT_PROBLEM.unknownRole, value: 'juragan' }]);
	});

	it('keeps the rows that are fine and refuses only the ones that are not', () => {
		const result = validateImportCsv(fixture('residents-broken.csv'));

		expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 15]);
		expect(result.problems.map((problem) => problem.rowNumber)).toEqual([
			3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
		]);
	});
});
