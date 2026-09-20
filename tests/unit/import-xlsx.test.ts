import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
// A default import — see the note at the top of `src/lib/server/services/import/xlsx.ts`.
import ExcelJS, { type CellValue } from 'exceljs';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { auditLog } from '$lib/server/db/schema/audit';
import { account, user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { OCCUPANCY_ROLE, occupancies } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { subscriptions } from '$lib/server/db/schema/subscription';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import type { Clock } from '$lib/server/ports/clock';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	ImportRejectedError,
	RESIDENTS_IMPORTED_ACTION,
	importResidents,
	previewResidentImport
} from '$lib/server/services/import/resident-import';
import { readResidentRows } from '$lib/server/services/import/xlsx';
import {
	IMPORT_HEADER,
	IMPORT_PROBLEM,
	ImportHeaderError
} from '$lib/server/services/import/validation';
import { SUBSCRIPTION_KINDS } from '$lib/server/services/subscription/kinds';

/**
 * Reading an uploaded workbook, and the two-step import that follows it against a real PostgreSQL:
 * what a cell becomes, which rows and sheets are read at all, who may import, that a preview stores
 * nothing, the two refusals only stored data can see, what one confirmed row creates, and that a
 * failure partway through leaves the database exactly as it was.
 *
 * `tests/unit/import-validation.test.ts` already proves every refusal a row carries in itself; this
 * file does not repeat them.
 */

const testDb = testDatabase();

const START = '2026-03-05T08:00:00.000Z';
/** The day `START` falls on, which is the day an import gives every Masa Huni it records. */
const IMPORT_DAY = '2026-03-05';

/** The committed file of a hundred good rows. */
const VALID_FIXTURE = 'residents-valid.xlsx';
/** The committed file carrying one row of every kind of problem. */
const BROKEN_FIXTURE = 'residents-broken.xlsx';

/** The sheet name the Template Impor uses, and therefore the one every fixture here uses. */
const SHEET_NAME = 'Warga';

/** A file name for the tests that only need the audit row to carry one. */
const UPLOADED_NAME = 'warga.xlsx';

/** One sheet of a workbook this file builds: its name and its rows, header included. */
interface SheetSpec {
	readonly name: string;
	readonly rows: readonly (readonly CellValue[])[];
}

/** Makes every block this file writes different from every other one, and from the fixtures'. */
let sequence = 0;
function uniqueBlock(): string {
	sequence += 1;
	return `Z${sequence}`;
}

/** The committed fixture named by `name`, read as the upload would hand it over. */
function fixture(name: string): Buffer {
	return readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
}

/** The bytes of a workbook carrying the given sheets, in the given order. */
async function workbookOf(sheets: readonly SheetSpec[]): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	for (const sheet of sheets) {
		const added = workbook.addWorksheet(sheet.name);
		for (const row of sheet.rows) {
			added.addRow([...row]);
		}
	}
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A one-sheet workbook: the header this import expects, then the given data rows. */
async function sheetOf(...rows: readonly (readonly CellValue[])[]): Promise<Buffer> {
	return workbookOf([{ name: SHEET_NAME, rows: [[...IMPORT_HEADER], ...rows] }]);
}

/** A file of `rows` houses in one block, with addresses nothing else in this file uses. */
async function fileOf(block: string, rows: number): Promise<Buffer> {
	return sheetOf(
		...Array.from({ length: rows }, (_unused, index) => [
			block,
			index + 1,
			`Warga ${block} ${index + 1}`,
			`warga.${block.toLowerCase()}.${index + 1}@komplek.id`,
			index % 2 === 0 ? 'pemilik' : 'penyewa'
		])
	);
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any real sign-up. */
async function insertUser(name: string, email = `${randomUUID()}@komplek.local`): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db
		.insert(user)
		.values({ id, name, email, emailVerified: true, createdAt: now, updatedAt: now });
	return id;
}

/** A superuser, ready to act as `actorId` in every test that needs one who may import. */
async function insertSuperuser(name: string): Promise<string> {
	const id = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId: id, role: ROLE.superuser, createdAt: new Date(START) });
	return id;
}

/** How many rows one table holds right now. */
async function countRows(table: PgTable): Promise<number> {
	const [row] = await testDb.db.select({ value: count() }).from(table);
	return row.value;
}

/** Every table an import writes to, counted — the shape the rollback proof compares. */
async function rowCounts(): Promise<Record<string, number>> {
	return {
		units: await countRows(units),
		users: await countRows(user),
		residents: await countRows(residents),
		occupancies: await countRows(occupancies),
		subscriptions: await countRows(subscriptions),
		auditEntries: await countRows(auditLog)
	};
}

/** The message `FailingClock` throws, so a test can tell its own failure from a real one. */
const CLOCK_FAILURE = 'the clock stopped partway through the import';

/**
 * A clock that answers a few times and then throws — a write that fails after earlier statements of
 * the same transaction have already succeeded.
 *
 * It is the failure this file injects because every conflict the *file* carries is caught by the
 * validation that runs before a single row is written, and the rule under test here is the other
 * one: what the database looks like when something goes wrong in the middle of the writing.
 */
class FailingClock implements Clock {
	#answersLeft: number;

	constructor(answersLeft: number) {
		this.#answersLeft = answersLeft;
	}

	now(): Date {
		if (this.#answersLeft <= 0) {
			throw new Error(CLOCK_FAILURE);
		}
		this.#answersLeft -= 1;
		return new Date(START);
	}
}

/** Every reason code recorded against `rowNumber` in a preview. */
function codesAt(
	problems: readonly { rowNumber: number; reasons: readonly { code: string }[] }[],
	rowNumber: number
): readonly string[] {
	const problem = problems.find((row) => row.rowNumber === rowNumber);
	return (problem?.reasons ?? []).map((reason) => reason.code);
}

/** What one cell holds, and the text `readResidentRows` is expected to read it as. */
const CELL_CASES: readonly (readonly [string, CellValue, string])[] = [
	['a whole number without decimals', 12, '12'],
	['a number that has decimals', 12.5, '12.5'],
	['a boolean', true, 'true'],
	['a date, as an ISO day', new Date('2026-03-05T00:00:00.000Z'), '2026-03-05'],
	['a formula, as its cached result', { formula: 'B2&""', result: 'Budi Santoso' }, 'Budi Santoso'],
	[
		'rich text, as its runs joined',
		{ richText: [{ text: 'Budi ' }, { text: 'Santoso' }] },
		'Budi Santoso'
	],
	[
		'a hyperlink, as the text it shows',
		{ text: 'budi@komplek.id', hyperlink: 'mailto:budi@komplek.id' },
		'budi@komplek.id'
	],
	['an error, as nothing at all', { error: '#N/A' }, ''],
	['an empty cell, as nothing at all', null, ''],
	['text with stray spaces, trimmed', '  Budi Santoso  ', 'Budi Santoso']
];

describe('readResidentRows, what a cell becomes', () => {
	it.each(CELL_CASES)('reads %s', async (_description, written, expected) => {
		const [first] = await readResidentRows(
			await sheetOf(['A', '1', written, 'budi@komplek.id', 'pemilik'])
		);

		expect(first[2]).toBe(expected);
	});
});

describe('readResidentRows, which rows and sheets it reads', () => {
	it('skips a row whose every cell is empty, and does not let it shift the rows after it', async () => {
		const rows = await readResidentRows(
			await sheetOf(
				['A', 1, 'Budi', 'budi@komplek.id', 'pemilik'],
				['', '', '', '', ''],
				['A', 2, 'Sari', 'sari@komplek.id', 'penyewa']
			)
		);

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row[2])).toEqual(['Budi', 'Sari']);
	});

	it('reads the first sheet only, ignoring every sheet after it', async () => {
		const buffer = await workbookOf([
			{
				name: SHEET_NAME,
				rows: [[...IMPORT_HEADER], ['A', 1, 'Budi', 'budi@komplek.id', 'pemilik']]
			},
			{
				name: 'Catatan',
				rows: [[...IMPORT_HEADER], ['B', 2, 'Sari', 'sari@komplek.id', 'penyewa']]
			}
		]);

		const rows = await readResidentRows(buffer);

		expect(rows).toHaveLength(1);
		expect(rows[0][2]).toBe('Budi');
	});

	it('refuses a header whose columns are in the wrong order, naming the ones it wants', async () => {
		const buffer = await workbookOf([
			{ name: SHEET_NAME, rows: [['nomor', 'blok', 'nama', 'email', 'peran']] }
		]);

		await expect(readResidentRows(buffer)).rejects.toThrow(ImportHeaderError);
		await expect(readResidentRows(buffer)).rejects.toThrow('blok,nomor,nama,email,peran');
	});

	it('refuses a header written in another language', async () => {
		const buffer = await workbookOf([
			{ name: SHEET_NAME, rows: [['block', 'number', 'name', 'email', 'role']] }
		]);

		await expect(readResidentRows(buffer)).rejects.toThrow(ImportHeaderError);
	});

	it('accepts a header written in capitals and with stray spaces around it', async () => {
		const buffer = await workbookOf([
			{
				name: SHEET_NAME,
				rows: [
					[' BLOK ', ' Nomor ', 'NAMA', 'Email', ' Peran '],
					['A', 1, 'Budi', 'budi@komplek.id', 'pemilik']
				]
			}
		]);

		expect(await readResidentRows(buffer)).toHaveLength(1);
	});

	it('refuses a header carrying a sixth column, however its first five read', async () => {
		const buffer = await workbookOf([{ name: SHEET_NAME, rows: [[...IMPORT_HEADER, 'catatan']] }]);

		await expect(readResidentRows(buffer)).rejects.toThrow(ImportHeaderError);
	});
});

describe('permission', () => {
	it('refuses a preview asked for by someone who is not a superuser', async () => {
		const actorId = await insertUser('Warga Penasaran Impor');

		await expect(
			previewResidentImport(testDb.db, {
				actorId,
				fileName: UPLOADED_NAME,
				content: await fileOf(uniqueBlock(), 1)
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	it('refuses an import asked for by someone who is not a superuser, and writes nothing', async () => {
		const actorId = await insertUser('Warga Coba Impor');
		const before = await rowCounts();

		await expect(
			importResidents(testDb.db, new FakeClock(START), {
				actorId,
				fileName: UPLOADED_NAME,
				content: await fileOf(uniqueBlock(), 1)
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await rowCounts()).toEqual(before);
	});
});

describe('previewResidentImport', () => {
	it('counts the valid rows, the new units and the new residents of a hundred-row file', async () => {
		const actorId = await insertSuperuser('Pengurus Pratinjau Seratus');

		const preview = await previewResidentImport(testDb.db, {
			actorId,
			fileName: VALID_FIXTURE,
			content: fixture(VALID_FIXTURE)
		});

		expect(preview).toMatchObject({
			fileName: VALID_FIXTURE,
			validRowCount: 100,
			newUnitCount: 100,
			newResidentCount: 100,
			problems: []
		});
	});

	it('stores nothing at all, in any table', async () => {
		const actorId = await insertSuperuser('Pengurus Pratinjau Tanpa Simpan');
		const before = await rowCounts();

		await previewResidentImport(testDb.db, {
			actorId,
			fileName: VALID_FIXTURE,
			content: fixture(VALID_FIXTURE)
		});

		expect(await rowCounts()).toEqual(before);
	});

	it('names a house that is already in the register, and an address that already has an account', async () => {
		const actorId = await insertSuperuser('Pengurus Pratinjau Bentrok');
		// Row 14 of the broken fixture names V-12, and row 2 carries budi@komplek.id. The stored
		// address is written in capitals on purpose: the two are one address.
		await testDb.db.insert(units).values({ block: 'V', number: '12', createdAt: new Date(START) });
		await insertUser('Budi Sudah Terdaftar', 'BUDI@Komplek.ID');

		const preview = await previewResidentImport(testDb.db, {
			actorId,
			fileName: BROKEN_FIXTURE,
			content: fixture(BROKEN_FIXTURE)
		});

		expect(codesAt(preview.problems, 2)).toContain(IMPORT_PROBLEM.emailAlreadyRegistered);
		expect(codesAt(preview.problems, 14)).toContain(IMPORT_PROBLEM.unitAlreadyExists);
		expect(preview.validRowCount).toBe(0);
	});

	it('carries the file back as base64, so the confirm step can read the same bytes again', async () => {
		const actorId = await insertSuperuser('Pengurus Pratinjau Isi Berkas');
		const content = await fileOf(uniqueBlock(), 2);

		const preview = await previewResidentImport(testDb.db, {
			actorId,
			fileName: UPLOADED_NAME,
			content
		});

		expect(preview.content).toBe(content.toString('base64'));
		// The round trip is what the confirm action does, and it has to give back the same bytes: a
		// workbook is a zip, and a single byte changed makes it unreadable rather than merely wrong.
		expect(Buffer.from(preview.content, 'base64')).toEqual(content);
	});
});

describe('importResidents, what one confirmed row creates', () => {
	it('writes the unit, the account, the resident, their subscriptions and the occupancy', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Satu Baris');
		const block = uniqueBlock();
		// The address is written in capitals on purpose: it is stored lowercased. The house number is
		// a real numeric cell, which is what a spreadsheet stores when somebody types 7.
		const content = await sheetOf([
			block,
			7,
			'Budi Santoso',
			`Budi.${block}@Komplek.ID`,
			'penyewa'
		]);

		const result = await importResidents(testDb.db, new FakeClock(START), {
			actorId,
			fileName: UPLOADED_NAME,
			content
		});

		const [unit] = await testDb.db.select().from(units).where(eq(units.block, block));
		const [account_] = await testDb.db
			.select()
			.from(user)
			.where(eq(user.email, `budi.${block.toLowerCase()}@komplek.id`));
		const [resident] = await testDb.db
			.select()
			.from(residents)
			.where(eq(residents.userId, account_.id));
		const [occupancy] = await testDb.db
			.select()
			.from(occupancies)
			.where(eq(occupancies.residentId, resident.id));

		expect(result.importedRowCount).toBe(1);
		// `'7'` and never `'7.0'`: the numeric cell became the text the register stores.
		expect(unit).toMatchObject({ block, number: '7', isActive: true });
		// The address is stored lowercased, and the account cannot sign in until an invitation is
		// accepted — hence `emailVerified` false here and no `account` row at all below.
		expect(account_).toMatchObject({ name: 'Budi Santoso', emailVerified: false });
		expect(occupancy).toMatchObject({
			unitId: unit.id,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: IMPORT_DAY,
			endedOn: null,
			isPrimaryOccupant: false
		});
	});

	it('creates no credential, so an imported resident cannot sign in yet', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Tanpa Kata Sandi');

		await importResidents(testDb.db, new FakeClock(START), {
			actorId,
			fileName: UPLOADED_NAME,
			content: await fileOf(uniqueBlock(), 2)
		});

		// Nothing in this test file ever writes one, so the whole table is the assertion.
		expect(await countRows(account)).toBe(0);
	});

	it('leaves the resident role to the database trigger, and writes the default subscriptions', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Peran Dan Langganan');
		const block = uniqueBlock();

		await importResidents(testDb.db, new FakeClock(START), {
			actorId,
			fileName: UPLOADED_NAME,
			content: await fileOf(block, 1)
		});

		const [imported] = await testDb.db
			.select()
			.from(user)
			.where(eq(user.email, `warga.${block.toLowerCase()}.1@komplek.id`));
		const roles = await testDb.db
			.select({ role: userRoles.role })
			.from(userRoles)
			.where(eq(userRoles.userId, imported.id));
		const [resident] = await testDb.db
			.select()
			.from(residents)
			.where(eq(residents.userId, imported.id));
		const kinds = await testDb.db
			.select({ kind: subscriptions.kind })
			.from(subscriptions)
			.where(eq(subscriptions.residentId, resident.id));

		expect(roles.map((row) => row.role)).toEqual([ROLE.resident]);
		expect(kinds.map((row) => row.kind).sort()).toEqual(
			SUBSCRIPTION_KINDS.map((definition) => definition.kind).sort()
		);
	});

	it('records one audit row naming the actor, the file and how many rows went in', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Jejak Audit');
		const before = await rowCounts();

		const result = await importResidents(testDb.db, new FakeClock(START), {
			actorId,
			fileName: 'warga-maret.xlsx',
			content: await fileOf(uniqueBlock(), 3)
		});

		const entries = await auditEntriesFor(testDb.db, result.importId);

		expect(entries).toHaveLength(1);
		// One row for the whole import, not one per imported row: the count of the whole table, not
		// only of the rows carrying this import's own target id.
		expect((await rowCounts()).auditEntries).toBe(before.auditEntries + 1);
		expect(entries[0]).toMatchObject({
			actorId,
			action: RESIDENTS_IMPORTED_ACTION,
			occurredAt: new Date(START),
			after: { fileName: 'warga-maret.xlsx', importedRowCount: 3 }
		});
	});
});

describe('importResidents, all or nothing', () => {
	it('refuses a file with a broken row and stores none of its good rows either', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Berkas Rusak');
		const before = await rowCounts();

		await expect(
			importResidents(testDb.db, new FakeClock(START), {
				actorId,
				fileName: BROKEN_FIXTURE,
				content: fixture(BROKEN_FIXTURE)
			})
		).rejects.toThrow(ImportRejectedError);

		expect(await rowCounts()).toEqual(before);
	});

	it('refuses a house registered between the preview and the confirmation, naming its row', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Bentrok Di Tengah');
		const block = uniqueBlock();
		const request = { actorId, fileName: UPLOADED_NAME, content: await fileOf(block, 3) };
		const preview = await previewResidentImport(testDb.db, request);
		expect(preview.problems).toEqual([]);

		await testDb.db.insert(units).values({ block, number: '3', createdAt: new Date(START) });
		const before = await rowCounts();
		const rejection = await importResidents(testDb.db, new FakeClock(START), request).catch(
			(caught: unknown) => caught
		);

		expect(rejection).toBeInstanceOf(ImportRejectedError);
		expect(codesAt((rejection as ImportRejectedError).problems, 4)).toContain(
			IMPORT_PROBLEM.unitAlreadyExists
		);
		expect(await rowCounts()).toEqual(before);
	});

	it('puts every table back as it was when a write fails partway through', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Gagal Di Tengah');
		const before = await rowCounts();

		// Two answers is enough for the timestamp of the batch inserts and the first resident's
		// subscriptions; the second resident's call is where it stops, with units, accounts and
		// resident rows already written inside the transaction.
		await expect(
			importResidents(testDb.db, new FailingClock(2), {
				actorId,
				fileName: UPLOADED_NAME,
				content: await fileOf(uniqueBlock(), 3)
			})
		).rejects.toThrow(CLOCK_FAILURE);

		expect(await rowCounts()).toEqual(before);
	});
});

describe('importResidents, a hundred rows', () => {
	it('writes the whole file well inside one request', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Seratus Baris');
		const before = await rowCounts();

		const startedAt = Date.now();
		const result = await importResidents(testDb.db, new FakeClock(START), {
			actorId,
			fileName: VALID_FIXTURE,
			content: fixture(VALID_FIXTURE)
		});
		const elapsed = Date.now() - startedAt;

		const after = await rowCounts();
		expect(result.importedRowCount).toBe(100);
		expect(after.units).toBe(before.units + 100);
		expect(after.users).toBe(before.users + 100);
		expect(after.residents).toBe(before.residents + 100);
		expect(after.occupancies).toBe(before.occupancies + 100);
		expect(after.subscriptions).toBe(before.subscriptions + 100 * SUBSCRIPTION_KINDS.length);
		expect(elapsed).toBeLessThan(10_000);
	});

	it('gives every row its own resident, attached to the house that row named', async () => {
		const actorId = await insertSuperuser('Pengurus Impor Pasangan Baris');
		const block = uniqueBlock();

		await importResidents(testDb.db, new FakeClock(START), {
			actorId,
			fileName: UPLOADED_NAME,
			content: await fileOf(block, 20)
		});

		const written = await testDb.db
			.select({
				residentId: occupancies.residentId,
				number: units.number,
				email: user.email
			})
			.from(occupancies)
			.innerJoin(units, eq(units.id, occupancies.unitId))
			.innerJoin(residents, eq(residents.id, occupancies.residentId))
			.innerJoin(user, eq(user.id, residents.userId))
			.where(eq(units.block, block));

		expect(written).toHaveLength(20);
		// Twenty distinct people, and each one living in the house their own line named — the pairing
		// a resident map keyed by a line number silently got wrong.
		expect(new Set(written.map((row) => row.residentId)).size).toBe(20);
		for (const row of written) {
			expect(row.email).toBe(`warga.${block.toLowerCase()}.${row.number}@komplek.id`);
		}
	});
});
