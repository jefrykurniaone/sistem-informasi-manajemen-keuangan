import { OCCUPANCY_ROLE, type OccupancyRole } from '../../db/schema/occupancy';

/**
 * Deciding, without a database, which rows of an uploaded import file are usable.
 *
 * This module is deliberately pure: it is handed the file's rows as text and checks every field a
 * row carries on its own, then finds the repeats a row only has because of another row in the same
 * file. Turning an uploaded workbook into those rows belongs to `./xlsx.ts`, and the two questions
 * that need stored data — "does this house already exist" and "does this address already have an
 * account" — belong to `./resident-import.ts`, which asks them of a database and appends its answers
 * to the same list of problems. Splitting it this way is what lets the whole reporting format be
 * tested without a connection or a workbook, and it keeps the reading, the checking and the writing
 * in three separate places, as the ticket's quality rules ask.
 *
 * ## What a problem looks like, and why it is a code rather than a sentence
 *
 * A problem is `{ rowNumber, reasons }`, and a reason is `{ code, value }` — never a ready-made
 * sentence. Every word a superuser reads is Indonesian and lives in `messages/id.json` under the
 * `adminImport_` prefix, so the service may not build one: it would be an English string on a screen,
 * or a second catalogue nobody translates. The screen maps a code to a message and fills `{value}`
 * with whichever block, address or word the row actually carried.
 *
 * **`rowNumber` is derived from the row's position, not from any number the file itself carries.**
 * It counts the header as line 1, so the first data row is line 2, which is the line a spreadsheet
 * shows beside a file whose rows run without gaps. A row the reader skipped — one whose cells were
 * all empty — shifts every row after it, so the number is where the row sits in the import rather
 * than where it sat in the sheet. Sending someone to the row of the import they must fix is the
 * useful answer; a sheet coordinate would be exact about a row nobody is being asked about.
 *
 * ## Every row of a repeated pair is a problem, not just the second one
 *
 * When two rows name the same house, both are refused. Keeping the first and refusing the second
 * would import one of two rows that contradict each other, chosen by their order in the file, and
 * the superuser would have no reason to look at the row that was kept. The same holds for a repeated
 * email address.
 *
 * ## The header is the file's contract
 *
 * `blok,nomor,nama,email,peran` — Indonesian, because a superuser writes this file in a spreadsheet,
 * and the columns are their words rather than the schema's. A file whose header is anything else is
 * refused whole, with `ImportHeaderError`, rather than reported row by row: every row of it would be
 * wrong for the same reason, and a hundred identical problems say less than one. The header is read
 * and checked in `./xlsx.ts`, which is the only place that has the file; the error and the constant
 * live here, with the rest of the contract.
 */

/** The header row every import file must start with, in this order. */
export const IMPORT_HEADER: readonly string[] = ['blok', 'nomor', 'nama', 'email', 'peran'];

/**
 * One data row of the import file: its columns as text, in the header's order.
 *
 * A bare list of strings, so that **a row's identity is its position in the list and nothing else**.
 * Nothing here is keyed by a line number or a sheet coordinate: neither is unique once empty rows
 * are skipped, and a map keyed by one would merge two rows into a single resident, attaching both of
 * their houses to the same person.
 */
export type ImportRow = readonly string[];

/**
 * The largest number of data rows one file may carry. The spec sizes the feature at a hundred rows;
 * this is far above that and still refuses a file that would hold a transaction open over thousands
 * of statements.
 */
export const MAX_IMPORT_ROWS = 500;

/** Why one row of the file cannot be imported. The screen turns each of these into a sentence. */
export const IMPORT_PROBLEM = {
	/**
	 * The row does not have the five columns the header promises.
	 *
	 * Nothing emits this today: `readResidentRows` reads a grid, and a grid always hands over exactly
	 * `IMPORT_HEADER.length` cells for every row, filling the ones the sheet left out with `''`. The
	 * code and its check are kept because this module is a pure function over rows from any source,
	 * and because a screen that already translates the code should keep doing so.
	 */
	malformedRow: 'malformedRow',
	missingBlock: 'missingBlock',
	missingNumber: 'missingNumber',
	missingName: 'missingName',
	missingEmail: 'missingEmail',
	/** The address is not shaped like an email address. Carries what was written. */
	invalidEmail: 'invalidEmail',
	missingRole: 'missingRole',
	/** The occupancy role is not `pemilik` or `penyewa`. Carries what was written. */
	unknownRole: 'unknownRole',
	/** Another row of the same file names the same house. Carries the block and number. */
	duplicateUnitInFile: 'duplicateUnitInFile',
	/** Another row of the same file carries the same address. Carries the address. */
	duplicateEmailInFile: 'duplicateEmailInFile',
	/** The house is already in the register. Carries the block and number. */
	unitAlreadyExists: 'unitAlreadyExists',
	/** The address already has an account. Carries the address. */
	emailAlreadyRegistered: 'emailAlreadyRegistered'
} as const;

/** One of the reasons above. */
export type ImportProblemCode = (typeof IMPORT_PROBLEM)[keyof typeof IMPORT_PROBLEM];

/** One reason a row was refused, together with whatever of the row the message quotes back. */
export interface ImportProblemReason {
	readonly code: ImportProblemCode;
	/** The block and number, the address, or the word the row carried. Empty when the code needs none. */
	readonly value: string;
}

/** One refused row: which line of the file it is, and every reason it was refused. */
export interface ImportRowProblem {
	/** The line of the file, counting the header as line 1. */
	readonly rowNumber: number;
	readonly reasons: readonly ImportProblemReason[];
}

/** One row of the file that carries nothing wrong with it, ready to be written. */
export interface ParsedImportRow {
	/** The line of the file, counting the header as line 1. */
	readonly rowNumber: number;
	readonly block: string;
	readonly number: string;
	/** The resident's name, as it will be written to `user.name`. */
	readonly name: string;
	/** Lowercased and trimmed — see `normalizeEmail`. */
	readonly email: string;
	readonly role: OccupancyRole;
}

/** What one file adds up to before a database has seen it. */
export interface ImportValidation {
	/** Every row nothing in the file itself refuses, in the order the file lists them. */
	readonly rows: readonly ParsedImportRow[];
	/** Every refused row, by line number. */
	readonly problems: readonly ImportRowProblem[];
}

/**
 * Thrown when the file's first row is not the header this import expects. Whole-file, not per-row:
 * see this module's doc comment.
 */
export class ImportHeaderError extends Error {
	override readonly name = 'ImportHeaderError';

	/** The header the file actually carried, as its columns were written. */
	readonly actualHeader: readonly string[];

	constructor(actualHeader: readonly string[]) {
		super(
			`The import file must start with the header "${IMPORT_HEADER.join(',')}", not "${actualHeader.join(',')}".`
		);
		this.actualHeader = actualHeader;
	}
}

/** Thrown when the file holds a header and nothing else, or nothing at all. */
export class EmptyImportFileError extends Error {
	override readonly name = 'EmptyImportFileError';

	constructor() {
		super('The import file carries no data rows at all.');
	}
}

/** Thrown when the file carries more rows than one import may write. */
export class ImportTooLargeError extends Error {
	override readonly name = 'ImportTooLargeError';

	/** How many data rows the file carries. */
	readonly rowCount: number;
	/** The most one file may carry, `MAX_IMPORT_ROWS`. */
	readonly maximum: number;

	constructor(rowCount: number) {
		super(`The import file carries ${rowCount} rows, more than the ${MAX_IMPORT_ROWS} allowed.`);
		this.rowCount = rowCount;
		this.maximum = MAX_IMPORT_ROWS;
	}
}

/**
 * The Indonesian words a superuser writes in the `peran` column, in the order the Template Impor
 * offers them.
 *
 * Exported because the template's dropdown is built from it. A template offering a word this module
 * refuses would be a file the import itself told the superuser to write, so there is one list and
 * the table below is keyed off it.
 */
export const IMPORT_ROLE_WORDS = ['pemilik', 'penyewa'] as const;

/** What each of those words means. */
const ROLE_BY_INDONESIAN_WORD: Readonly<Record<string, OccupancyRole | undefined>> = {
	[IMPORT_ROLE_WORDS[0]]: OCCUPANCY_ROLE.owner,
	[IMPORT_ROLE_WORDS[1]]: OCCUPANCY_ROLE.tenant
};

/** The header occupies the first line of the file, so the first data row is the second. */
const FIRST_DATA_ROW_NUMBER = 2;

/**
 * Reads every row of a file and says which are usable and which are not.
 *
 * @throws {EmptyImportFileError} when there is no data row at all.
 * @throws {ImportTooLargeError} when there are more than `MAX_IMPORT_ROWS` of them.
 */
export function validateImportRows(rows: readonly ImportRow[]): ImportValidation {
	if (rows.length === 0) {
		throw new EmptyImportFileError();
	}
	if (rows.length > MAX_IMPORT_ROWS) {
		throw new ImportTooLargeError(rows.length);
	}

	const reasonsByPosition = new Map<number, ImportProblemReason[]>();
	const candidates = rows.map((row, position) => readCandidate(row, position, reasonsByPosition));
	flagRepeats(candidates, reasonsByPosition);

	return {
		rows: candidates
			.filter((candidate) => !reasonsByPosition.has(candidate.position))
			.map(asParsedRow),
		problems: collectProblems(candidates, reasonsByPosition)
	};
}

/**
 * The key two rows naming the same house share. Not shown to anyone — see `unitLabel` for that.
 *
 * `JSON.stringify` of the pair rather than the two joined by a separator: a block and a number are
 * free text, so any separator could appear inside one of them and make `A-1` and `A` `-1` the same
 * house.
 */
export function unitKey(block: string, number: string): string {
	return JSON.stringify([block, number]);
}

/** How one house is written in a message a superuser reads: `A-12`. */
export function unitLabel(block: string, number: string): string {
	return `${block}-${number}`;
}

/** An address as it is compared and stored: trimmed and lowercased, so `A@B.com` is `a@b.com`. */
function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * A row on its way through validation, before it is known whether anything refuses it.
 *
 * **`position` is the key everything internal is held by, never `rowNumber`.** Keeping reasons and
 * resident ids under the position is what stops two rows collapsing into one, and it is the only
 * number this module can be sure is unique — see `ImportRow`.
 */
interface Candidate {
	/** Where this row sits among the data rows, counting from 0. Unique by construction. */
	readonly position: number;
	readonly rowNumber: number;
	readonly block: string;
	readonly number: string;
	readonly name: string;
	readonly email: string;
	readonly role: OccupancyRole | undefined;
}

/**
 * Reads one data row, recording every reason the row is refused on its own terms.
 *
 * Every cell is trimmed here rather than trusted to arrive trimmed. This module is a pure function
 * over rows from any source, and a rule that only holds when the caller prepared its input is not a
 * rule. `readResidentRows` trims too, so for an uploaded workbook this is a second pass over text
 * that is already clean.
 */
function readCandidate(
	row: ImportRow,
	position: number,
	reasonsByPosition: Map<number, ImportProblemReason[]>
): Candidate {
	if (row.length !== IMPORT_HEADER.length) {
		addReason(reasonsByPosition, position, IMPORT_PROBLEM.malformedRow);
	}

	const [block = '', number = '', name = '', email = '', role = ''] = row.map((field) =>
		field.trim()
	);

	requireText(reasonsByPosition, position, block, IMPORT_PROBLEM.missingBlock);
	requireText(reasonsByPosition, position, number, IMPORT_PROBLEM.missingNumber);
	requireText(reasonsByPosition, position, name, IMPORT_PROBLEM.missingName);

	return {
		position,
		rowNumber: position + FIRST_DATA_ROW_NUMBER,
		block,
		number,
		name,
		email: checkEmail(reasonsByPosition, position, email),
		role: checkRole(reasonsByPosition, position, role)
	};
}

/** Records `code` when `value` is empty. */
function requireText(
	reasonsByPosition: Map<number, ImportProblemReason[]>,
	position: number,
	value: string,
	code: ImportProblemCode
): void {
	if (value === '') {
		addReason(reasonsByPosition, position, code);
	}
}

/** The address, normalized — or the empty string, with the reason recorded, when it is not one. */
function checkEmail(
	reasonsByPosition: Map<number, ImportProblemReason[]>,
	position: number,
	written: string
): string {
	if (written === '') {
		addReason(reasonsByPosition, position, IMPORT_PROBLEM.missingEmail);
		return '';
	}
	if (!isEmailAddress(written)) {
		addReason(reasonsByPosition, position, IMPORT_PROBLEM.invalidEmail, written);
		return '';
	}
	return normalizeEmail(written);
}

/** The occupancy role the word means — or `undefined`, with the reason recorded. */
function checkRole(
	reasonsByPosition: Map<number, ImportProblemReason[]>,
	position: number,
	written: string
): OccupancyRole | undefined {
	if (written === '') {
		addReason(reasonsByPosition, position, IMPORT_PROBLEM.missingRole);
		return undefined;
	}
	const role = ROLE_BY_INDONESIAN_WORD[written.toLowerCase()];
	if (!role) {
		addReason(reasonsByPosition, position, IMPORT_PROBLEM.unknownRole, written);
	}
	return role;
}

/**
 * Whether `value` is shaped like an email address: something, one `@`, then a domain carrying a dot
 * that is neither its first nor its last character, and no whitespace anywhere.
 *
 * Written with `indexOf` rather than a regular expression on purpose. The patterns that describe
 * this shape all put two greedy classes on either side of an optional separator, which is the shape
 * that backtracks badly on a long non-matching input (Sonar `S5852`/`S8786`), and the input here
 * comes from a file somebody uploaded.
 */
function isEmailAddress(value: string): boolean {
	const at = value.indexOf('@');
	if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) {
		return false;
	}
	if (hasWhitespace(value)) {
		return false;
	}
	const domain = value.slice(at + 1);
	const dot = domain.indexOf('.');
	return dot > 0 && dot < domain.length - 1;
}

/** Whether `value` carries a space, a tab or a line break. */
function hasWhitespace(value: string): boolean {
	return [...value].some((character) => character.trim() === '');
}

/** Records a reason against a row, keeping the reasons of one row together and in order. */
function addReason(
	reasonsByPosition: Map<number, ImportProblemReason[]>,
	position: number,
	code: ImportProblemCode,
	value = ''
): void {
	const reasons = reasonsByPosition.get(position);
	if (reasons) {
		reasons.push({ code, value });
		return;
	}
	reasonsByPosition.set(position, [{ code, value }]);
}

/** Records the repeats: every row of a house named twice, and every row of an address written twice. */
function flagRepeats(
	candidates: readonly Candidate[],
	reasonsByPosition: Map<number, ImportProblemReason[]>
): void {
	const byUnit = groupBy(candidates, (candidate) =>
		candidate.block === '' || candidate.number === ''
			? undefined
			: unitKey(candidate.block, candidate.number)
	);
	for (const group of byUnit.values()) {
		flagGroup(group, reasonsByPosition, IMPORT_PROBLEM.duplicateUnitInFile, (candidate) =>
			unitLabel(candidate.block, candidate.number)
		);
	}

	const byEmail = groupBy(candidates, (candidate) =>
		candidate.email === '' ? undefined : candidate.email
	);
	for (const group of byEmail.values()) {
		flagGroup(
			group,
			reasonsByPosition,
			IMPORT_PROBLEM.duplicateEmailInFile,
			(candidate) => candidate.email
		);
	}
}

/** Records `code` against every row of a group that holds more than one. */
function flagGroup(
	group: readonly Candidate[],
	reasonsByPosition: Map<number, ImportProblemReason[]>,
	code: ImportProblemCode,
	valueOf: (candidate: Candidate) => string
): void {
	if (group.length < 2) {
		return;
	}
	for (const candidate of group) {
		addReason(reasonsByPosition, candidate.position, code, valueOf(candidate));
	}
}

/** Groups candidates by a key, skipping the ones `keyOf` answers `undefined` for. */
function groupBy(
	candidates: readonly Candidate[],
	keyOf: (candidate: Candidate) => string | undefined
): ReadonlyMap<string, Candidate[]> {
	const groups = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const key = keyOf(candidate);
		if (key === undefined) {
			continue;
		}
		const existing = groups.get(key);
		if (existing) {
			existing.push(candidate);
			continue;
		}
		groups.set(key, [candidate]);
	}
	return groups;
}

/**
 * The recorded reasons as the list a screen renders, in the order the rows appear in the file.
 *
 * Built by walking the candidates rather than the map, so the order is the file's own.
 */
function collectProblems(
	candidates: readonly Candidate[],
	reasonsByPosition: ReadonlyMap<number, ImportProblemReason[]>
): readonly ImportRowProblem[] {
	const problems: ImportRowProblem[] = [];
	for (const candidate of candidates) {
		const reasons = reasonsByPosition.get(candidate.position);
		if (reasons) {
			problems.push({ rowNumber: candidate.rowNumber, reasons });
		}
	}
	return problems;
}

/**
 * A candidate nothing refused, as a row ready to be written.
 *
 * @throws {TypeError} when the role is missing, which cannot happen: a candidate with no role
 *   carries a reason, and a candidate carrying a reason never reaches this function.
 */
function asParsedRow(candidate: Candidate): ParsedImportRow {
	if (!candidate.role) {
		throw new TypeError(`Row ${candidate.rowNumber} has no occupancy role and no reason recorded.`);
	}
	return {
		rowNumber: candidate.rowNumber,
		block: candidate.block,
		number: candidate.number,
		name: candidate.name,
		email: candidate.email,
		role: candidate.role
	};
}
