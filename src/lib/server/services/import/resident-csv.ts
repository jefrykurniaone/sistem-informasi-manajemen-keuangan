import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { occupancies } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { currentDay } from '../occupancy/visibility';
import { ensureDefaultSubscriptions } from '../subscription';
import {
	IMPORT_PROBLEM,
	unitKey,
	unitLabel,
	validateImportCsv,
	type ImportProblemReason,
	type ImportRowProblem,
	type ParsedImportRow
} from './validation';

/**
 * Filling the house register from a CSV file: a hundred houses and the people in them, in two steps.
 *
 * `spec-warga-unit-v1.md` asks for exactly this shape — "Unggah menghasilkan pratinjau … Baru setelah
 * dikonfirmasi, seluruh impor dijalankan dalam satu transaksi — semuanya masuk atau tidak sama
 * sekali" — and the reason it gives is the one this module is built around: a half-imported file of
 * hundreds of rows is almost impossible to clean up by hand, and the person who imported it is the
 * person least equipped to clean it.
 *
 * `./validation.ts` holds everything that can be decided from the file alone. This module adds the
 * two questions only stored data answers, and owns the write.
 *
 * ## Two steps, and nothing stored in between
 *
 * There is no staging table: this spec adds no migration, so the preview may not put a row anywhere.
 * The file's text therefore travels back to the server in a hidden field of the confirm form, and
 * **the confirm step re-parses and re-validates it from scratch**, exactly as if it had been
 * uploaded again. Nothing the preview computed is trusted on the way back — not the counts, not the
 * list of problems, not the rows. What comes out of a form is input, whoever put it there.
 *
 * Carrying the text rather than asking for the file a second time is a deliberate choice between the
 * two the ticket offered. Making the superuser pick the file again puts a second file-picker between
 * reading the preview and acting on it, which is precisely where the wrong file gets confirmed, and
 * it gives no safety in return: a second upload is re-validated the same way this text is. A hundred
 * rows is roughly six kilobytes, far below adapter-node's 512 KiB `BODY_SIZE_LIMIT`, and
 * `MAX_IMPORT_ROWS` in `./validation.ts` keeps it that way.
 *
 * A conflict that appears between the two steps — somebody else registers the house, or the address
 * gets an account — is found by that second validation and refused there, with `ImportRejectedError`
 * naming the rows. That is the whole point of re-validating rather than re-using the preview.
 *
 * ## What one valid row creates
 *
 * A row makes a Unit, an account, a Warga, their default Langganan, and a Masa Huni starting on the
 * day of the import:
 *
 * - **one better-auth `user` row**, with the name and address from the file, `emailVerified` false,
 *   and an id this module generates. **No `account` row**, which means no credential and no way to
 *   sign in: the address gets its password by accepting an Invitation, which is what also proves the
 *   address. Importing a password, or a blank one, would be handing out accounts nobody asked for.
 *   The `user_created_gets_resident_role_trigger` migration grants the `resident` role, so nothing
 *   here writes `user_roles`.
 * - **one `residents` row** — the domain's record of the person, which `residents.user_id`'s not-null
 *   reference makes impossible without the `user` row above.
 * - **the default Langganan**, through `ensureDefaultSubscriptions`, in this same transaction, so an
 *   imported resident is subscribed exactly like an invited one.
 * - **one `occupancies` row** on that unit, with the file's role and `startedOn` set to the import
 *   day. It is not marked Penanggung Jawab: the file does not say who that is, and `/admin/units`
 *   already lists every unit still missing one.
 *
 * ## One transaction, and one audit row
 *
 * Every insert above, for every row, plus the audit entry, happen inside one `db.transaction`. A
 * single failure anywhere takes the whole file back out — `tests/unit/import-csv.test.ts` proves the
 * row counts of all five tables return to what they were. The audit row is written inside the same
 * transaction, which is what makes it true rather than optimistic: it exists if and only if the
 * import did.
 */

/** The audit log's `action` for a completed CSV import. */
export const RESIDENTS_IMPORTED_ACTION = 'residents_imported';

/** Who is importing, which file they picked, and what is in it. */
export interface ResidentImportRequest {
	/** The user asking. Checked against `ACTION.importResidents` before anything else. */
	readonly actorId: string;
	/** The name of the uploaded file, recorded in the audit row. */
	readonly fileName: string;
	/** The file's text, as uploaded or as carried back by the confirm form. */
	readonly content: string;
}

/** What the superuser reads before deciding whether to confirm. Nothing here has been written. */
export interface ImportPreview {
	readonly fileName: string;
	/** The file's text, for the confirm form to carry back. Re-validated there, never trusted. */
	readonly content: string;
	/** How many rows would be imported. */
	readonly validRowCount: number;
	/** How many houses would be added to the register. */
	readonly newUnitCount: number;
	/** How many people would get a record and an account. */
	readonly newResidentCount: number;
	/** Every row that would not be imported, by line number, with every reason. */
	readonly problems: readonly ImportRowProblem[];
}

/** What a confirmed import did. */
export interface ResidentImportResult {
	/** The import's own identifier, which is the audit row's `targetId`. */
	readonly importId: string;
	/** How many rows were written. */
	readonly importedRowCount: number;
}

/**
 * Thrown by `importResidents` when the file still has a problem row at the moment of confirming.
 * Carries the same problems a preview would, because that is what the screen re-renders.
 *
 * It is a refusal of this particular file, not of the caller — the route answers it with
 * `fail(400, …)`, the distinction `src/lib/errors.ts` draws for `LastSuperuserError`.
 */
export class ImportRejectedError extends Error {
	override readonly name = 'ImportRejectedError';

	/**
	 * What the file looks like as of the refusal — the preview the screen re-renders. It is carried
	 * here rather than read again by the route: a third reading could answer differently from the one
	 * that refused, and a screen saying "the import was cancelled" beside an enabled confirm button
	 * is worse than either answer on its own.
	 */
	readonly preview: ImportPreview;

	constructor(preview: ImportPreview) {
		super(`The import file has ${preview.problems.length} row(s) that cannot be imported.`);
		this.preview = preview;
	}

	/** Every refused row, by line number. */
	get problems(): readonly ImportRowProblem[] {
		return this.preview.problems;
	}
}

/**
 * Reads the file and reports what importing it would do. **Writes nothing at all** — no row, no
 * audit entry, no staging table — which is the first half of the two-step rule.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {ImportHeaderError} when the header is not the one this import expects.
 * @throws {EmptyImportFileError} when the file carries no data row.
 * @throws {ImportTooLargeError} when it carries more rows than one import may write.
 */
export async function previewResidentImport(
	db: Database,
	request: ResidentImportRequest
): Promise<ImportPreview> {
	await requirePermission(db, request.actorId, ACTION.importResidents);

	const { rows, problems } = await examine(db, request.content);
	return asPreview(request, rows, problems);
}

/** One reading of a file, as the screen shows it. */
function asPreview(
	request: ResidentImportRequest,
	rows: readonly ParsedImportRow[],
	problems: readonly ImportRowProblem[]
): ImportPreview {
	return {
		fileName: request.fileName,
		content: request.content,
		validRowCount: rows.length,
		// Each importable row is one new house and one new person, because a house named twice and an
		// address written twice are both refused rows. The two counts are reported separately because
		// that is what the superuser is being asked to confirm, and because a later spec that lets a
		// household share a house would pull them apart.
		newUnitCount: rows.length,
		newResidentCount: rows.length,
		problems
	};
}

/**
 * Imports the whole file, or nothing.
 *
 * The content is validated again here, inside the transaction that writes it, and a single problem
 * row refuses the lot.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {ImportRejectedError} when any row of the file cannot be imported.
 * @throws {ImportHeaderError} when the header is not the one this import expects.
 * @throws {EmptyImportFileError} when the file carries no data row.
 * @throws {ImportTooLargeError} when it carries more rows than one import may write.
 */
export async function importResidents(
	db: Database,
	clock: Clock,
	request: ResidentImportRequest
): Promise<ResidentImportResult> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.importResidents);

		const { rows, problems } = await examine(transaction, request.content);
		if (problems.length > 0) {
			throw new ImportRejectedError(asPreview(request, rows, problems));
		}

		return writeImport(transaction, clock, request, rows);
	});
}

/** The file's own verdict, plus the two questions only the database answers. */
async function examine(
	reader: DatabaseWriter,
	content: string
): Promise<{ rows: readonly ParsedImportRow[]; problems: readonly ImportRowProblem[] }> {
	const validation = validateImportCsv(content);
	const conflicts = await findStoredConflicts(reader, validation.rows);

	return {
		rows: validation.rows.filter((_row, position) => !conflicts.has(position)),
		// Both lists are already in the file's own order, and a row never appears in both — the
		// database is only asked about rows the file itself accepted — so merging them is a matter of
		// keeping that order rather than of sorting by a line number two rows could share.
		problems: mergeInFileOrder(validation.problems, [...conflicts.values()])
	};
}

/**
 * The rows that clash with something already stored: a house already in the register, or an address
 * that already has an account.
 *
 * **Keyed by the row's position in `rows`, never by its line number.** A line number is not unique —
 * see `Candidate` in `./validation.ts` — and a map keyed by one would drop a conflict, or attach it
 * to the wrong row.
 */
async function findStoredConflicts(
	reader: DatabaseWriter,
	rows: readonly ParsedImportRow[]
): Promise<ReadonlyMap<number, ImportRowProblem>> {
	const conflicts = new Map<number, ImportRowProblem>();
	if (rows.length === 0) {
		return conflicts;
	}

	const [storedUnits, storedEmails] = await Promise.all([
		registeredUnitKeys(reader),
		registeredEmails(
			reader,
			rows.map((row) => row.email)
		)
	]);

	for (const [position, row] of rows.entries()) {
		const reasons: ImportProblemReason[] = [];
		if (storedUnits.has(unitKey(row.block, row.number))) {
			reasons.push({
				code: IMPORT_PROBLEM.unitAlreadyExists,
				value: unitLabel(row.block, row.number)
			});
		}
		if (storedEmails.has(row.email)) {
			reasons.push({ code: IMPORT_PROBLEM.emailAlreadyRegistered, value: row.email });
		}
		if (reasons.length > 0) {
			conflicts.set(position, { rowNumber: row.rowNumber, reasons });
		}
	}
	return conflicts;
}

/**
 * Two lists of problems, each already in the file's own order, interleaved back into one that still
 * is. Neither list is sorted by line number: two rows can share one, and sorting by it would let a
 * row appear before the row above it.
 */
function mergeInFileOrder(
	fromFile: readonly ImportRowProblem[],
	fromDatabase: readonly ImportRowProblem[]
): readonly ImportRowProblem[] {
	const merged: ImportRowProblem[] = [];
	let fileIndex = 0;
	let databaseIndex = 0;

	while (fileIndex < fromFile.length && databaseIndex < fromDatabase.length) {
		if (fromFile[fileIndex].rowNumber <= fromDatabase[databaseIndex].rowNumber) {
			merged.push(fromFile[fileIndex]);
			fileIndex += 1;
			continue;
		}
		merged.push(fromDatabase[databaseIndex]);
		databaseIndex += 1;
	}

	return [...merged, ...fromFile.slice(fileIndex), ...fromDatabase.slice(databaseIndex)];
}

/**
 * Every house already in the register, as `unitKey` writes one.
 *
 * The whole register is read rather than the hundred pairs the file names: "is any of these
 * block-and-number pairs taken" is a question about pairs, which SQL only answers with a row-value
 * `in` that Drizzle has no builder for, and the register is one row per house in the complex.
 */
async function registeredUnitKeys(reader: DatabaseWriter): Promise<ReadonlySet<string>> {
	const rows = await reader.select({ block: units.block, number: units.number }).from(units);
	return new Set(rows.map((row) => unitKey(row.block, row.number)));
}

/**
 * Whichever of `emails` already has an account, lowercased.
 *
 * The comparison is case-insensitive on both sides: `Budi@Komplek.id` and `budi@komplek.id` are one
 * address, and letting the second one through would hand the same person a second account that the
 * first one's owner can never sign into.
 *
 * **This is a read, and a read is not a constraint.** `user_email_unique` is on the raw column, so
 * two writers committing addresses that differ only in capitals would both pass this check and both
 * land. Closing that needs a unique index on `lower(email)`, which is a migration, and this spec
 * adds none. Until it exists, the rule holds for every import that does not race another writer,
 * and the import itself always lowercases what it stores.
 */
async function registeredEmails(
	reader: DatabaseWriter,
	emails: readonly string[]
): Promise<ReadonlySet<string>> {
	const lowercased = sql<string>`lower(${user.email})`;
	const rows = await reader
		.select({ email: lowercased })
		.from(user)
		.where(inArray(lowercased, [...emails]));
	return new Set(rows.map((row) => row.email));
}

/** Writes every row of the file, and the one audit entry that records the import. */
async function writeImport(
	transaction: Transaction,
	clock: Clock,
	request: ResidentImportRequest,
	rows: readonly ParsedImportRow[]
): Promise<ResidentImportResult> {
	const now = clock.now();
	const unitIdByKey = await insertUnits(transaction, rows, now);
	const residentIds = await insertResidents(transaction, clock, rows, now);
	await insertOccupancies(transaction, clock, rows, unitIdByKey, residentIds, now);

	// The audit log wants one row per thing that happened, and what happened here is one import — not
	// a hundred unrelated houses. `targetId` is therefore the import's own identifier, generated here
	// and handed back, so `auditEntriesFor(db, importId)` reads exactly this entry.
	const importId = randomUUID();
	await recordAuditEntry(transaction, clock, {
		actorId: request.actorId,
		action: RESIDENTS_IMPORTED_ACTION,
		targetId: importId,
		after: { fileName: request.fileName, importedRowCount: rows.length }
	});

	return { importId, importedRowCount: rows.length };
}

/** Inserts every house in one statement, and says which id each row's house got. */
async function insertUnits(
	transaction: Transaction,
	rows: readonly ParsedImportRow[],
	now: Date
): Promise<ReadonlyMap<string, string>> {
	const inserted = await transaction
		.insert(units)
		.values(rows.map((row) => ({ block: row.block, number: row.number, createdAt: now })))
		.returning({ id: units.id, block: units.block, number: units.number });

	return new Map(inserted.map((unit) => [unitKey(unit.block, unit.number), unit.id]));
}

/**
 * Inserts an account and a `residents` row for every row of the file, then the default Langganan of
 * each one, and answers with the `residents.id` of each row **in the same order as `rows`**.
 *
 * A list rather than a map keyed by the row's line number: a line number is not unique — see
 * `Candidate` in `./validation.ts` — and keying by one collapsed two rows into a single resident,
 * which would attach both of their houses to the same person.
 *
 * The accounts and the resident records go in one statement each; the Langganan are one call per
 * resident, because `ensureDefaultSubscriptions` is the one place that knows the default set and
 * this module has no business rebuilding it. The inserted rows are matched back by `userId` rather
 * than by position: an insert's `returning` order is not something to lean on.
 */
async function insertResidents(
	transaction: Transaction,
	clock: Clock,
	rows: readonly ParsedImportRow[],
	now: Date
): Promise<readonly string[]> {
	const accounts = rows.map((row) => ({
		id: randomUUID(),
		name: row.name,
		email: row.email
	}));

	await transaction.insert(user).values(
		accounts.map((account) => ({
			id: account.id,
			name: account.name,
			email: account.email,
			emailVerified: false,
			createdAt: now,
			updatedAt: now
		}))
	);

	const inserted = await transaction
		.insert(residents)
		.values(accounts.map((account) => ({ userId: account.id, createdAt: now })))
		.returning({ id: residents.id, userId: residents.userId });

	const residentIdByUserId = new Map(inserted.map((resident) => [resident.userId, resident.id]));
	for (const resident of inserted) {
		await ensureDefaultSubscriptions(transaction, clock, resident.id);
	}

	return accounts.map((account) =>
		required(residentIdByUserId.get(account.id), `resident row for account ${account.id}`)
	);
}

/** Attaches every person to their house, from the day of the import. */
async function insertOccupancies(
	transaction: Transaction,
	clock: Clock,
	rows: readonly ParsedImportRow[],
	unitIdByKey: ReadonlyMap<string, string>,
	residentIds: readonly string[],
	now: Date
): Promise<void> {
	const startedOn = currentDay(clock);
	await transaction.insert(occupancies).values(
		rows.map((row, position) => ({
			unitId: required(
				unitIdByKey.get(unitKey(row.block, row.number)),
				`unit for row ${row.rowNumber}`
			),
			// By position in `rows`, which is how `insertResidents` answered — never by line number.
			residentId: required(residentIds[position], `resident for row ${row.rowNumber}`),
			role: row.role,
			startedOn,
			endedOn: null,
			isPrimaryOccupant: false,
			createdAt: now
		}))
	);
}

/**
 * `value`, or a failure naming what was missing.
 *
 * @throws {TypeError} when `value` is `undefined`, which means a row this module just inserted came
 *   back without the key it was inserted under — a broken assumption, not a rejected file.
 */
function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) {
		throw new TypeError(`The import lost track of the ${what} it had just written.`);
	}
	return value;
}
