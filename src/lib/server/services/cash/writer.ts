import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Rupiah } from '#lib/money.ts';
import type { DatabaseWriter, Transaction } from '../../authz';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY,
	type CashCategory,
	type CashCategoryType
} from '../../db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import {
	CashCategoryNotFoundError,
	duesCategory,
	findCashCategoryById,
	SystemCategoryMissingError
} from './category';
import { requireOpenPeriodFor } from './period';

/**
 * The cash book writer: the one module that writes a Transaksi Kas. It holds the only `insert` into
 * `cash_transactions` in the codebase, the Periode guard, the sign rule, and the rule about which
 * line each kind of Koreksi may point at. Every other module that puts money into the buku kas
 * (`./transaction.ts`, `./correction.ts`, `./opening-balance.ts`, Payment verification and the
 * Pengembalian through `./transaction.ts`, and the dues-correction module) composes
 * `writeCashTransaction` below and holds no write statement of its own.
 *
 * Spec #308, decision 1, gives the reason in one line: a Periode guard that is only a convention
 * was already skipped once, by the opening balance. Here it is not a convention. There is one
 * function, it builds the row first, then asks `requireOpenPeriodFor` about the day that row will
 * carry, then inserts it, and there is no other path to the table.
 *
 * ## The kinds of write, who calls each one, and which way its money moves
 *
 * | Kind                      | Its one caller                                   | Direction                   |
 * | ------------------------- | ------------------------------------------------ | --------------------------- |
 * | `manual`                  | `recordCashTransaction` in `./transaction.ts`    | the category's type         |
 * | `duesIncome`              | Payment verification, via `recordDuesIncome`     | the category's: `income`    |
 * | `duesRefund`              | the Pengembalian, via `recordDuesRefund`         | `expense`                   |
 * | `openingBalance`          | `recordOpeningBalance` in `./opening-balance.ts` | the category's: `income`    |
 * | `correction`              | `recordCashCorrection` in `./correction.ts`      | opposite of the line        |
 * | `unverifyCorrection`      | **dues-correction module only**: Pembatalan      | opposite of the line:       |
 * |                           | verifikasi                                       | `expense`                   |
 * | `refundReverseCorrection` | **dues-correction module only**: Pembatalan      | opposite of the line:       |
 * |                           | Pengembalian                                     | `income`                    |
 *
 * The last two are prepared by #315 and used from #329 and #331. They are the only Koreksi that may
 * reverse a line in the system category "Iuran warga" once #323 closes that category to the ordinary
 * Koreksi, which is why nothing outside the dues-correction module may call them.
 * `tests/unit/cash-transaction.test.ts` refuses a reference to either name anywhere under `src/`
 * outside this file and `src/lib/server/services/dues/`. That test allows the directory rather
 * than one file because how the dues-correction module is laid out is #324's decision, not this
 * module's.
 *
 * ## The sign rule
 *
 * An ordinary row moves money in the direction of its Kategori Kas, read off the category row and
 * never taken from the caller: no write below has a `type` field. There are two exceptions, and each
 * is built in exactly one place:
 *
 * - **A Pengembalian is an `expense` in "Iuran warga"**, whose own type is `income`. The row really
 *   is money leaving, and it has to sit in the category whose figures it nets against. It reverses
 *   nothing, so its `correctionOf` stays null.
 * - **Every Koreksi opposes the row it corrects**, not its category. The two agree for a Koreksi of
 *   an ordinary row. They differ for a Koreksi of a Pengembalian, which has to be `income` to put the
 *   money back, and for a Koreksi of a Koreksi, which returns the line to its original direction.
 *   The glossary's "berlawanan dengan tipe Kategori Kas-nya" is the first case only.
 *
 * ## Append-only is the shape of this module, not a convention it observes
 *
 * 1. **One `insert`, and no `update` or `delete`, against `cash_transactions` in the whole of
 *    `src/`.** `tests/unit/cash-transaction.test.ts` parses every source file and fails on a write
 *    statement against that table anywhere but here.
 * 2. **`attachmentKey` is written on the insert, never after it.** The id is minted here with
 *    `randomUUID()` rather than left to the column default, so a receipt's storage key can be
 *    derived from it before the row exists. Insert first and set the key afterwards would put an
 *    `UPDATE cash_transactions` in the one module whose subject is that there is never one.
 * 3. **The test pins this module's exported names.** A `deleteCashTransaction` exported later fails
 *    that assertion whatever it is called.
 * 4. **An append-only witness** snapshots every row, drives every kind below and a refusal of
 *    several, and asserts that each row that existed before is still there, field for field. That
 *    catches an update hidden inside a function that already exists, which the other three cannot.
 *
 * ## What this module does not do
 *
 * - **It checks no permission.** It takes a `Transaction`, never a `Database`, so only a service
 *   that has already opened a transaction, and has therefore already checked the action entitling
 *   it to write, can reach it. The same argument `lockPeriod` in `./period.ts` records.
 * - **It writes no audit row.** Each caller records one decision as one audit row, in the shape its
 *   own history reads back. A second row filed here would split one decision into two entries.
 * - **It holds none of its callers' domain rules.** "Only one opening balance in force" is
 *   `./opening-balance.ts`'s rule, held by its lock on the opening-balance category, which it takes
 *   before calling here. How much of a Saldo Titipan may be returned is the Pengembalian's rule.
 *   This module holds the rules that are true of every row: the Periode, the direction, a positive
 *   amount, a real day, a keterangan, and at most one Koreksi per line.
 *
 * ## The lock order
 *
 * The rows the money is about come first, then the Periode. A caller's own locks (a Pembayaran, a
 * Tagihan, the opening-balance category) are taken before it calls here. A Koreksi takes the line it
 * corrects `for update` inside this module, and `requireOpenPeriodFor` takes the Periode `for share`
 * last of all. No writer takes those two in the other order, which is what a deadlock would need.
 */

/**
 * Every rule the cash book refuses a request for, other than permission. A route maps each of these
 * to a sentence through an exhaustive `Record`, so a rule added later is a type error at every
 * screen until somebody writes its message. That is also why the locked Periode is not a member:
 * it keeps its own named error, `PeriodLockedError` in `./period.ts`.
 *
 * These are named refusals of a specific request, not of the caller: the actor was inside their
 * rights and the request itself is what is wrong, so a route answers them with `fail(400, …)`
 * rather than with a 403.
 */
export const CASH_RULE = {
	/** The category is one of the seeded system ones, which accept no manual entry. */
	categoryIsSystem: 'categoryIsSystem',
	/** The category has been deactivated, so no new transaction may be filed under it. */
	categoryRetired: 'categoryRetired',
	/** The amount is zero or negative. A cash transaction is a movement of money. */
	amountNotPositive: 'amountNotPositive',
	/** The date is not a real calendar day written as `YYYY-MM-DD`. */
	notACalendarDay: 'notACalendarDay',
	/** The keterangan is empty, and on a Koreksi that empty text is its missing alasan. */
	descriptionMissing: 'descriptionMissing',
	/** The uploaded receipt is larger than `MAXIMUM_RECEIPT_BYTES`. */
	receiptTooLarge: 'receiptTooLarge',
	/** The uploaded receipt is not one of the accepted image formats. */
	receiptNotAnImage: 'receiptNotAnImage'
} as const;

/** One of the rules above. */
export type CashRule = (typeof CASH_RULE)[keyof typeof CASH_RULE];

/**
 * Thrown when the cash book refuses a request by one of the rules in `CASH_RULE`.
 *
 * Named and `instanceof`-checkable for the reason `PermissionDeniedError` is: a route tells this
 * apart from "something broke" by catching the class and reading `rule`, never by matching a
 * message.
 */
export class CashRuleError extends Error {
	override readonly name = 'CashRuleError';

	/** Which rule refused the request. */
	readonly rule: CashRule;

	constructor(rule: CashRule, detail: string) {
		super(`The cash book refused this request (${rule}): ${detail}`);
		this.rule = rule;
	}
}

/** Thrown when `transactionId` names no row in the cash book, an id no screen ever rendered. */
export class CashTransactionNotFoundError extends Error {
	override readonly name = 'CashTransactionNotFoundError';

	/** The id that named no transaction. */
	readonly transactionId: string;

	constructor(transactionId: string) {
		super(`No cash transaction exists with id "${transactionId}".`);
		this.transactionId = transactionId;
	}
}

/**
 * Thrown when the line being corrected already has a Koreksi against it, whichever kind of Koreksi
 * wrote it. The caller *was* allowed to correct, so a route answers this as a rejected form
 * (`fail(400, …)`), not as a 403.
 *
 * For a Pengembalian this is also what "already reversed" means: spec #308 decision 6 derives a
 * Pembatalan Pengembalian from the Koreksi on the refund's cash row, with no column of its own.
 */
export class CashTransactionAlreadyCorrectedError extends Error {
	override readonly name = 'CashTransactionAlreadyCorrectedError';

	/** The transaction that has already been corrected. */
	readonly transactionId: string;
	/** The Koreksi that corrected it. */
	readonly correctionId: string;

	constructor(transactionId: string, correctionId: string) {
		super(
			`Cash transaction "${transactionId}" has already been corrected by "${correctionId}". A transaction is corrected once; correcting the correction is how a wrong correction is put right.`
		);
		this.transactionId = transactionId;
		this.correctionId = correctionId;
	}
}

/**
 * Thrown when a kind of Koreksi is pointed at a line it does not reverse: a Pembatalan verifikasi
 * at anything but a dues income row, or a Pembatalan Pengembalian at anything but a Pengembalian's
 * expense row.
 *
 * From the dues-correction module this means the line was found through the wrong Audit Log entry
 * or the wrong `refunds` row, so it is a defect rather than a request to refuse politely. It is a
 * class of its own, carrying the kind, so that a later rule about the ordinary Koreksi (#323 closes
 * "Iuran warga" to it) can refuse with the same class and a route can tell the cases apart.
 */
export class CashCorrectionTargetError extends Error {
	override readonly name = 'CashCorrectionTargetError';

	/** The line the Koreksi was pointed at. */
	readonly transactionId: string;
	/** The kind of Koreksi that refused it. */
	readonly kind: CashCorrectionKind;

	constructor(transactionId: string, kind: CashCorrectionKind, detail: string) {
		super(`A "${kind}" Koreksi may not reverse cash transaction "${transactionId}": ${detail}`);
		this.transactionId = transactionId;
		this.kind = kind;
	}
}

/**
 * The largest receipt photo this application accepts, in bytes. The same figure
 * `MAXIMUM_COVER_IMAGE_BYTES` uses, and for the same reason: it has to stay under SvelteKit's
 * `BODY_SIZE_LIMIT`, and a photograph of a paper receipt taken on a phone and downscaled fits
 * comfortably inside it.
 */
export const MAXIMUM_RECEIPT_BYTES = 256 * 1024;

/**
 * The image formats a receipt may be in, and the file extension each is stored under.
 *
 * The extension comes from here rather than from the uploaded file's name, which arrives from a
 * browser form and becomes part of a storage key, and a storage key is a path.
 *
 * ## A `Map`, not an object literal, because the key is the caller's to choose
 *
 * `receipt.contentType` is `File.type` read off a multipart form, so it is a claim under the
 * sender's control exactly as the bytes are. An object literal inherits from `Object.prototype`, so
 * a lookup in one answers for names nobody put in it: `'constructor'` would come back as `Object`
 * and `'__proto__'` as `Object.prototype`. Both are truthy, so both sail past the
 * `if (!extension)` guard in `receiptKeyFor` and past the `?? []` in `hasSignatureOf`, and the
 * second of those then throws `TypeError: signature.every is not a function`: a 500 where this
 * module's contract says a named `receiptNotAnImage` refusal, reachable from a forged upload.
 *
 * `Map.get` has no prototype chain behind it, so every content type outside the three entries below
 * is `undefined` and both guards fire as written. **Do not turn either of these two maps back into
 * an object literal.** `tests/unit/cash-transaction.test.ts` holds the refusal for those names.
 */
const RECEIPT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
	['image/jpeg', 'jpg'],
	['image/png', 'png'],
	['image/webp', 'webp']
]);

/** Every content type a receipt may be uploaded as, for a screen that builds an `accept` list. */
export const RECEIPT_CONTENT_TYPES: readonly string[] = [...RECEIPT_EXTENSIONS.keys()];

/** Where a magic-number check looks in a file, and the bytes it expects to find there. */
interface ByteSignature {
	readonly offset: number;
	readonly bytes: readonly number[];
}

/**
 * How a file of each accepted type really begins.
 *
 * The content type on an upload is whatever the browser, or whatever is pretending to be one, chose
 * to send, so it is a claim rather than a fact. A receipt is read back through a signed link that
 * serves the bytes as they were stored, and a file that is not an image but says it is one is the
 * shape of an upload that becomes a script when something downstream sniffs its content instead of
 * believing its type. `WEBP` is checked at offset 8, after the `RIFF` container header and the
 * four-byte length that follows it.
 *
 * A `Map` for the reason `RECEIPT_EXTENSIONS` is one, and the two have to agree: a content type that
 * got an extension but no signature would be accepted unchecked, because `every` over an empty list
 * is `true`.
 *
 * A near-copy of `COVER_IMAGE_SIGNATURES` in `src/lib/server/services/post/index.ts`, and
 * deliberately a copy: importing a `POST_*` constant into the cash book would make a receipt's
 * accepted formats a consequence of what an announcement's cover image happens to allow, and the two
 * are free to diverge.
 */
const RECEIPT_SIGNATURES: ReadonlyMap<string, readonly ByteSignature[]> = new Map<
	string,
	readonly ByteSignature[]
>([
	['image/jpeg', [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
	['image/png', [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
	[
		'image/webp',
		[
			{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
			{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }
		]
	]
]);

/** The shape `occurredOn` has to arrive in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How many characters that shape has, which is also where an ISO instant's day part ends. */
const DAY_LENGTH = 10;

/** A receipt photo on its way in, as a route reads it off a multipart form. */
export interface CashReceiptUpload {
	/** What the upload claims the file is. Checked against the bytes, not believed. */
	readonly contentType: string;
	readonly content: Uint8Array;
}

/**
 * Every kind of write this module takes. The table in this module's doc comment says who calls each
 * one and which way its money moves.
 */
export const CASH_WRITE_KIND = {
	/** A line an Admin records by hand, in an ordinary category. */
	manual: 'manual',
	/** A verified Pembayaran's money, coming into "Iuran warga". */
	duesIncome: 'duesIncome',
	/** A Pengembalian's money, leaving "Iuran warga". */
	duesRefund: 'duesRefund',
	/** The Saldo awal, in the system category `opening-balance`. */
	openingBalance: 'openingBalance',
	/** The ordinary Koreksi an Admin writes from the buku kas. */
	correction: 'correction',
	/** The Koreksi a Pembatalan verifikasi writes against a dues income row. Dues-correction only. */
	unverifyCorrection: 'unverifyCorrection',
	/** The Koreksi a Pembatalan Pengembalian writes against its expense row. Dues-correction only. */
	refundReverseCorrection: 'refundReverseCorrection'
} as const;

/** One of the kinds above. */
export type CashWriteKind = (typeof CASH_WRITE_KIND)[keyof typeof CASH_WRITE_KIND];

/** The three kinds that write a Koreksi, and so read everything but the reason off another line. */
export type CashCorrectionKind =
	| typeof CASH_WRITE_KIND.correction
	| typeof CASH_WRITE_KIND.unverifyCorrection
	| typeof CASH_WRITE_KIND.refundReverseCorrection;

/** What every write of new money carries, whichever kind it is. */
export interface CashMovementFields {
	/** The account that recorded the row, a `user.id`, which is what `recordedBy` references. */
	readonly recordedBy: string;
	/** The day money actually moved, as `YYYY-MM-DD`. Never the day the row is typed in. */
	readonly occurredOn: string;
	/** How much moved, in whole rupiah. Strictly positive: direction is never a sign. */
	readonly amount: Rupiah;
	/** What the money was for. Required, and trimmed. Data in the book, so Indonesian. */
	readonly description: string;
}

/** A line an Admin records by hand. Its one caller is `recordCashTransaction`. */
export interface ManualCashWrite extends CashMovementFields {
	readonly kind: typeof CASH_WRITE_KIND.manual;
	/**
	 * The Kategori Kas the line is filed under. Its type is the line's direction. A system category
	 * or a deactivated one is refused.
	 */
	readonly categoryId: string;
	/**
	 * The photo of the nota, when there is one. It is checked here and its storage key is written on
	 * the row as `attachmentKey`. **The caller stores the bytes at that key inside the same database
	 * transaction**, so a failed upload rolls the row back with it.
	 */
	readonly receipt?: CashReceiptUpload;
}

/** A verified Pembayaran's money. Its one caller is Payment verification. */
export interface DuesIncomeCashWrite extends CashMovementFields {
	readonly kind: typeof CASH_WRITE_KIND.duesIncome;
}

/** One Pembayaran's share of a Pengembalian. Its one caller is the Pengembalian. */
export interface DuesRefundCashWrite extends CashMovementFields {
	readonly kind: typeof CASH_WRITE_KIND.duesRefund;
}

/**
 * The Saldo awal. Its one caller is `recordOpeningBalance`, which holds the opening-balance
 * category's lock and decides whether one may be recorded before it calls here.
 */
export interface OpeningBalanceCashWrite extends CashMovementFields {
	readonly kind: typeof CASH_WRITE_KIND.openingBalance;
}

/** What every Koreksi carries. Everything else about the new line is read off the corrected one. */
export interface CashCorrectionFields {
	/** The account that recorded the Koreksi, a `user.id`. */
	readonly recordedBy: string;
	/** The line being reversed. */
	readonly transactionId: string;
	/** Why it is reversed. Required, trimmed, and stored as the new line's `description`. */
	readonly reason: string;
}

/** The ordinary Koreksi. Its one caller is `recordCashCorrection`. */
export interface CorrectionCashWrite extends CashCorrectionFields {
	readonly kind: typeof CASH_WRITE_KIND.correction;
}

/**
 * The Koreksi of a Pembatalan verifikasi: an `expense` against one dues income row, on its day.
 * **Only the dues-correction module calls this kind.** The line must be in "Iuran warga", be
 * `income`, and not itself be a Koreksi, or `CashCorrectionTargetError` refuses it.
 */
export interface UnverifyCorrectionCashWrite extends CashCorrectionFields {
	readonly kind: typeof CASH_WRITE_KIND.unverifyCorrection;
}

/**
 * The Koreksi of a Pembatalan Pengembalian: an `income` against one Pengembalian's expense row, on
 * its day. **Only the dues-correction module calls this kind.** The line must be in "Iuran warga",
 * be `expense`, and not itself be a Koreksi, or `CashCorrectionTargetError` refuses it.
 */
export interface RefundReverseCorrectionCashWrite extends CashCorrectionFields {
	readonly kind: typeof CASH_WRITE_KIND.refundReverseCorrection;
}

/** One write of one Transaksi Kas, of one kind. */
export type CashWrite =
	| ManualCashWrite
	| DuesIncomeCashWrite
	| DuesRefundCashWrite
	| OpeningBalanceCashWrite
	| CorrectionCashWrite
	| UnverifyCorrectionCashWrite
	| RefundReverseCorrectionCashWrite;

/**
 * Writes one Transaksi Kas, of any kind, inside the caller's transaction: the row is built and
 * checked, the Periode its day falls in is checked, and the row is inserted. Never changed again.
 *
 * @throws {CashRuleError} `amountNotPositive`, `notACalendarDay` or `descriptionMissing` for a new
 *   movement of money; `descriptionMissing` for a Koreksi with no reason; and for a manual line,
 *   `receiptTooLarge`, `receiptNotAnImage`, `categoryIsSystem` or `categoryRetired`.
 * @throws {CashCategoryNotFoundError} when a manual line names no category.
 * @throws {SystemCategoryMissingError} when the migration's seed row for a system category is gone.
 * @throws {CashTransactionNotFoundError} when a Koreksi names no line.
 * @throws {CashCorrectionTargetError} when a Koreksi kind is pointed at a line it does not reverse.
 * @throws {CashTransactionAlreadyCorrectedError} when the line already has a Koreksi.
 * @throws {PeriodLockedError} when the day the row would carry falls inside a locked Periode. For a
 *   Koreksi that is the corrected line's day: it waits for the month to be reopened and is never
 *   re-dated into an open one.
 */
export async function writeCashTransaction(
	transaction: Transaction,
	clock: Clock,
	write: CashWrite
): Promise<CashTransaction> {
	const row = await rowFor(transaction, write);

	// The Periode guard: here, once, for every kind, against the day the row is about to carry, and
	// after any lock the row was built under. `./period.ts` owns what a locked month and a missing
	// `periods` row mean, and why `for share` is the right strength.
	await requireOpenPeriodFor(transaction, clock, row.occurredOn);

	const [written] = await transaction
		.insert(cashTransactions)
		.values({ ...row, createdAt: clock.now() })
		.returning();
	return written;
}

/** Every column of a new row except `createdAt`, which is stamped at the insert. */
interface CashRow {
	readonly id: string;
	readonly occurredOn: string;
	readonly type: CashCategoryType;
	readonly categoryId: string;
	readonly amount: Rupiah;
	readonly description: string;
	readonly attachmentKey: string | null;
	readonly recordedBy: string;
	readonly correctionOf: string | null;
}

/**
 * The row one write asks for, checked, with its direction decided. Exhaustive over `CashWrite`, so a
 * kind added later is a type error here until it says how its row is built.
 */
async function rowFor(transaction: Transaction, write: CashWrite): Promise<CashRow> {
	switch (write.kind) {
		case CASH_WRITE_KIND.manual:
			return manualRow(transaction, write);
		case CASH_WRITE_KIND.duesIncome: {
			const movement = checkedMovement(write);
			const category = await duesCategory(transaction);
			return movementRow(movement, category, category.type);
		}
		case CASH_WRITE_KIND.duesRefund: {
			const movement = checkedMovement(write);
			const category = await duesCategory(transaction);
			// Deliberately not `category.type`: this is money leaving the dues category. See the sign
			// rule in this module's doc comment.
			return movementRow(movement, category, CASH_CATEGORY_TYPE.expense);
		}
		case CASH_WRITE_KIND.openingBalance: {
			const movement = checkedMovement(write);
			const category = await openingBalanceCategory(transaction);
			return movementRow(movement, category, category.type);
		}
		case CASH_WRITE_KIND.correction:
		case CASH_WRITE_KIND.unverifyCorrection:
		case CASH_WRITE_KIND.refundReverseCorrection:
			return correctionRow(transaction, write);
	}
}

/**
 * A manual line. The checks run in the order they always have: amount, day, keterangan, receipt,
 * then category, so a request wrong in several ways is refused for the same reason as before.
 */
async function manualRow(transaction: Transaction, write: ManualCashWrite): Promise<CashRow> {
	const id = randomUUID();
	const movement = checkedMovement(write);
	const attachmentKey = write.receipt ? receiptKeyFor(id, write.receipt) : null;
	const category = await requireRecordableCategory(transaction, write.categoryId);
	return {
		id,
		occurredOn: movement.occurredOn,
		type: category.type,
		categoryId: category.id,
		amount: movement.amount,
		description: movement.description,
		attachmentKey,
		recordedBy: movement.recordedBy,
		correctionOf: null
	};
}

/** A row of new money in `category`, moving in `type`. No attachment and no Koreksi. */
function movementRow(
	movement: CashMovementFields,
	category: CashCategory,
	type: CashCategoryType
): CashRow {
	return {
		id: randomUUID(),
		occurredOn: movement.occurredOn,
		type,
		categoryId: category.id,
		amount: movement.amount,
		description: movement.description,
		attachmentKey: null,
		recordedBy: movement.recordedBy,
		correctionOf: null
	};
}

/**
 * A Koreksi: of the opposite type to the line it corrects, for the same amount, in the same
 * category, on the same day, carrying the reason and a reference back. Nothing but the reason is
 * the caller's to choose, so none of it can be got wrong.
 *
 * The Koreksi carries the corrected line's `occurredOn`, not today's date. `occurredOn` is the day
 * money moved, and a Koreksi is a statement about that same day. Dating it today would leave the
 * original month wrong for good and the current one wrong the other way. So a Koreksi of a month
 * whose Laporan Bulanan has been published lands in a locked Periode, waits for a superuser to
 * reopen it, and appears in the next revision, instead of silently moving a published number.
 *
 * A Koreksi carries no attachment. Its evidence is its reason, which is required; a receipt photo
 * belongs to the movement of money, and the movement is the line being corrected.
 */
async function correctionRow(
	transaction: Transaction,
	write: CorrectionCashWrite | UnverifyCorrectionCashWrite | RefundReverseCorrectionCashWrite
): Promise<CashRow> {
	const reason = write.reason.trim();
	assertDescription(reason);

	const corrected = await lockTransaction(transaction, write.transactionId);
	await assertCorrectableBy(transaction, write.kind, corrected);
	const existing = await findCorrectionOf(transaction, corrected.id);
	if (existing) {
		throw new CashTransactionAlreadyCorrectedError(corrected.id, existing.id);
	}

	return {
		id: randomUUID(),
		occurredOn: corrected.occurredOn,
		type: opposingType(corrected.type),
		categoryId: corrected.categoryId,
		amount: corrected.amount,
		description: reason,
		attachmentKey: null,
		recordedBy: write.recordedBy,
		correctionOf: corrected.id
	};
}

/**
 * Which lines each kind of Koreksi may point at: the one place spec #308 decision 2 is held.
 *
 * - **`correction`, the ordinary Koreksi, accepts any line today.** Any line, ordinary or
 *   reversing, takes one Koreksi, because a Koreksi written against the wrong line is itself a
 *   mistake and has to be correctable. Closing "Iuran warga" to it is #323's change, and it belongs
 *   in this `case`.
 * - **The two dues kinds accept only the line they exist to reverse.** A Pembatalan verifikasi
 *   reverses a dues income row, and a Pembatalan Pengembalian reverses a Pengembalian's expense
 *   row. Neither reverses a Koreksi: a dues Koreksi is not reopened by writing a second one.
 *
 * @throws {CashCorrectionTargetError} when the line is not one `kind` reverses.
 */
async function assertCorrectableBy(
	transaction: Transaction,
	kind: CashCorrectionKind,
	corrected: CashTransaction
): Promise<void> {
	switch (kind) {
		case CASH_WRITE_KIND.correction:
			return;
		case CASH_WRITE_KIND.unverifyCorrection:
			return assertDuesLine(transaction, kind, corrected, CASH_CATEGORY_TYPE.income);
		case CASH_WRITE_KIND.refundReverseCorrection:
			return assertDuesLine(transaction, kind, corrected, CASH_CATEGORY_TYPE.expense);
	}
}

/**
 * Refuses `corrected` unless it is an original line in "Iuran warga" moving in `type`: dues income
 * for `income`, a Pengembalian for `expense`.
 */
async function assertDuesLine(
	transaction: Transaction,
	kind: CashCorrectionKind,
	corrected: CashTransaction,
	type: CashCategoryType
): Promise<void> {
	const dues = await duesCategory(transaction);
	if (corrected.categoryId !== dues.id) {
		throw new CashCorrectionTargetError(
			corrected.id,
			kind,
			'the line is not in the system category "Iuran warga".'
		);
	}
	if (corrected.correctionOf !== null) {
		throw new CashCorrectionTargetError(
			corrected.id,
			kind,
			`the line is itself a Koreksi of "${corrected.correctionOf}".`
		);
	}
	if (corrected.type !== type) {
		throw new CashCorrectionTargetError(
			corrected.id,
			kind,
			`the line moves money as ${corrected.type}, and this Koreksi reverses only ${type}.`
		);
	}
}

/**
 * The line being corrected, locked until the caller's transaction ends. This lock, not the
 * transaction around it, is what makes "tidak dapat dikoreksi dua kali" true for every kind of
 * Koreksi at once.
 *
 * `db.transaction` runs at PostgreSQL's default READ COMMITTED, where a plain `SELECT` never blocks
 * on another transaction's uncommitted row lock; it reads the latest *committed* row. Two concurrent
 * corrections of one line would each read "no Koreksi yet", each pass the check, and each insert,
 * leaving the line reversed twice: the same money counted out of the book twice, with no way back.
 * Taking `.for('update')` on the one row both must name gives them a single point to contend on: the
 * second blocks here until the first commits, then re-reads and sees the Koreksi the first inserted.
 * An ordinary Koreksi and a Pembatalan of the same line contend on the same lock.
 *
 * A partial unique index on `cash_transactions.correction_of` would state the same rule as a
 * database fact. It needs a migration, which this run does not make.
 *
 * @throws {CashTransactionNotFoundError} when no row carries `transactionId`.
 */
async function lockTransaction(
	transaction: Transaction,
	transactionId: string
): Promise<CashTransaction> {
	const [row] = await transaction
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.id, transactionId))
		.for('update');
	if (!row) {
		throw new CashTransactionNotFoundError(transactionId);
	}
	return row;
}

/** The Koreksi already filed against `transactionId`, when there is one. */
async function findCorrectionOf(
	writer: DatabaseWriter,
	transactionId: string
): Promise<CashTransaction | undefined> {
	const [row] = await writer
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.correctionOf, transactionId))
		.limit(1);
	return row;
}

/** The other direction money moves. A Koreksi's whole arithmetic is this one flip. */
function opposingType(type: CashCategoryType): CashCategoryType {
	return type === CASH_CATEGORY_TYPE.income
		? CASH_CATEGORY_TYPE.expense
		: CASH_CATEGORY_TYPE.income;
}

/**
 * The category a manual line may be filed under, or the refusal that says why not.
 *
 * **Every system category refuses a manual line**, not only "Iuran warga". Money reaches "Iuran
 * warga" through Payment verification and the Pengembalian, and "Saldo awal" through
 * `recordOpeningBalance`, whose lock is what keeps the opening balance single; a manual line in
 * either would walk past the flow that owns it. Refusing on `systemKey !== null` is one rule for
 * both, and it stays right for any system category a later migration seeds.
 *
 * **A retired category refuses a new line**, while `findCashCategoryById` still answers for the
 * lines already filed under it.
 *
 * @throws {CashCategoryNotFoundError} when no category carries `categoryId`.
 * @throws {CashRuleError} `categoryIsSystem` or `categoryRetired`.
 */
async function requireRecordableCategory(
	writer: DatabaseWriter,
	categoryId: string
): Promise<CashCategory> {
	const category = await findCashCategoryById(writer, categoryId);
	if (!category) {
		throw new CashCategoryNotFoundError(categoryId);
	}
	if (category.systemKey !== null) {
		throw new CashRuleError(
			CASH_RULE.categoryIsSystem,
			`"${category.name}" is the system category "${category.systemKey}", which accepts no manual entry. Money reaches it through the one flow that owns it.`
		);
	}
	if (!category.isActive) {
		throw new CashRuleError(
			CASH_RULE.categoryRetired,
			`"${category.name}" has been deactivated, so no new transaction may be filed under it. The transactions already filed under it keep it.`
		);
	}
	return category;
}

/**
 * The system category `opening-balance`, read without a lock: `recordOpeningBalance` already holds
 * this row `for update` in the same transaction before it calls here.
 *
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 */
async function openingBalanceCategory(writer: DatabaseWriter): Promise<CashCategory> {
	const [row] = await writer
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.openingBalance));
	if (!row) {
		throw new SystemCategoryMissingError(SYSTEM_CATEGORY_KEY.openingBalance);
	}
	return row;
}

/**
 * The fields of a new movement of money, checked, with the keterangan trimmed.
 *
 * @throws {CashRuleError} `amountNotPositive`, `notACalendarDay` or `descriptionMissing`.
 */
function checkedMovement(write: CashMovementFields): CashMovementFields {
	const description = write.description.trim();
	assertPositiveAmount(write.amount);
	assertCalendarDay(write.occurredOn);
	assertDescription(description);
	return {
		recordedBy: write.recordedBy,
		occurredOn: write.occurredOn,
		amount: write.amount,
		description
	};
}

/** Refuses an amount the `cash_transactions_amount_check` would refuse anyway, but by name. */
function assertPositiveAmount(amount: Rupiah): void {
	if (amount <= 0) {
		throw new CashRuleError(
			CASH_RULE.amountNotPositive,
			`A cash transaction is a movement of money, so its amount is strictly positive, not ${amount}. Direction is carried by the category, never by a sign.`
		);
	}
}

/**
 * Refuses anything that is not a real calendar day written as `YYYY-MM-DD`.
 *
 * The round trip through `Date` is what makes "real" true, and matching the pattern is not enough on
 * its own: `new Date('2026-02-31')` does not fail, it rolls over to 3 March, so a day that does not
 * exist would otherwise reach PostgreSQL and come back as a driver error nobody named.
 */
function assertCalendarDay(day: string): void {
	const parsed = new Date(`${day}T00:00:00.000Z`);
	if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime())) {
		throw new CashRuleError(
			CASH_RULE.notACalendarDay,
			`"${day}" is not a calendar day written as YYYY-MM-DD.`
		);
	}
	if (parsed.toISOString().slice(0, DAY_LENGTH) !== day) {
		throw new CashRuleError(
			CASH_RULE.notACalendarDay,
			`"${day}" is not a day that exists on the calendar.`
		);
	}
}

/**
 * Refuses a keterangan that says nothing, and on a Koreksi that is the same rule as "alasan wajib".
 *
 * `cash_transactions` has no `reason` column: a Koreksi's alasan lives in `description`, which is
 * `not null`. So the two requirements are one rule about one column.
 */
function assertDescription(description: string): void {
	if (description === '') {
		throw new CashRuleError(
			CASH_RULE.descriptionMissing,
			'A cash book line needs a keterangan; a line with no story is unauditable. On a Koreksi that keterangan is its alasan, which is why it is required there too.'
		);
	}
}

/**
 * Checks an uploaded receipt and works out the storage key it belongs at:
 * `cash-transactions/<id>/receipt.<ext>`, built from the row's own id and from an extension this
 * module chooses, never from the uploaded file's name.
 *
 * @throws {CashRuleError} `receiptTooLarge` or `receiptNotAnImage`.
 */
function receiptKeyFor(transactionId: string, receipt: CashReceiptUpload): string {
	if (receipt.content.byteLength > MAXIMUM_RECEIPT_BYTES) {
		throw new CashRuleError(
			CASH_RULE.receiptTooLarge,
			`The uploaded receipt is ${receipt.content.byteLength} bytes; the limit is ${MAXIMUM_RECEIPT_BYTES}.`
		);
	}

	const extension = RECEIPT_EXTENSIONS.get(receipt.contentType);
	if (!extension) {
		throw new CashRuleError(
			CASH_RULE.receiptNotAnImage,
			`"${receipt.contentType}" is not one of ${RECEIPT_CONTENT_TYPES.join(', ')}.`
		);
	}
	if (!hasSignatureOf(receipt.content, receipt.contentType)) {
		throw new CashRuleError(
			CASH_RULE.receiptNotAnImage,
			`The uploaded bytes do not start the way a "${receipt.contentType}" file starts.`
		);
	}

	return `cash-transactions/${transactionId}/receipt.${extension}`;
}

/** Whether `content` really begins the way a file of `contentType` begins. */
function hasSignatureOf(content: Uint8Array, contentType: string): boolean {
	const signature = RECEIPT_SIGNATURES.get(contentType) ?? [];
	return signature.every((part) =>
		part.bytes.every((byte, index) => content[part.offset + index] === byte)
	);
}
