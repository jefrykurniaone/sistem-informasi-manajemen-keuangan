import { OCCUPANCY_ROLE, type OccupancyRole } from '../../db/schema/occupancy';

/**
 * Reading a resident CSV file and deciding, without a database, which of its rows are usable.
 *
 * This module is deliberately pure: it parses the text, checks every field a row carries on its own,
 * and finds the repeats a row only has because of another row in the same file. The two questions
 * that need stored data — "does this house already exist" and "does this address already have an
 * account" — belong to `./resident-csv.ts`, which asks them of a database and appends its answers to
 * the same list of problems. Splitting it this way is what lets the whole reporting format be tested
 * without a connection, and it keeps the parsing, the checking and the writing in three separate
 * places, as the ticket's quality rules ask.
 *
 * ## What a problem looks like, and why it is a code rather than a sentence
 *
 * A problem is `{ rowNumber, reasons }`, and a reason is `{ code, value }` — never a ready-made
 * sentence. Every word a superuser reads is Indonesian and lives in `messages/id.json` under the
 * `adminImport_` prefix, so the service may not build one: it would be an English string on a screen,
 * or a second catalogue nobody translates. The screen maps a code to a message and fills `{value}`
 * with whichever block, address or word the row actually carried.
 *
 * **`rowNumber` is the line of the file as a person counts lines**, with the header as line 1, so the
 * first row of data is line 2. That is the number their spreadsheet shows them, and a number that
 * counts data rows instead would send them to the wrong line of a hundred.
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
 * wrong for the same reason, and a hundred identical problems say less than one.
 */

/** The header row every import file must start with, in this order. */
export const IMPORT_CSV_HEADER: readonly string[] = ['blok', 'nomor', 'nama', 'email', 'peran'];

/**
 * The largest number of data rows one file may carry. The spec sizes the feature at a hundred rows;
 * this is far above that and still refuses a file that would hold a transaction open over thousands
 * of statements.
 */
export const MAX_IMPORT_ROWS = 500;

/** Why one row of the file cannot be imported. The screen turns each of these into a sentence. */
export const IMPORT_PROBLEM = {
	/** The row does not have the five columns the header promises. */
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
export interface CsvValidation {
	/** Every row nothing in the file itself refuses, in the order the file lists them. */
	readonly rows: readonly ParsedImportRow[];
	/** Every refused row, by line number. */
	readonly problems: readonly ImportRowProblem[];
}

/**
 * Thrown when the file's first line is not the header this import expects. Whole-file, not per-row:
 * see this module's doc comment.
 */
export class ImportHeaderError extends Error {
	override readonly name = 'ImportHeaderError';

	/** The header the file actually carried, as its columns were written. */
	readonly actualHeader: readonly string[];

	constructor(actualHeader: readonly string[]) {
		super(
			`The import file must start with the header "${IMPORT_CSV_HEADER.join(',')}", not "${actualHeader.join(',')}".`
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

/** The Indonesian words a superuser writes in the `peran` column, and what each one means. */
const ROLE_BY_INDONESIAN_WORD: Readonly<Record<string, OccupancyRole | undefined>> = {
	pemilik: OCCUPANCY_ROLE.owner,
	penyewa: OCCUPANCY_ROLE.tenant
};

/** One record of the file: the line it starts on, and its columns as written. */
export interface CsvRecord {
	readonly lineNumber: number;
	readonly fields: readonly string[];
}

/** How many columns a row must have. */
const COLUMN_COUNT = 5;

const FIELD_SEPARATOR = ',';
const QUOTE = '"';
const LINE_FEED = '\n';
const CARRIAGE_RETURN = '\r';
/** The byte-order mark a spreadsheet writes in front of a UTF-8 file. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** Where the parser has got to. The line counter is what gives every record its `lineNumber`. */
interface Scanner {
	readonly text: string;
	index: number;
	line: number;
}

/**
 * Splits CSV text into records, honouring quoted fields — a name with a comma in it, or an address
 * written between quotes, is one field rather than two.
 *
 * Exported because the quoting rules are worth a test of their own: a parser that silently splits
 * `"Budi, S.T."` in half would turn a correct file into a hundred malformed rows, and the reason
 * would be nowhere near the message the superuser reads.
 *
 * Blank lines are skipped rather than reported: a file that ends with a newline has one, and a
 * spreadsheet often leaves a few behind.
 */
export function parseCsvRecords(content: string): readonly CsvRecord[] {
	const scanner: Scanner = { text: stripByteOrderMark(content), index: 0, line: 1 };
	const records: CsvRecord[] = [];

	while (scanner.index < scanner.text.length) {
		const lineNumber = scanner.line;
		const fields = readRecord(scanner);
		if (!isBlank(fields)) {
			records.push({ lineNumber, fields });
		}
	}

	return records;
}

/**
 * Reads a whole file and says which of its rows are usable and which are not.
 *
 * @throws {ImportHeaderError} when the first line is not `blok,nomor,nama,email,peran`.
 * @throws {EmptyImportFileError} when there is no data row at all.
 * @throws {ImportTooLargeError} when there are more than `MAX_IMPORT_ROWS` of them.
 */
export function validateImportCsv(content: string): CsvValidation {
	const [header, ...dataRecords] = parseCsvRecords(content);
	assertHeader(header);

	if (dataRecords.length === 0) {
		throw new EmptyImportFileError();
	}
	if (dataRecords.length > MAX_IMPORT_ROWS) {
		throw new ImportTooLargeError(dataRecords.length);
	}

	const reasonsByRow = new Map<number, ImportProblemReason[]>();
	const candidates = dataRecords.map((record) => readCandidate(record, reasonsByRow));
	flagRepeats(candidates, reasonsByRow);

	return {
		rows: candidates.filter((candidate) => !reasonsByRow.has(candidate.rowNumber)).map(asParsedRow),
		problems: collectProblems(reasonsByRow)
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
export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

/** A row on its way through validation, before it is known whether anything refuses it. */
interface Candidate {
	readonly rowNumber: number;
	readonly block: string;
	readonly number: string;
	readonly name: string;
	readonly email: string;
	readonly role: OccupancyRole | undefined;
}

/** Throws unless `header` is exactly the header this import expects. */
function assertHeader(header: CsvRecord | undefined): void {
	const actual = (header?.fields ?? []).map((field) => field.trim().toLowerCase());
	const matches =
		actual.length === IMPORT_CSV_HEADER.length &&
		actual.every((field, position) => field === IMPORT_CSV_HEADER[position]);
	if (!matches) {
		throw new ImportHeaderError(header?.fields ?? []);
	}
}

/** Reads one data record, recording every reason the row is refused on its own terms. */
function readCandidate(
	record: CsvRecord,
	reasonsByRow: Map<number, ImportProblemReason[]>
): Candidate {
	const rowNumber = record.lineNumber;
	if (record.fields.length !== COLUMN_COUNT) {
		addReason(reasonsByRow, rowNumber, IMPORT_PROBLEM.malformedRow);
	}

	const [block = '', number = '', name = '', email = '', role = ''] = record.fields.map((field) =>
		field.trim()
	);

	requireText(reasonsByRow, rowNumber, block, IMPORT_PROBLEM.missingBlock);
	requireText(reasonsByRow, rowNumber, number, IMPORT_PROBLEM.missingNumber);
	requireText(reasonsByRow, rowNumber, name, IMPORT_PROBLEM.missingName);

	return {
		rowNumber,
		block,
		number,
		name,
		email: checkEmail(reasonsByRow, rowNumber, email),
		role: checkRole(reasonsByRow, rowNumber, role)
	};
}

/** Records `code` when `value` is empty. */
function requireText(
	reasonsByRow: Map<number, ImportProblemReason[]>,
	rowNumber: number,
	value: string,
	code: ImportProblemCode
): void {
	if (value === '') {
		addReason(reasonsByRow, rowNumber, code);
	}
}

/** The address, normalized — or the empty string, with the reason recorded, when it is not one. */
function checkEmail(
	reasonsByRow: Map<number, ImportProblemReason[]>,
	rowNumber: number,
	written: string
): string {
	if (written === '') {
		addReason(reasonsByRow, rowNumber, IMPORT_PROBLEM.missingEmail);
		return '';
	}
	if (!isEmailAddress(written)) {
		addReason(reasonsByRow, rowNumber, IMPORT_PROBLEM.invalidEmail, written);
		return '';
	}
	return normalizeEmail(written);
}

/** The occupancy role the word means — or `undefined`, with the reason recorded. */
function checkRole(
	reasonsByRow: Map<number, ImportProblemReason[]>,
	rowNumber: number,
	written: string
): OccupancyRole | undefined {
	if (written === '') {
		addReason(reasonsByRow, rowNumber, IMPORT_PROBLEM.missingRole);
		return undefined;
	}
	const role = ROLE_BY_INDONESIAN_WORD[written.toLowerCase()];
	if (!role) {
		addReason(reasonsByRow, rowNumber, IMPORT_PROBLEM.unknownRole, written);
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
	reasonsByRow: Map<number, ImportProblemReason[]>,
	rowNumber: number,
	code: ImportProblemCode,
	value = ''
): void {
	const reasons = reasonsByRow.get(rowNumber);
	if (reasons) {
		reasons.push({ code, value });
		return;
	}
	reasonsByRow.set(rowNumber, [{ code, value }]);
}

/** Records the repeats: every row of a house named twice, and every row of an address written twice. */
function flagRepeats(
	candidates: readonly Candidate[],
	reasonsByRow: Map<number, ImportProblemReason[]>
): void {
	const byUnit = groupBy(candidates, (candidate) =>
		candidate.block === '' || candidate.number === ''
			? undefined
			: unitKey(candidate.block, candidate.number)
	);
	for (const group of byUnit.values()) {
		flagGroup(group, reasonsByRow, IMPORT_PROBLEM.duplicateUnitInFile, (candidate) =>
			unitLabel(candidate.block, candidate.number)
		);
	}

	const byEmail = groupBy(candidates, (candidate) =>
		candidate.email === '' ? undefined : candidate.email
	);
	for (const group of byEmail.values()) {
		flagGroup(
			group,
			reasonsByRow,
			IMPORT_PROBLEM.duplicateEmailInFile,
			(candidate) => candidate.email
		);
	}
}

/** Records `code` against every row of a group that holds more than one. */
function flagGroup(
	group: readonly Candidate[],
	reasonsByRow: Map<number, ImportProblemReason[]>,
	code: ImportProblemCode,
	valueOf: (candidate: Candidate) => string
): void {
	if (group.length < 2) {
		return;
	}
	for (const candidate of group) {
		addReason(reasonsByRow, candidate.rowNumber, code, valueOf(candidate));
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

/** The recorded reasons as the list a screen renders, ordered by line number. */
function collectProblems(
	reasonsByRow: ReadonlyMap<number, ImportProblemReason[]>
): readonly ImportRowProblem[] {
	return [...reasonsByRow.entries()]
		.map(([rowNumber, reasons]) => ({ rowNumber, reasons }))
		.sort((left, right) => left.rowNumber - right.rowNumber);
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

/** `content` without the byte-order mark a spreadsheet may have written in front of it. */
function stripByteOrderMark(content: string): string {
	return content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content;
}

/** Whether a record is an empty line rather than a row. */
function isBlank(fields: readonly string[]): boolean {
	return fields.length === 1 && fields[0].trim() === '';
}

/** Reads one record: fields separated by commas, up to a line break or the end of the text. */
function readRecord(scanner: Scanner): string[] {
	const fields: string[] = [];
	for (;;) {
		fields.push(readField(scanner));
		if (scanner.text[scanner.index] === FIELD_SEPARATOR) {
			scanner.index += 1;
			continue;
		}
		consumeLineBreak(scanner);
		return fields;
	}
}

/** Reads one field, quoted or bare. */
function readField(scanner: Scanner): string {
	return scanner.text[scanner.index] === QUOTE ? readQuotedField(scanner) : readBareField(scanner);
}

/**
 * Reads a field written between quotes, where `""` means one quote character and a line break is
 * part of the value. An unterminated quote takes the rest of the file, which is what makes the row
 * it belongs to malformed rather than the whole file unreadable.
 */
function readQuotedField(scanner: Scanner): string {
	scanner.index += 1;
	let value = '';
	while (scanner.index < scanner.text.length) {
		const character = scanner.text[scanner.index];
		if (character === QUOTE) {
			if (scanner.text[scanner.index + 1] !== QUOTE) {
				scanner.index += 1;
				return value;
			}
			scanner.index += 2;
			value += QUOTE;
			continue;
		}
		if (character === LINE_FEED) {
			scanner.line += 1;
		}
		scanner.index += 1;
		value += character;
	}
	return value;
}

/** Reads a field written without quotes: everything up to the next comma or line break. */
function readBareField(scanner: Scanner): string {
	const start = scanner.index;
	while (scanner.index < scanner.text.length && !isFieldEnd(scanner.text[scanner.index])) {
		scanner.index += 1;
	}
	return scanner.text.slice(start, scanner.index);
}

/** Whether `character` ends a bare field. */
function isFieldEnd(character: string): boolean {
	return character === FIELD_SEPARATOR || character === LINE_FEED || character === CARRIAGE_RETURN;
}

/** Steps over a `\n`, a `\r\n`, or the end of the text, counting the line. */
function consumeLineBreak(scanner: Scanner): void {
	if (scanner.text[scanner.index] === CARRIAGE_RETURN) {
		scanner.index += 1;
	}
	if (scanner.text[scanner.index] === LINE_FEED) {
		scanner.index += 1;
		scanner.line += 1;
	}
}
