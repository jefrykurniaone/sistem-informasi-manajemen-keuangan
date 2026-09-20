// A default import — see the note at the top of `src/lib/server/services/import/xlsx.ts`.
import ExcelJS, { type Worksheet } from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	IMPORT_TEMPLATE_CONTENT_TYPE,
	IMPORT_TEMPLATE_FILENAME,
	buildImportTemplate
} from '$lib/server/services/import/template';
import { readResidentRows } from '$lib/server/services/import/xlsx';
import {
	IMPORT_HEADER,
	IMPORT_ROLE_WORDS,
	validateImportRows
} from '$lib/server/services/import/validation';

/**
 * The Template Impor, proved by reading it back with the same library that wrote it.
 *
 * A template is documentation that is also input, so the assertion that matters most is the last
 * one: the file this builder produces is a file `readResidentRows` reads and `validateImportRows`
 * accepts. A template offering a column or a word the import refuses would send every superuser
 * down the same wrong path at once.
 */

/** Where the `peran` column sits, counting from 1 as a spreadsheet does. */
const ROLE_COLUMN = IMPORT_HEADER.indexOf('peran') + 1;

/** The first row a superuser types into, and the last one the dropdown reaches. */
const FIRST_DATA_ROW = 2;
const LAST_VALIDATED_ROW = 1001;

let template: Buffer;
let sheet: Worksheet;

/**
 * The template, opened again with ExcelJS.
 *
 * The bytes are copied into a plain `ArrayBuffer` first because ExcelJS's `load` is declared as
 * taking its own `Buffer`, which its type definitions define as an `ArrayBuffer` rather than Node's.
 * `src/lib/server/services/import/xlsx.ts` has the same conversion, for the same reason.
 */
async function reopen(): Promise<ExcelJS.Workbook> {
	const bytes = new ArrayBuffer(template.byteLength);
	new Uint8Array(bytes).set(template);

	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(bytes);
	return workbook;
}

beforeAll(async () => {
	template = await buildImportTemplate();

	const [first] = (await reopen()).worksheets;
	sheet = first;
});

describe('buildImportTemplate, what the workbook holds', () => {
	it('carries one sheet, named for what goes in it', async () => {
		const workbook = await reopen();

		expect(workbook.worksheets).toHaveLength(1);
		expect(workbook.worksheets[0].name).toBe('Warga');
	});

	it('starts with the header this import expects, in order', () => {
		const header = IMPORT_HEADER.map((_unused, index) => sheet.getCell(1, index + 1).value);

		expect(header).toEqual([...IMPORT_HEADER]);
	});

	it('writes the header in bold, so it reads as a header rather than as a row', () => {
		for (const [index] of IMPORT_HEADER.entries()) {
			expect(sheet.getCell(1, index + 1).font?.bold).toBe(true);
		}
	});

	it('gives every column a width, so nothing has to be dragged wider to be read', () => {
		for (const [index] of IMPORT_HEADER.entries()) {
			expect(sheet.getColumn(index + 1).width).toBeGreaterThan(0);
		}
	});

	it.each([
		[FIRST_DATA_ROW, ['A', '01', 'Budi Santoso', 'budi@contoh.id', IMPORT_ROLE_WORDS[0]]],
		[FIRST_DATA_ROW + 1, ['B', '12', 'Sari Dewi', 'sari@contoh.id', IMPORT_ROLE_WORDS[1]]]
	] as const)('shows an example row at row %i', (rowNumber, expected) => {
		const cells = IMPORT_HEADER.map((_unused, index) => sheet.getCell(rowNumber, index + 1).value);

		expect(cells).toEqual([...expected]);
	});

	it('keeps the leading zero of the first example house number, as text', () => {
		const number = sheet.getCell(FIRST_DATA_ROW, IMPORT_HEADER.indexOf('nomor') + 1).value;

		// A house numbered `01` is the value a spreadsheet is most likely to turn into `1`. Written as
		// text, it survives, and the template shows that it does.
		expect(number).toBe('01');
		expect(typeof number).toBe('string');
	});
});

describe('buildImportTemplate, the role dropdown', () => {
	it.each([FIRST_DATA_ROW, FIRST_DATA_ROW + 1, 500, LAST_VALIDATED_ROW])(
		'offers the two words the import accepts, and nothing else, at row %i',
		(rowNumber) => {
			expect(sheet.getCell(rowNumber, ROLE_COLUMN).dataValidation).toMatchObject({
				type: 'list',
				formulae: [`"${IMPORT_ROLE_WORDS.join(',')}"`]
			});
		}
	);

	it('offers the same two words the validation maps to an occupancy role', () => {
		expect([...IMPORT_ROLE_WORDS]).toEqual(['pemilik', 'penyewa']);
	});
});

describe('buildImportTemplate, the download it becomes', () => {
	it('is named and typed as the spreadsheet it is', () => {
		expect(IMPORT_TEMPLATE_FILENAME).toBe('template-impor-warga.xlsx');
		expect(IMPORT_TEMPLATE_CONTENT_TYPE).toBe(
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		);
	});

	it('is a file this import reads back and accepts whole', async () => {
		const rows = await readResidentRows(template);
		const result = validateImportRows(rows);

		expect(rows).toHaveLength(2);
		expect(result.problems).toEqual([]);
		expect(result.rows.map((row) => row.number)).toEqual(['01', '12']);
		expect(result.rows.map((row) => row.email)).toEqual(['budi@contoh.id', 'sari@contoh.id']);
	});
});
