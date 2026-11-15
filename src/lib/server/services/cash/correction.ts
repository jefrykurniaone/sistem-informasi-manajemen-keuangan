import { eq } from 'drizzle-orm';
import { ACTION, requirePermission } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import { CASH_WRITE_KIND, writeCashTransaction } from './writer';

export { CashTransactionAlreadyCorrectedError, CashTransactionNotFoundError } from './writer';

/**
 * The ordinary Koreksi: the way an Admin puts a mistake in the buku kas right. `CONTEXT.md` defines
 * it as "Transaksi Kas pembalik yang menunjuk transaksi yang dikoreksinya", and
 * `docs/spec-kas-laporan-v1.md` says why it is a row rather than an edit: "koreksi yang tidak
 * terlihat sama saja dengan penghapusan". Both lines stay in the book and both are shown.
 *
 * Since #315 the reversing row is built and written by `writeCashTransaction` in `./writer.ts`, the
 * writer's `correction` kind. Everything about that row is decided there: it reads type, amount,
 * category and date off the line being corrected, takes that line's row lock so it is corrected at
 * most once, checks the Periode of the line's own day, and holds the rule about which lines a Koreksi
 * may point at. This module keeps what makes a Koreksi an Admin's act: the permission and the audit
 * row. The two error classes are re-exported from the writer, because the cash screen imports them
 * from here.
 *
 * `ACTION.recordCashTransactions` in `src/lib/server/authz.ts` is granted to `admin` alone, and
 * correcting shares that action with recording: a Koreksi *is* a Transaksi Kas, written by the same
 * person from the same screen. See the argument next to the action itself.
 *
 * ## Decisions settled here
 *
 * - **The audit row is filed against the transaction that was corrected, not against the new row.**
 *   Every other `recordAuditEntry` in this codebase targets the row that changed; here nothing
 *   changes, and a new row is created *about* another one. Filing it under the original is what
 *   makes `auditEntriesFor(db, originalId)` answer "this line was corrected, by whom, when, and
 *   why", which is the question anybody reading a corrected line actually has.
 * - **The audit row's `before` is read back off the corrected line**, after the writer has locked
 *   it, rather than worked out from the Koreksi by flipping its type. The sign rule lives in the
 *   writer alone, and the audit records what the line says, not what this module believes it says.
 */

/** The audit log's `action` for a Koreksi, filed against the transaction it corrects. */
export const CASH_CORRECTION_RECORDED_ACTION = 'cash_correction_recorded';

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
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.recordCashTransactions);

		const row = await writeCashTransaction(transaction, clock, {
			kind: CASH_WRITE_KIND.correction,
			recordedBy: request.actorId,
			transactionId: request.transactionId,
			reason: request.reason
		});

		// The writer locked this line and read it to build the Koreksi; it exists and cannot change.
		const [original] = await transaction
			.select({
				id: cashTransactions.id,
				type: cashTransactions.type,
				amount: cashTransactions.amount
			})
			.from(cashTransactions)
			.where(eq(cashTransactions.id, request.transactionId));

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: CASH_CORRECTION_RECORDED_ACTION,
			targetId: original.id,
			before: { type: original.type, amount: original.amount },
			after: { correctionId: row.id, type: row.type, amount: row.amount, reason: row.description }
		});

		return row;
	});
}
