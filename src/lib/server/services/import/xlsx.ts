// A default import, and `new ExcelJS.Workbook()` rather than `new Workbook()`, on purpose. ExcelJS
// is CommonJS and its entry point is `module.exports = require('./lib/exceljs.nodejs.js')`, a
// re-export Node's CommonJS named-export detection cannot see through. A named import type-checks
// and runs under Vitest, then fails the production build with "does not provide an export named
// 'Workbook'". Every module here imports it this way for that reason; do not tidy it back.
import ExcelJS, { type CellValue, type Row } from 'exceljs';
import { IMPORT_HEADER, ImportHeaderError, type ImportRow } from './validation';

/**
 * Turning an uploaded `.xlsx` workbook into the rows of text `./validation.ts` judges.
 *
 * This module knows about spreadsheets and nothing about residents. It answers one question — what
 * does this file say, cell by cell — and leaves every rule about what a row must contain to the
 * validation beside it. The only rule it does enforce is the header, because the header is the one
 * thing that must be read before the rest of the file means anything at all.
 *
 * ## Only the first sheet, and only five columns
 *
 * A workbook may carry any number of sheets; this reads `workbook.worksheets[0]` and ignores the
 * rest. A superuser filling in the Template Impor works on the one sheet it ships with, and a second
 * sheet is far more likely to be their own scratch working than a second batch of residents. Reading
 * it would import somebody's notes.
 *
 * Columns past the fifth are not read either, but a sixth *header* cell refuses the file: the five
 * columns reading correctly while a sixth exists means this is a different file that happens to
 * start the same way, and importing its first five columns would be a guess.
 *
 * ## Every cell becomes text, and every conversion is a decision
 *
 * A spreadsheet cell is not a string. It can be a number, a date, a formula with a cached result,
 * rich text with formatting runs, a hyperlink, or an error. The register stores text, so each of
 * those has to become text, and each choice decides whether a superuser's file is accepted:
 *
 * - **A number** becomes `String(value)`, so the house number `12` is `'12'` and never `'12.0'`.
 *   JavaScript has one number type and no trailing zeros, so a value typed as `12.5` stays `'12.5'`
 *   rather than being rounded into a different house. Beyond about 1e21 this is exponential
 *   notation, which is not a house number anybody typed.
 * - **A date** becomes `YYYY-MM-DD`. None of the five columns is a date, so this only happens when a
 *   spreadsheet has guessed a date out of something like `1-2`; the ISO day is the least surprising
 *   text for it and, being wrong for the column, it is refused by validation as a name or a role
 *   rather than silently accepted.
 * - **A boolean** becomes `'true'` or `'false'`, which no column accepts, so it is refused.
 * - **A formula** becomes whatever its cached `result` reads as. Nothing here evaluates formulas: the
 *   file carries the answer Excel last computed, and recomputing it would need a formula engine this
 *   import has no business owning. A formula whose result the file does not carry is empty.
 * - **Rich text** becomes its runs joined, so a name where one word was bolded is one name.
 * - **A hyperlink** becomes its `text`, which is what the cell shows. A mail client turns an address
 *   into a `mailto:` link the moment it is pasted, and the address the superuser sees is the one
 *   they meant.
 * - **An error cell** (`#N/A`, `#REF!`) becomes empty. It holds no data, and validation reports the
 *   column as missing, which is what the superuser has to fix.
 *
 * Every cell is trimmed. A spreadsheet keeps the spaces somebody typed, and a trailing space in
 * `peran` must not make `pemilik ` an unknown role.
 *
 * ## A row's identity is its position
 *
 * Rows whose every cell is empty are skipped, and the rows that survive are handed over as a plain
 * list. Nothing carries a sheet coordinate: `./validation.ts` numbers a row by where it sits in that
 * list, for the reasons its own doc comment gives.
 *
 * ## A file that is not a workbook
 *
 * `workbook.xlsx.load` throws on anything that is not a zip container holding a spreadsheet, so a
 * file saved as `.csv` is refused here rather than read as one column. The error it throws is
 * ExcelJS's own and reaches the route untranslated for now; giving the superuser a sentence about
 * picking an `.xlsx` file belongs to the screen, which #141 rewrites.
 */

/** How many columns this import reads, which is how many the header promises. */
const COLUMN_COUNT = IMPORT_HEADER.length;

/**
 * Reads the first sheet of an uploaded workbook and answers with its data rows as text.
 *
 * @throws {ImportHeaderError} when the workbook has no sheet, no rows, or a first row that is not
 *   `blok,nomor,nama,email,peran`.
 */
export async function readResidentRows(buffer: Buffer): Promise<readonly ImportRow[]> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(asArrayBuffer(buffer));

	const [sheet] = workbook.worksheets;
	if (!sheet) {
		throw new ImportHeaderError([]);
	}

	const rows: Row[] = [];
	sheet.eachRow((row) => {
		rows.push(row);
	});

	const [header, ...dataRows] = rows;
	if (!header) {
		throw new ImportHeaderError([]);
	}
	assertHeader(header);

	return dataRows.map(readRow).filter((cells) => !isEmpty(cells));
}

/** Throws unless the sheet's first row is exactly the header this import expects. */
function assertHeader(row: Row): void {
	const cells = readRow(row);
	const extra = cellText(row.getCell(COLUMN_COUNT + 1).value).trim();
	const matches =
		extra === '' && cells.every((cell, position) => cell.toLowerCase() === IMPORT_HEADER[position]);

	if (!matches) {
		throw new ImportHeaderError(extra === '' ? cells : [...cells, extra]);
	}
}

/** One row's five columns, as text, whatever the sheet actually stored in them. */
function readRow(row: Row): string[] {
	return Array.from({ length: COLUMN_COUNT }, (_unused, index) =>
		cellText(row.getCell(index + 1).value).trim()
	);
}

/** Whether a row carries nothing at all, and is therefore a gap rather than a record. */
function isEmpty(cells: readonly string[]): boolean {
	return cells.every((cell) => cell === '');
}

/** Whatever one cell holds, as the text this import reads. See this module's doc comment. */
function cellText(value: CellValue): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number') {
		return numberText(value);
	}
	if (typeof value === 'boolean') {
		return String(value);
	}
	if (value instanceof Date) {
		return dayText(value);
	}
	return compoundText(value);
}

/** The cell kinds ExcelJS hands over as an object: rich text, a hyperlink, an error, a formula. */
function compoundText(
	value: Exclude<CellValue, null | undefined | string | number | boolean | Date>
): string {
	if ('richText' in value) {
		return value.richText.map((run) => run.text).join('');
	}
	if ('hyperlink' in value) {
		return value.text;
	}
	if ('error' in value) {
		return '';
	}
	// Whatever is left is a formula, plain or shared. Its cached result is read the same way any
	// other cell is; a result is never itself a formula, so this recurses exactly once.
	return cellText(value.result ?? null);
}

/**
 * A number as the text it was typed as: `12` is `'12'`, not `'12.0'`.
 *
 * `String` rather than a fixed number of decimals on purpose. A spreadsheet stores `12` and `12.00`
 * as the same value and keeps the zeros only as a display format, so any fixed formatting here would
 * invent digits the superuser never typed — and turn every house number into a number no register
 * has.
 */
function numberText(value: number): string {
	return String(value);
}

/** A date as `YYYY-MM-DD`, the one unambiguous way to write a day as text. */
function dayText(value: Date): string {
	return value.toISOString().slice(0, 'YYYY-MM-DD'.length);
}

/**
 * The same bytes as a standalone `ArrayBuffer`.
 *
 * ExcelJS's type definitions declare their own `Buffer` as `interface Buffer extends ArrayBuffer {}`,
 * which shadows Node's inside that module, so `load` asks for an `ArrayBuffer` and a Node `Buffer` —
 * a `Uint8Array` — does not satisfy it. The zip reader underneath takes either, so this is a
 * typing mismatch rather than a real one, and copying the bytes into what the signature asks for
 * settles it without an assertion that could hide a genuine change later.
 */
function asArrayBuffer(buffer: Buffer): ArrayBuffer {
	const bytes = new ArrayBuffer(buffer.byteLength);
	new Uint8Array(bytes).set(buffer);
	return bytes;
}
