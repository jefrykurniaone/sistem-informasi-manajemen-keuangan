import { writeFileSync } from 'node:fs';
// A default import — see the note at the top of `src/lib/server/services/import/xlsx.ts`.
import ExcelJS from 'exceljs';
import { IMPORT_HEADER, IMPORT_ROLE_WORDS } from '../../src/lib/server/services/import/validation';

/**
 * Builds the two committed `.xlsx` fixtures the import tests read.
 *
 * Run it from the repository root with:
 *
 *     bun run tests/fixtures/build-resident-fixtures.ts
 *
 * It is committed, and its outputs are committed beside it, because a binary fixture nobody can read
 * is a fixture nobody can change. A test that fails on `residents-broken.xlsx` should send whoever
 * is reading it here, to a list of rows in plain text, rather than to a spreadsheet they have to
 * open in another program to understand.
 *
 * **The outputs are not byte-for-byte reproducible.** ExcelJS writes the workbook as a zip, and the
 * zip's per-entry timestamps come from the clock at the moment it is written. The workbook metadata
 * this script does control — creator, created, modified — is pinned below, so the *content* is
 * reproducible even though the bytes are not. Re-running this and committing the result is expected
 * to produce a diff of a few bytes with no change in meaning; do not re-run it without a reason.
 *
 * ## What each fixture is for
 *
 * - `residents-valid.xlsx` — a hundred rows nothing refuses, the size the spec says the feature is
 *   for. Its `nomor` column holds real numbers rather than text, which is what a spreadsheet stores
 *   when somebody types `12`, so the whole import proves the number-to-text conversion rather than
 *   only a unit test of it.
 * - `residents-broken.xlsx` — one row of every reason a file alone can refuse, plus two rows that
 *   are fine on their own so the tests have something to clash with stored data. The row numbers its
 *   tests assert are the positions of these rows, counting the header as row 1.
 *
 * `IMPORT_PROBLEM.malformedRow` is deliberately *not* among them: it needs a row with fewer than
 * five columns, and a sheet always hands over five. Nothing can build a workbook that produces it.
 */

const [OWNER, TENANT] = IMPORT_ROLE_WORDS;

/** Pinned, so two runs of this script differ only in the zip's own timestamps. */
const AUTHORED_AT = new Date('2026-01-01T00:00:00.000Z');
const AUTHOR = 'build-resident-fixtures';

/** The one sheet each fixture carries, named as the Template Impor names its own. */
const SHEET_NAME = 'Warga';

/** How many houses each block holds in the valid fixture, and how many blocks there are. */
const HOUSES_PER_BLOCK = 20;
const BLOCKS: readonly string[] = ['A', 'B', 'C', 'D', 'E'];

/** A cell of a fixture row: text, or a number where the fixture means a real numeric cell. */
type FixtureCell = string | number;

/**
 * The hundred rows nothing refuses.
 *
 * The last name carries a comma on purpose. It used to prove the old reader's quoting rules; it is
 * kept because a comma inside a cell is exactly the thing that stopped being special, and a fixture
 * that still carries one says so.
 */
function validRows(): readonly FixtureCell[][] {
	const rows: FixtureCell[][] = [];
	for (const [blockIndex, block] of BLOCKS.entries()) {
		for (let house = 1; house <= HOUSES_PER_BLOCK; house += 1) {
			const position = blockIndex * HOUSES_PER_BLOCK + house;
			const padded = String(position).padStart(3, '0');
			rows.push([
				block,
				house,
				position === BLOCKS.length * HOUSES_PER_BLOCK
					? 'Warga Impor 100, S.T.'
					: `Warga Impor ${padded}`,
				`warga${padded}@komplek.id`,
				position % 2 === 1 ? OWNER : TENANT
			]);
		}
	}
	return rows;
}

/**
 * One row of every refusal a file carries in itself, between two rows that are fine.
 *
 * Row 2 (`P-1`, `budi@komplek.id`) and row 14 (`V-12`) are the two clean ones. The tests that need a
 * clash with stored data register `V-12` as a unit, or `budi@komplek.id` as an account, and expect
 * exactly those two rows to be refused for it.
 */
const BROKEN_ROWS: readonly FixtureCell[][] = [
	// Row 2 — nothing wrong with it on its own.
	['P', '1', 'Budi Santoso', 'budi@komplek.id', OWNER],
	// Row 3 — missingBlock.
	['', '2', 'Tanpa Blok', 'tanpablok@komplek.id', OWNER],
	// Row 4 — missingNumber.
	['Q', '', 'Tanpa Nomor', 'tanpanomor@komplek.id', TENANT],
	// Row 5 — missingName.
	['R', '3', '', 'tanpanama@komplek.id', OWNER],
	// Row 6 — missingEmail.
	['R', '4', 'Tanpa Email', '', TENANT],
	// Row 7 — invalidEmail.
	['R', '5', 'Email Rusak', 'bukan-email', OWNER],
	// Row 8 — missingRole.
	['R', '6', 'Tanpa Peran', 'tanpaperan@komplek.id', ''],
	// Row 9 — unknownRole.
	['R', '7', 'Peran Tidak Dikenal', 'peranasing@komplek.id', 'juragan'],
	// Rows 10 and 11 — duplicateUnitInFile, both of them, on S-8.
	['S', '8', 'Rumah Kembar Satu', 'kembarsatu@komplek.id', OWNER],
	['S', '8', 'Rumah Kembar Dua', 'kembardua@komplek.id', TENANT],
	// Rows 12 and 13 — duplicateEmailInFile, both of them, on kembar@komplek.id.
	['T', '9', 'Email Kembar Satu', 'kembar@komplek.id', OWNER],
	['T', '10', 'Email Kembar Dua', 'kembar@komplek.id', TENANT],
	// Row 14 — nothing wrong with it on its own.
	['V', '12', 'Sudah Punya Akun', 'sudah@komplek.id', OWNER]
];

/** Writes one fixture: the header, then the given rows, on a single sheet. */
async function writeFixture(name: string, rows: readonly FixtureCell[][]): Promise<void> {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = AUTHOR;
	workbook.lastModifiedBy = AUTHOR;
	workbook.created = AUTHORED_AT;
	workbook.modified = AUTHORED_AT;

	const sheet = workbook.addWorksheet(SHEET_NAME);
	sheet.addRow([...IMPORT_HEADER]);
	for (const row of rows) {
		sheet.addRow([...row]);
	}

	const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
	writeFileSync(new URL(`./${name}`, import.meta.url), buffer);
	console.log(`wrote ${name}: ${rows.length} data rows, ${buffer.length} bytes`);
}

await writeFixture('residents-valid.xlsx', validRows());
await writeFixture('residents-broken.xlsx', BROKEN_ROWS);
