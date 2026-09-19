import { randomUUID } from 'node:crypto';
import type { Rupiah } from '$lib/money';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import type { CashCategory } from '../../db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import type { FileStore } from '../../ports/file-store';
import { CashCategoryNotFoundError, duesCategory, findCashCategoryById } from './category';
import { requireOpenPeriodFor } from './period';

/**
 * Recording a Transaksi Kas by hand: the admin's line of the buku kas, dated on the day money
 * really moved. `docs/spec-kas-laporan-v1.md` makes this book append-only — "tidak ada operasi ubah
 * dan tidak ada operasi hapus di lapisan service" — and this module is one half of what that
 * sentence means in code. `./correction.ts` is the other half, and `./balance.ts` reads the book
 * back.
 *
 * `ACTION.recordCashTransactions` in `src/lib/server/authz.ts` is granted to `admin` alone, so every
 * guarded function below is, today, an admin-only function; that is a fact about the permission
 * table, not something re-decided here.
 *
 * ## Append-only is the *shape* of these modules, not a convention they observe
 *
 * A convention is something a reviewer has to notice. These three modules make the absence of an
 * update and of a delete structural, at four levels that each fail independently:
 *
 * 1. **No function here, or in `./correction.ts` or `./balance.ts`, issues `update` or `delete`
 *    against `cash_transactions`.** There are exactly two `insert`s in this file — the manual
 *    recording below, and `recordDuesIncome`, the one door into the system category "Iuran warga" —
 *    and exactly one in `./correction.ts`, and none of the three statements is exported: the only
 *    way into the table is through the guarded functions that own them, so there is no low-level
 *    write a later caller could reach for.
 * 2. **`attachmentKey` is written on the insert, never after it.** The row's id is minted here with
 *    `randomUUID()` rather than left to the column default, precisely so that the receipt's storage
 *    key can be derived from it *before* the row exists. The obvious alternative — insert, store the
 *    file, then set `attachmentKey` — would put an `UPDATE cash_transactions` in the one module
 *    whose whole subject is that there is never one.
 * 3. **The tests assert the exported surface, not the source text.**
 *    `tests/unit/cash-transaction.test.ts` compares `Object.keys` of all three modules against an
 *    exact list, so a `updateCashTransaction` added later is a failing assertion the moment it is
 *    exported, whatever it is called and however the file is formatted.
 * 4. **The same test file carries an append-only witness**: it snapshots every row, then drives
 *    every write and every refusal these modules offer, and asserts that each row that existed
 *    before is still there, field for field. That catches the case the surface list cannot — an
 *    update smuggled *inside* a function that already exists.
 *
 * The database backs all four up as far as a database can: no foreign key in
 * `src/lib/server/db/schema/cash-transaction.ts` carries a cascade, `correctionOf` is a
 * self-referencing foreign key so a corrected row cannot be deleted, and `categoryId` has no
 * `onDelete` so a category that has been used cannot be deleted either.
 *
 * ## Decisions settled here
 *
 * - **The direction of a row is read off its category, never sent by the caller.**
 *   `src/lib/server/db/schema/cash-transaction.ts` assigns "that ordinary rows agree with their
 *   category" to this ticket as a service rule, and the cheapest way to make a rule true is to give
 *   the caller no way to break it: `RecordCashTransactionRequest` has no `type`, and the insert
 *   writes `category.type`. An admin picks "Perbaikan gerbang" and the row is an expense because
 *   that category is one. A Koreksi is the one row whose type opposes its category's, and it is
 *   built by `./correction.ts`, which is the only place that inversion can happen.
 * - **Every system category refuses a manual entry, not only "Iuran warga".** The acceptance
 *   criteria names the dues category, because verifying a Pembayaran (#29) must be the only way
 *   money lands there. The same argument applies unchanged to "Saldo awal": #33 holds "there is only
 *   ever one opening balance" with a row lock in `./opening-balance.ts`, and a manual entry into
 *   that category would walk straight past that lock and leave a cash book with two opening
 *   balances. Refusing on `systemKey !== null` is one rule covering both, and it stays right for any
 *   system category a later migration seeds.
 * - **A retired category refuses a new row.** `listActiveCashCategories` is what fills the recording
 *   form, so a deactivated category is already absent from it; this is the guarantee behind that
 *   courtesy, for a form value that arrives by hand. User story 2 asks that retiring a category stop
 *   *new* transactions without touching old ones, which is exactly this rule plus
 *   `findCashCategoryById` still answering for the old ones.
 * - **The receipt is stored inside the recording transaction, after every check and immediately
 *   before the insert.** Storing first and inserting afterwards would write a file for a caller the
 *   guard is about to refuse; inserting first and storing afterwards would need the `UPDATE` point 2
 *   above rules out. Inside the transaction, a failed upload rolls the row back, and the only way to
 *   orphan a file is a database failure between the store and the commit — which leaves an
 *   unreferenced blob nobody can reach, not a row pointing at a file that is not there.
 * - **The storage key is `cash-transactions/<id>/receipt.<ext>`**, built from the row's own id and
 *   from an extension this module chooses, never from the uploaded file's name — which arrives from
 *   a browser and would be a path fragment picked by whoever sent it. It is the convention
 *   `payments/<paymentId>/proof.jpg` and `posts/<postId>/cover.<ext>` already follow: a key the
 *   caller can rebuild is a key it can delete without storing anything extra.
 * - **The period check, and where it sits.** `docs/spec-kas-laporan-v1.md` user story 14 refuses a
 *   transaction dated inside a locked Periode, and
 *   `src/lib/server/db/schema/cash-transaction.ts` settles that this is a service rule rather than a
 *   constraint. #34 left the seam and #35 filled it: `requireOpenPeriodFor` is called inside the
 *   recording transaction, after the category is known and before the insert, against
 *   `request.occurredOn` — the day the money moved, never the day the row is typed in.
 *   `./correction.ts` carries the matching call against the *corrected* row's date. What a missing
 *   `periods` row means, who creates one, and how the race to create it is resolved are all settled
 *   in `./period.ts`; this module only names the moment the question is asked.
 *
 *   The refusal is `PeriodLockedError`, not a member of `CASH_RULE`, and that is a surface
 *   consequence rather than a preference: `CASH_RULE` is mapped by an exhaustive `Record` on the two
 *   cash screens, which #35's `writes:` does not include.
 */

/** The audit log's `action` for a Transaksi Kas an admin recorded by hand. */
export const CASH_TRANSACTION_RECORDED_ACTION = 'cash_transaction_recorded';

/**
 * The largest receipt photo this application accepts, in bytes. The same figure
 * `MAXIMUM_COVER_IMAGE_BYTES` uses, and for the same reason: it has to stay under SvelteKit's
 * `BODY_SIZE_LIMIT`, which this ticket's surface cannot reach, and a photograph of a paper receipt
 * taken on a phone and downscaled fits comfortably inside it.
 */
export const MAXIMUM_RECEIPT_BYTES = 256 * 1024;

/**
 * The image formats a receipt may be in, and the file extension each is stored under.
 *
 * The extension comes from here rather than from the uploaded file's name, which arrives from a
 * browser form and becomes part of a storage key — and a storage key is a path.
 *
 * ## A `Map`, not an object literal, because the key is the caller's to choose
 *
 * `receipt.contentType` is `File.type` read off a multipart form, so it is a claim under the
 * sender's control exactly as the bytes are — and an object literal inherits from
 * `Object.prototype`, so a lookup in one answers for names nobody put in it. `'constructor'` would
 * come back as `Object` and `'__proto__'` as `Object.prototype`: both truthy, so both sail past the
 * `if (!extension)` guard in `receiptKeyFor` and past the `?? []` in `hasSignatureOf`, and the
 * second of those then throws `TypeError: signature.every is not a function`. That is a 500 where
 * this module's contract says a named `receiptNotAnImage` refusal, reachable from a forged upload.
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
 * The content type on an upload is whatever the browser — or whatever is pretending to be one —
 * chose to send, so it is a claim rather than a fact. A receipt is read back through a signed link
 * that serves the bytes as they were stored, and a file that is not an image but says it is one is
 * the shape of an upload that becomes a script when something downstream sniffs its content instead
 * of believing its type. `WEBP` is checked at offset 8, after the `RIFF` container header and the
 * four-byte length that follows it.
 *
 * A `Map` for the reason `RECEIPT_EXTENSIONS` is one, and the two have to agree: a content type that
 * got an extension but no signature would be accepted unchecked, because `every` over an empty list
 * is `true`.
 *
 * A near-copy of `COVER_IMAGE_SIGNATURES` in `src/lib/server/services/post/index.ts`, and
 * deliberately a copy: importing a `POST_*` constant into the cash book would make a receipt's
 * accepted formats a consequence of what an announcement's cover image happens to allow, and the two
 * are free to diverge. They have now diverged in the container, and that file is not this ticket's
 * to change.
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

/**
 * Every rule the cash book refuses a request for, other than permission — shared by this module and
 * by `./correction.ts`, because the two write rows into one book and refuse them for one set of
 * reasons. A route maps each of these to a sentence through an exhaustive `Record`, so a rule added
 * later is a type error at every screen until somebody writes its message.
 *
 * These are named refusals of a specific request, not of the caller: the actor was inside their
 * rights and the request itself is what is wrong, so a route answers them with `fail(400, …)` rather
 * than with a 403 — the distinction `PostRuleError` draws for the same reason.
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
	/** The keterangan is empty — and on a Koreksi, that empty text is its missing alasan. */
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
 * message. It lives here rather than in `src/lib/errors.ts` because this ticket's `writes:` does not
 * include that file — the same surface note `SystemCashCategoryError` carries.
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

/** A receipt photo on its way in, as a route reads it off a multipart form. */
export interface CashReceiptUpload {
	/** What the upload claims the file is. Checked against the bytes, not believed. */
	readonly contentType: string;
	readonly content: Uint8Array;
}

/** Who is recording, what moved, and the receipt when there is one. */
export interface RecordCashTransactionRequest {
	/** The signed-in admin. Checked against `ACTION.recordCashTransactions` before anything else. */
	readonly actorId: string;
	/** The day money actually moved, as `YYYY-MM-DD`. Not the day this row is typed in. */
	readonly occurredOn: string;
	/** The Kategori Kas this row is filed under. Its type is the row's direction. */
	readonly categoryId: string;
	/** How much moved, in whole rupiah. Strictly positive; direction lives in the category. */
	readonly amount: Rupiah;
	/** What the money was for. Required — a cash book line with no story is unauditable. */
	readonly description: string;
	/** The photo of the nota, when the admin attached one. */
	readonly receipt?: CashReceiptUpload;
}

/**
 * Whether `actorId` may work with the cash book at all, as a question on its own.
 *
 * It exists for the "catat transaksi" screen, which loads a form with nothing on it but the category
 * list — a read that takes no caller — and so has no query a permission check could ride along on.
 * Without it that screen would either call the guard in `src/lib/server/authz.ts` from the route,
 * putting a permission decision somewhere other than the service layer, or show a resident a form
 * and only refuse them once they had filled it in. The same helper, for the same reason, as
 * `assertMayManagePosts`.
 *
 * @throws {PermissionDeniedError} when `actorId` may not record a Transaksi Kas.
 */
export async function assertMayRecordCashTransactions(
	db: Database,
	actorId: string
): Promise<void> {
	await requirePermission(db, actorId, ACTION.recordCashTransactions);
}

/**
 * Records one Transaksi Kas: one line of the buku kas, dated on `occurredOn`, typed by its
 * category, and never changed again.
 *
 * @throws {PermissionDeniedError} when `actorId` may not record a Transaksi Kas.
 * @throws {CashCategoryNotFoundError} when `categoryId` names no category.
 * @throws {CashRuleError} `categoryIsSystem` for one of the seeded categories, `categoryRetired` for
 *   a deactivated one, `amountNotPositive` for zero or less, `notACalendarDay` for a date that is
 *   not one, `descriptionMissing` for an empty keterangan, and `receiptTooLarge` or
 *   `receiptNotAnImage` for an attachment that is neither small enough nor really an image.
 * @throws {PeriodLockedError} when `occurredOn` falls inside a Periode that is locked. The month's
 *   row is created, open, when it does not exist yet — see `./period.ts`.
 */
export async function recordCashTransaction(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	request: RecordCashTransactionRequest
): Promise<CashTransaction> {
	// Minted here rather than left to the column default so that the receipt's key can be derived
	// from it before the row exists. See point 2 of this module's doc comment.
	const id = randomUUID();
	const description = request.description.trim();

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.recordCashTransactions);

		assertPositiveAmount(request.amount);
		assertCalendarDay(request.occurredOn);
		assertCashDescription(description);
		const storedReceipt = request.receipt
			? { key: receiptKeyFor(id, request.receipt), content: request.receipt.content }
			: undefined;

		const category = await requireRecordableCategory(transaction, request.categoryId);

		// The Periode this row is dated into: created when the month has none, share-locked until
		// this transaction ends, and refused by name when it is locked. Here, inside this
		// transaction, is what keeps the check and the insert from being separated by another
		// writer — see `./period.ts` for why `for share` is the right strength.
		await requireOpenPeriodFor(transaction, clock, request.occurredOn);

		if (storedReceipt) {
			await fileStore.store(storedReceipt.key, storedReceipt.content);
		}

		const [row] = await transaction
			.insert(cashTransactions)
			.values({
				id,
				occurredOn: request.occurredOn,
				type: category.type,
				categoryId: category.id,
				amount: request.amount,
				description,
				attachmentKey: storedReceipt?.key ?? null,
				recordedBy: request.actorId,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: CASH_TRANSACTION_RECORDED_ACTION,
			targetId: row.id,
			after: {
				occurredOn: row.occurredOn,
				type: row.type,
				categoryId: row.categoryId,
				amount: row.amount
			}
		});

		return row;
	});
}

/** What #29's payment verification hands over for the one cash row a verification writes. */
export interface RecordDuesIncomeRequest {
	/** The day the money was actually received — `payments.receivedOn`, never the verification day. */
	readonly occurredOn: string;
	/** The verified payment's full amount, in whole rupiah. Strictly positive. */
	readonly amount: Rupiah;
	/** What this money was for, naming the house and the payment. Data in the book, so Indonesian. */
	readonly description: string;
	/** The verifying admin's account — a `user.id`, which is what `recordedBy` references. */
	readonly recordedBy: string;
}

/**
 * Writes the one kind of cash row that `recordCashTransaction` refuses: income into the system
 * category "Iuran warga", dated on the day the money was received.
 *
 * `CONTEXT.md` defines that category as one "yang hanya bisa diisi lewat verifikasi Pembayaran",
 * and this function is what makes that sentence structural rather than a convention: the category
 * is resolved here by its stable `systemKey` through `duesCategory`, the caller never names a
 * category at all, and no other code path — inside this module or outside it — inserts into it.
 * It lives in the cash book module, not in the dues module, because append-only is the *shape* of
 * this module (see the doc comment above), and a second writer of `cash_transactions` outside it
 * would dissolve that shape into a convention.
 *
 * Three deliberate differences from `recordCashTransaction`, each an argument rather than an
 * omission:
 *
 * - **It takes a `Transaction`, never a `Database`.** The row it writes is one third of the
 *   verification `docs/spec-iuran-v1.md:144-150` demands be indivisible — status, cash row and
 *   allocations succeed together or fail together — so it must run inside the verification's own
 *   transaction. Taking a `Transaction` is also what keeps it out of a route's reach, the same
 *   argument `lockPeriod` in `./period.ts` records: only a service that already opened a
 *   transaction, and therefore already checked the action entitling it to verify, holds one.
 * - **It checks no permission of its own.** Whether the caller may verify a Pembayaran is
 *   `ACTION.verifyPayments`'s question, answered by the verification service before this runs.
 *   Checking `recordCashTransactions` here instead would demand a right the verifying admin is not
 *   required to hold — the two actions are different sets on purpose, see
 *   `src/lib/server/authz.ts`.
 * - **It writes no audit row.** The acceptance criteria says a verification records exactly one
 *   audit row, filed against the Pembayaran; the verification service writes it, carrying this
 *   row's id in `after`. A second row here, targeted at the cash transaction, would turn one
 *   decision into two audit entries.
 *
 * What it shares with every other money write: the id is minted with `randomUUID()` before the
 * insert, and `requireOpenPeriodFor` runs here, inside the caller's transaction, against
 * `occurredOn` — after the caller has taken its own row locks, so the lock order everywhere money
 * is written stays "the rows the money is about first, the Periode second".
 *
 * @throws {CashRuleError} `amountNotPositive`, `notACalendarDay`, or `descriptionMissing`.
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 * @throws {PeriodLockedError} when `occurredOn` falls inside a Periode that is locked.
 */
export async function recordDuesIncome(
	transaction: Transaction,
	clock: Clock,
	request: RecordDuesIncomeRequest
): Promise<CashTransaction> {
	const description = request.description.trim();
	assertPositiveAmount(request.amount);
	assertCalendarDay(request.occurredOn);
	assertCashDescription(description);

	const category = await duesCategory(transaction);
	await requireOpenPeriodFor(transaction, clock, request.occurredOn);

	const [row] = await transaction
		.insert(cashTransactions)
		.values({
			id: randomUUID(),
			occurredOn: request.occurredOn,
			// The category's own direction, exactly as the manual path writes it. "Iuran warga" is
			// seeded as income, and `SystemCashCategoryError` in `./category.ts` keeps its type fixed.
			type: category.type,
			categoryId: category.id,
			amount: request.amount,
			description,
			attachmentKey: null,
			recordedBy: request.recordedBy,
			createdAt: clock.now()
		})
		.returning();

	return row;
}

/**
 * The category a new row may be filed under, or the refusal that says why not.
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
 * exist would otherwise reach PostgreSQL and come back as a driver error nobody named. The same
 * check `./opening-balance.ts` makes, copied rather than shared because that module's export list is
 * pinned by a test and widening it to publish a helper would change what that test proves.
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
 * Refuses a keterangan that says nothing — and, on a Koreksi, that is the same rule as "alasan
 * wajib".
 *
 * `cash_transactions` has no `reason` column: a Koreksi's alasan lives in `description`, which is
 * `not null`. So the two requirements the acceptance criteria words differently are one rule about
 * one column, and `./correction.ts` calls this rather than carrying a second copy of it.
 *
 * @throws {CashRuleError} `descriptionMissing` when the text is empty after trimming.
 */
export function assertCashDescription(description: string): void {
	if (description === '') {
		throw new CashRuleError(
			CASH_RULE.descriptionMissing,
			'A cash book line needs a keterangan; a line with no story is unauditable. On a Koreksi that keterangan is its alasan, which is why it is required there too.'
		);
	}
}

/**
 * Checks an uploaded receipt and works out the storage key it belongs at.
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
