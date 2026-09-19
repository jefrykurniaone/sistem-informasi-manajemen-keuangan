import { eq } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { CASH_CATEGORY_TYPE, type CashCategoryType } from '../../db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import { requireOpenPeriodFor } from './period';
import { assertCashDescription } from './transaction';

/**
 * The Koreksi: the only way a mistake in the buku kas is put right. `CONTEXT.md` defines it as
 * "Transaksi Kas pembalik yang menunjuk transaksi yang dikoreksinya", and
 * `docs/spec-kas-laporan-v1.md` says why it is a row rather than an edit — "koreksi yang tidak
 * terlihat sama saja dengan penghapusan". Both lines stay in the book and both are shown.
 *
 * `ACTION.recordCashTransactions` in `src/lib/server/authz.ts` is granted to `admin` alone, and
 * correcting shares that action with recording: a Koreksi *is* a Transaksi Kas, written by the same
 * person from the same screen. See the argument next to the action itself.
 *
 * ## Decisions settled here
 *
 * - **Nothing about the reversing row is chosen by the caller except the reason.** Type, amount,
 *   category and date are all read off the transaction being corrected, so the three facts the
 *   spec demands — "bertipe berlawanan", "dengan nominal yang sama", in the same category so that
 *   per-category figures net out — cannot be got wrong by a caller and need no validation. The
 *   request carries a transaction id and an alasan, and that is all.
 * - **The Koreksi carries the corrected row's `occurredOn`, not today's date.** `occurredOn` is the
 *   day money actually moved (`src/lib/server/db/schema/cash-transaction.ts`), and a Koreksi is a
 *   statement about that same day: the gate repair that was typed as 150.000 instead of 1.500.000
 *   was still paid for in March. Dating the reversal today would leave March permanently wrong and
 *   April wrong the other way, and the whole point of a cash book is that each month's total is the
 *   money that moved in it. The consequence is deliberate and is what the spec's machinery is built
 *   for: a Koreksi of a month whose Laporan Bulanan has been published lands inside a locked
 *   Periode, so it waits for the superuser's unlock-with-a-reason (user story 15) and then appears
 *   as revision 2, instead of silently moving a number a resident has already read.
 * - **A transaction is corrected at most once, and the "once" is held by a row lock.** See
 *   `lockTransaction` below for the whole argument.
 * - **A Koreksi may itself be corrected — once — and that is not a special case.** The rule is
 *   uniform: any row, ordinary or reversing, accepts one Koreksi. It has to be, because a Koreksi
 *   written against the wrong row is itself a mistake, and refusing to correct it would leave the
 *   book with a permanent error in the one module whose subject is that every error can be put
 *   right. The chain stays coherent by construction: correcting K, which opposed O, produces a row
 *   with O's type and amount, so the net effect returns to O's.
 * - **A Koreksi carries no attachment.** A correction's evidence is its alasan, which is required;
 *   `attachmentKey` stays null. One receipt photo belongs to the movement of money, and the
 *   movement is the row being corrected.
 * - **The audit row is filed against the transaction that was corrected, not against the new row.**
 *   Every other `recordAuditEntry` in this codebase targets the row that changed; here nothing
 *   changes, and a new row is created *about* another one. Filing it under the original is what
 *   makes `auditEntriesFor(db, originalId)` answer "this line was corrected, by whom, when, and
 *   why" — which is the question anybody reading a corrected line actually has.
 * - **The period check runs against `original.occurredOn`, not against today.** It sits inside the
 *   same transaction that holds the row lock, and the date it asks about is the date the new row
 *   will carry — which is the point above, carried through to the rule that acts on it. The
 *   consequence is the one the spec's machinery is built for and is deliberate: correcting a line in
 *   a month whose Laporan Bulanan has been published waits for the superuser's unlock, instead of
 *   moving a number a resident has already read. `./period.ts` owns what a locked month means and
 *   what a missing `periods` row means; `./transaction.ts` carries the matching call.
 */

/** The audit log's `action` for a Koreksi, filed against the transaction it corrects. */
export const CASH_CORRECTION_RECORDED_ACTION = 'cash_correction_recorded';

/** Thrown when `transactionId` names no row in the cash book — an id no screen ever rendered. */
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
 * Thrown when the transaction being corrected already has a Koreksi against it. The caller *was*
 * allowed to correct — the guard let them through — so a route answers this as a rejected form
 * (`fail(400, …)`), not as a 403, exactly as `OpeningBalanceAlreadyRecordedError` is answered.
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

/** Who is correcting, which line, and why. */
export interface RecordCashCorrectionRequest {
	/** The signed-in admin. Checked against `ACTION.recordCashTransactions` before anything else. */
	readonly actorId: string;
	/** The Transaksi Kas being reversed. Everything but the reason is read off it. */
	readonly transactionId: string;
	/** Why it was wrong. Required, and stored as the new row's `description`. */
	readonly reason: string;
}

/**
 * Records a Koreksi of `transactionId`: one reversing Transaksi Kas, of the opposite type, for the
 * same amount, in the same category, on the same day, carrying `reason` and a reference back.
 *
 * @throws {PermissionDeniedError} when `actorId` may not record a Transaksi Kas.
 * @throws {CashRuleError} `descriptionMissing` when the reason is empty after trimming.
 * @throws {CashTransactionNotFoundError} when `transactionId` names no transaction.
 * @throws {CashTransactionAlreadyCorrectedError} when it has already been corrected.
 * @throws {PeriodLockedError} when the corrected row's own `occurredOn` falls inside a Periode that
 *   is locked. The Koreksi waits for the unlock; it is never re-dated into an open month.
 */
export async function recordCashCorrection(
	db: Database,
	clock: Clock,
	request: RecordCashCorrectionRequest
): Promise<CashTransaction> {
	const reason = request.reason.trim();

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.recordCashTransactions);
		assertCashDescription(reason);

		const original = await lockTransaction(transaction, request.transactionId);
		const existing = await findCorrectionOf(transaction, original.id);
		if (existing) {
			throw new CashTransactionAlreadyCorrectedError(original.id, existing.id);
		}

		// Against `original.occurredOn`, because that is the date the new row will carry — not
		// `clock.now()`. Inside the transaction that already holds the original's row lock, so the
		// two rules are decided together and in one lock order: the corrected row first, the Periode
		// second, everywhere money is written.
		await requireOpenPeriodFor(transaction, clock, original.occurredOn);

		const [row] = await transaction
			.insert(cashTransactions)
			.values({
				occurredOn: original.occurredOn,
				type: opposingType(original.type),
				categoryId: original.categoryId,
				amount: original.amount,
				description: reason,
				attachmentKey: null,
				recordedBy: request.actorId,
				correctionOf: original.id,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: CASH_CORRECTION_RECORDED_ACTION,
			targetId: original.id,
			before: { type: original.type, amount: original.amount },
			after: { correctionId: row.id, type: row.type, amount: row.amount, reason }
		});

		return row;
	});
}

/**
 * The transaction being corrected, locked until the caller's transaction ends — and this lock, not
 * the transaction around it, is what makes "tidak dapat dikoreksi dua kali" true.
 *
 * `db.transaction` runs at PostgreSQL's default READ COMMITTED, where a plain `SELECT` never blocks
 * on another transaction's uncommitted row lock; it just reads the latest *committed* row. So two
 * concurrent corrections of one line would each read "no Koreksi yet", each pass the check, and each
 * insert — leaving the line reversed twice, which is the same money counted out of the book twice,
 * with no way back: a Transaksi Kas is never updated and never deleted. Taking `.for('update')` on
 * the one row both corrections must name gives them a single point to contend on: the second blocks
 * here until the first commits, then re-reads and sees the Koreksi the first one inserted.
 *
 * It is the same lesson `lockOpeningBalanceCategory` in `./opening-balance.ts` records, with the
 * lock finally on the row it is really about — there the row to protect did not exist yet, so its
 * category had to stand in for it; here the transaction being corrected is already in the table.
 *
 * A partial unique index on `cash_transactions.correction_of` would state the same rule as a
 * database fact rather than a service one, and it would be the right belt to add to this braces.
 * It needs a migration, which is outside this ticket's surface.
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
