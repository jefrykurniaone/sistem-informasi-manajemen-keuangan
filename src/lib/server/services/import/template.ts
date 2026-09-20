// A default import — see the note at the top of `./xlsx.ts` for why a named one breaks the build.
import ExcelJS, { type Worksheet } from 'exceljs';
import { IMPORT_HEADER, IMPORT_ROLE_WORDS } from './validation';

/**
 * Building the Template Impor: the empty workbook a superuser downloads, fills in, and uploads back.
 *
 * The template is the only documentation of the file format that cannot go stale. A help text
 * describing five columns drifts from the code the moment a column is renamed; a workbook built from
 * `IMPORT_HEADER` and `IMPORT_ROLE_WORDS` is the format, and `./xlsx.ts` reads back exactly what
 * this writes.
 *
 * Three things in it are there to stop a file being refused rather than to look tidy:
 *
 * - **Two example rows**, so the shape of a row is visible rather than described. They use `contoh.id`
 *   addresses, which nobody owns, so a superuser who forgets to delete them gets rows refused by the
 *   register rather than invitations sent to a real stranger.
 * - **`01` in the second column of the first example**, written as text. A house number with a leading
 *   zero is the one value a spreadsheet is most likely to turn into something else, and showing it
 *   kept is worth more than saying so.
 * - **A dropdown on the whole `peran` column**, so the two words the import accepts are the two words
 *   that can be typed. `unknownRole` was the single most common refusal the format could produce, and
 *   a list validation removes it at the source.
 */

/** What a browser is told the Template Impor is, so it opens in a spreadsheet rather than a tab. */
export const IMPORT_TEMPLATE_CONTENT_TYPE =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What the downloaded Template Impor is called on disk. */
export const IMPORT_TEMPLATE_FILENAME = 'template-impor-warga.xlsx';

/** The one sheet the template carries, named for what it holds. */
const SHEET_NAME = 'Warga';

/** The header word of the column the dropdown goes on. */
const ROLE_COLUMN = 'peran';

/**
 * The two rows that show what a row looks like.
 *
 * The second column is deliberately `'01'` and not `1` — see this module's doc comment. Written as a
 * string, so the cell is text and the zero survives a round trip through Excel.
 */
const EXAMPLE_ROWS: readonly (readonly string[])[] = [
	['A', '01', 'Budi Santoso', 'budi@contoh.id', IMPORT_ROLE_WORDS[0]],
	['B', '12', 'Sari Dewi', 'sari@contoh.id', IMPORT_ROLE_WORDS[1]]
];

/**
 * How wide each column is, by the word in its header. Wide enough that a real name and a real
 * address are readable without anybody dragging a column edge, which is where a file gets edited
 * wrong.
 */
const COLUMN_WIDTHS: Readonly<Record<string, number>> = {
	blok: 10,
	nomor: 10,
	nama: 30,
	email: 32,
	peran: 14
};

/** What a column is given when `COLUMN_WIDTHS` says nothing about it. */
const DEFAULT_COLUMN_WIDTH = 16;

/** Row 1 is the header, so the first row a superuser types into is row 2. */
const FIRST_DATA_ROW = 2;

/**
 * The last row the `peran` dropdown reaches.
 *
 * A thousand rows, which is twice `MAX_IMPORT_ROWS`, so the dropdown is still there in every row a
 * file may legitimately carry and for a good way past it. Validations are stored as a range per
 * cell, so this costs bytes rather than seconds.
 */
const LAST_VALIDATED_ROW = 1001;

/** Builds the Template Impor as the bytes of an `.xlsx` file. */
export async function buildImportTemplate(): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet(SHEET_NAME);

	sheet.addRow([...IMPORT_HEADER]);
	for (const example of EXAMPLE_ROWS) {
		sheet.addRow([...example]);
	}

	sheet.getRow(1).font = { bold: true };
	applyColumnWidths(sheet);
	applyRoleDropdown(sheet);

	// `writeBuffer` answers with ExcelJS's own buffer type, which is declared as an `ArrayBuffer`.
	// Copying it into a Node `Buffer` here is what lets every caller take one.
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Gives every column of the header the width its word asks for. */
function applyColumnWidths(sheet: Worksheet): void {
	for (const [index, word] of IMPORT_HEADER.entries()) {
		sheet.getColumn(index + 1).width = COLUMN_WIDTHS[word] ?? DEFAULT_COLUMN_WIDTH;
	}
}

/** Puts the two-word dropdown on every `peran` cell a file may use. */
function applyRoleDropdown(sheet: Worksheet): void {
	const column = IMPORT_HEADER.indexOf(ROLE_COLUMN) + 1;
	const rowCount = LAST_VALIDATED_ROW - FIRST_DATA_ROW + 1;

	for (const row of Array.from({ length: rowCount }, (_unused, index) => FIRST_DATA_ROW + index)) {
		sheet.getCell(row, column).dataValidation = {
			type: 'list',
			allowBlank: true,
			// One quoted, comma-separated string is how a literal list is written in a validation
			// formula; a bare `pemilik,penyewa` would be read as two cell references.
			formulae: [`"${IMPORT_ROLE_WORDS.join(',')}"`],
			showErrorMessage: true
		};
	}
}
