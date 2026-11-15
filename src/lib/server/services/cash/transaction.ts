import type { Rupiah } from '#lib/money.ts';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import type { CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import type { FileStore } from '../../ports/file-store';
import { CASH_WRITE_KIND, writeCashTransaction, type CashReceiptUpload } from './writer';

export {
	CASH_RULE,
	CashRuleError,
	MAXIMUM_RECEIPT_BYTES,
	RECEIPT_CONTENT_TYPES,
	type CashReceiptUpload,
	type CashRule
} from './writer';

/**
 * Recording a Transaksi Kas by hand: the admin's line of the buku kas, dated on the day money really
 * moved, and the two doors through which the dues module puts money into "Iuran warga".
 *
 * Since #315 this module holds no write statement. Every row it records is written by
 * `writeCashTransaction` in `./writer.ts`, which owns the one `insert` into `cash_transactions`, the
 * Periode guard, the sign rule and the append-only argument. What stays here is what makes a
 * recording a use case rather than a row: who may do it, where its receipt is stored, and the audit
 * row it leaves. `CASH_RULE`, `CashRuleError` and the receipt constants are re-exported from the
 * writer, because the cash screens import them from here.
 *
 * `ACTION.recordCashTransactions` in `src/lib/server/authz.ts` is granted to `admin` alone, so every
 * guarded function below is, today, an admin-only function; that is a fact about the permission
 * table, not something re-decided here.
 *
 * ## Decisions settled here
 *
 * - **The direction of a row is never sent by the caller.** `RecordCashTransactionRequest` has no
 *   `type`; the writer reads it off the category. An admin picks "Perbaikan gerbang" and the row is
 *   an expense because that category is one.
 * - **The receipt is stored inside the recording transaction, right after the row is inserted.**
 *   The writer checks the upload and writes its storage key on the insert, so every guard,
 *   including the Periode, has passed before a byte is stored, and a caller the guards refuse never
 *   leaves a file behind. A failed upload throws inside the transaction and rolls the row back. The
 *   only way to orphan a file is a database failure between the store and the commit, which leaves
 *   an unreferenced blob nobody can reach, not a row pointing at a file that is not there.
 * - **`recordDuesIncome` and `recordDuesRefund` stay here as thin doors onto the writer.** Payment
 *   verification and the Pengembalian import them from this module. Each is one call to
 *   `writeCashTransaction` with its kind, and nothing else.
 */

/** The audit log's `action` for a Transaksi Kas an admin recorded by hand. */
export const CASH_TRANSACTION_RECORDED_ACTION = 'cash_transaction_recorded';

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
	/** What the money was for. Required: a cash book line with no story is unauditable. */
	readonly description: string;
	/** The photo of the nota, when the admin attached one. */
	readonly receipt?: CashReceiptUpload;
}

/**
 * Whether `actorId` may work with the cash book at all, as a question on its own.
 *
 * It exists for the "catat transaksi" screen, which loads a form with nothing on it but the category
 * list, a read that takes no caller, and so has no query a permission check could ride along on.
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
 *   row is created, open, when it does not exist yet; see `./period.ts`.
 */
export async function recordCashTransaction(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	request: RecordCashTransactionRequest
): Promise<CashTransaction> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.recordCashTransactions);

		const row = await writeCashTransaction(transaction, clock, {
			kind: CASH_WRITE_KIND.manual,
			recordedBy: request.actorId,
			occurredOn: request.occurredOn,
			categoryId: request.categoryId,
			amount: request.amount,
			description: request.description,
			receipt: request.receipt
		});

		// The writer has checked the upload and written its key on the row. The bytes go there now,
		// inside this transaction, so a failed store rolls the row back. See this module's doc comment.
		if (request.receipt && row.attachmentKey !== null) {
			await fileStore.store(row.attachmentKey, request.receipt.content);
		}

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

/** What Payment verification hands over for the one cash row a verification writes. */
export interface RecordDuesIncomeRequest {
	/** The day the money was actually received: `payments.receivedOn`, never the verification day. */
	readonly occurredOn: string;
	/** The verified payment's full amount, in whole rupiah. Strictly positive. */
	readonly amount: Rupiah;
	/** What this money was for, naming the house and the payment. Data in the book, so Indonesian. */
	readonly description: string;
	/** The verifying admin's account, a `user.id`, which is what `recordedBy` references. */
	readonly recordedBy: string;
}

/**
 * Writes the one kind of cash row that `recordCashTransaction` refuses: income into the system
 * category "Iuran warga", dated on the day the money was received. The writer's `duesIncome` kind.
 *
 * It takes the verification's own `Transaction`, because the cash row is one part of a verification
 * that has to commit or fail as a whole. It checks no permission, because whether the caller may
 * verify a Pembayaran is `ACTION.verifyPayments`'s question, answered before this runs. And it
 * writes no audit row, because the verification records exactly one, filed against the Pembayaran
 * and carrying this row's id.
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
	return writeCashTransaction(transaction, clock, {
		kind: CASH_WRITE_KIND.duesIncome,
		recordedBy: request.recordedBy,
		occurredOn: request.occurredOn,
		amount: request.amount,
		description: request.description
	});
}

/** What the Pengembalian hands over for each cash expense row it writes. */
export interface RecordDuesRefundRequest {
	/** The day the money was handed back, as `YYYY-MM-DD`. Never the day the row is typed in. */
	readonly occurredOn: string;
	/** How much of one payment's remainder is being returned, in whole rupiah. Strictly positive. */
	readonly amount: Rupiah;
	/** What this money was for, naming the house and the payment. Data in the book, so Indonesian. */
	readonly description: string;
	/** The refunding superuser's account, a `user.id`, which is what `recordedBy` references. */
	readonly recordedBy: string;
}

/**
 * Writes one cash **expense** in the system category "Iuran warga": a Pengembalian returning part of
 * a Unit's Saldo Titipan, dated on the day the money was handed back. The writer's `duesRefund`
 * kind, and the mirror of `recordDuesIncome`.
 *
 * Everything `recordDuesIncome` says about itself holds here: it takes the refund's own
 * `Transaction`, checks no permission (`ACTION.correctDues` was checked before this runs), and
 * writes no audit row (the refund records one, filed against the Unit). The row is `expense` in a
 * category whose type is `income`; why is the sign rule in `./writer.ts`.
 *
 * @throws {CashRuleError} `amountNotPositive`, `notACalendarDay`, or `descriptionMissing`.
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 * @throws {PeriodLockedError} when `occurredOn` falls inside a Periode that is locked.
 */
export async function recordDuesRefund(
	transaction: Transaction,
	clock: Clock,
	request: RecordDuesRefundRequest
): Promise<CashTransaction> {
	return writeCashTransaction(transaction, clock, {
		kind: CASH_WRITE_KIND.duesRefund,
		recordedBy: request.recordedBy,
		occurredOn: request.occurredOn,
		amount: request.amount,
		description: request.description
	});
}
