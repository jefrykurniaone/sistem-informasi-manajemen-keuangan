import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Rupiah } from '#lib/money.ts';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import type { Database } from '../../db';
import { allocations } from '../../db/schema/allocation';
import { auditLog } from '../../db/schema/audit';
import { user } from '../../db/schema/auth';
import { cashTransactions } from '../../db/schema/cash-transaction';
import { invoices } from '../../db/schema/invoice';
import { PAYMENT_STATUS, payments, type PaymentMethod } from '../../db/schema/payment';
import { refunds } from '../../db/schema/refund';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { creditBalanceOfUnit, refundInForce } from './credit-balance';
import {
	DUES_CORRECTION_ACTIONS,
	DUES_CORRECTION_UNIT_KEY,
	duesCorrectionSummary,
	isDuesCorrectionAction,
	readDuesCorrectionRecord,
	type DuesCorrectionAction,
	type DuesCorrectionSummary
} from './dues-correction';
import { invoiceStandings, type InvoiceStatus } from './invoice-standing';
import { UnitNotFoundError } from './queries';

/**
 * The reads behind the unit finance screen: one Unit's Saldo Titipan, its Tagihan with their
 * Alokasi laid out for the void and release controls, its Pengembalian laid out for the reversal
 * control (#329), its verified Pembayaran laid out for the Pembatalan verifikasi control (#331), and
 * the history of the dues corrections, so
 * `src/routes/(app)/admin/units/[id]/finance/+page.server.ts` calls a service and composes no query
 * of its own. The corrections themselves, and the typed Audit Log record each one leaves, are the
 * dues-correction module's, `./dues-correction.ts`.
 *
 * Guarded by `ACTION.correctDues` like the corrections it shows, on the reasoning `manageJobs`
 * records: this screen is only useful to whoever may press its buttons. It deliberately does not
 * reuse `invoiceHistoryForUnit` in `./queries.ts`, which is guarded by `ACTION.readOverdue`
 * (`admin`'s), because a superuser who is not also an admin must be able to open this screen, and
 * because this screen needs each Alokasi as a row (id, payment, amount) where that one needs only
 * the sums. The sums and the status of each Tagihan are `invoiceStandings`'s, in
 * `./invoice-standing.ts` (#320): this module adds up no Alokasi of its own, and since #329 the
 * screen no longer decides lunas, sebagian or belum lunas itself either. It shows the status the
 * model carries, menunggak included.
 *
 * ## Why the history is read from the audit log, and only from there
 *
 * The corrections leave different domain traces: a voided Tagihan keeps its row, a refund keeps its
 * `refunds` rows, but a released Alokasi is *deleted*, by design
 * (`src/lib/server/db/schema/allocation.ts`), with the audit log named as where the fact survives.
 * A history stitched from different tables would therefore still need the audit log for one of its
 * parts, so every correction is read from the one place every one of them records, keyed by the
 * `unitId` each record carries in `after` for exactly this read. That is history-of-operations
 * territory (who did what, when, why), which is what the audit log is *for*; every rupiah the screen
 * shows as a balance still comes from the money tables through `creditBalanceOfUnit`, never from
 * audit `jsonb`.
 *
 * ## The history reads the records through their writers' types
 *
 * Each row is turned back into the record its writer wrote by `readDuesCorrectionRecord`, which
 * checks it against that action's type in `./dues-correction.ts`, and the amount and Periode shown
 * are the action's own `duesCorrectionSummary`. This module names no field of any record: the one
 * key the query filters on is `DUES_CORRECTION_UNIT_KEY`, typed against the field every record's
 * `after` carries.
 */

/**
 * Whether `actorId` may open the unit finance screen at all, as a question on its own, for the
 * screen's `load`: the same helper shape as `assertMayRecordCashTransactions`.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 */
export async function assertMayCorrectDues(db: Database, actorId: string): Promise<void> {
	await requirePermission(db, actorId, ACTION.correctDues);
}

/** One Alokasi as the release control needs it: enough to name it, and to release it. */
export interface FinanceAllocationRow {
	readonly allocationId: string;
	readonly paymentId: string;
	readonly amount: Rupiah;
	readonly createdAt: Date;
}

/** One Tagihan on the finance screen, with its Alokasi as rows rather than only a sum. */
export interface FinanceInvoiceRow {
	readonly invoiceId: string;
	readonly unitId: string;
	/** The calendar month it is for, as `YYYY-MM`. */
	readonly period: string;
	readonly amount: Rupiah;
	readonly allocatedAmount: Rupiah;
	/** `amount` less `allocatedAmount`. */
	readonly remainingAmount: Rupiah;
	/** Where the Tagihan stands on today's WIB day, as `invoiceStandings` decides it. */
	readonly status: InvoiceStatus;
	readonly dueDate: string;
	/** When this Tagihan was cancelled, or `null` while it stands. */
	readonly voidedAt: Date | null;
	readonly voidReason: string | null;
	/** Oldest first. Empty for a Tagihan nothing has paid toward. */
	readonly allocations: readonly FinanceAllocationRow[];
}

/**
 * One Pengembalian on the finance screen: one `refunds` row and its cash expense, with whether it is
 * still in force, for the reversal control.
 */
export interface FinanceRefundRow {
	readonly refundId: string;
	/** The Pembayaran whose remainder it consumed. */
	readonly paymentId: string;
	readonly amount: Rupiah;
	/** The day the money was handed back, off its cash expense row, as `YYYY-MM-DD`. */
	readonly occurredOn: string;
	/** Why it was returned. */
	readonly reason: string;
	/**
	 * Whether it still counts against the Saldo Titipan: `refundInForce` in `./credit-balance.ts`,
	 * the very condition the balance shown beside it is computed with.
	 */
	readonly inForce: boolean;
	/**
	 * The reason on the Koreksi that reversed it, or `null` while it is in force. Read off the Koreksi
	 * row itself, whose `description` is the reason the reversal was given.
	 */
	readonly reversalReason: string | null;
}

/** One Alokasi of a verified Pembayaran, as the payment list summarises it: which Tagihan, how much. */
export interface FinancePaymentAllocation {
	readonly allocationId: string;
	readonly invoiceId: string;
	/** The Tagihan's Periode, as `YYYY-MM`. */
	readonly period: string;
	readonly amount: Rupiah;
}

/** One verified Pembayaran on the finance screen, for the Pembatalan verifikasi control. */
export interface FinanceVerifiedPaymentRow {
	readonly paymentId: string;
	readonly amount: Rupiah;
	/** The day the money changed hands, as `YYYY-MM-DD`: the day its income line and Koreksi carry. */
	readonly receivedOn: string;
	readonly method: PaymentMethod;
	/** Who recorded it, by the display name of the account behind `payments.recordedBy`. */
	readonly recordedByName: string;
	/** Its Alokasi, oldest Periode first. Empty when all of it is Saldo Titipan. */
	readonly allocations: readonly FinancePaymentAllocation[];
}

/** The whole answer for one Unit's finance screen, short of the history. */
export interface UnitFinance {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/** The Unit's Saldo Titipan right now: computed, as always, never stored. */
	readonly creditBalance: Rupiah;
	/** Every Tagihan the house has ever had, voided ones included, newest Periode first. */
	readonly invoices: readonly FinanceInvoiceRow[];
	/** Every Pengembalian of the house's Pembayaran, reversed ones included, newest first. */
	readonly refunds: readonly FinanceRefundRow[];
	/** Every Pembayaran of the house that is verified right now, newest money first. */
	readonly verifiedPayments: readonly FinanceVerifiedPaymentRow[];
}

/**
 * One Unit's Saldo Titipan, Tagihan, Pengembalian and verified Pembayaran, each Tagihan carrying its
 * Alokasi as rows and its status: the reads the void, release, refund, reversal and Pembatalan
 * verifikasi controls decide themselves against.
 * No lock: this is a screen, and every write path re-reads what it needs under its own locks.
 *
 * Everything is read in one read-only `repeatable read` transaction, one snapshot for every
 * statement. Each Tagihan's `allocatedAmount` is then exactly the sum of the Alokasi rows listed
 * under it, and the Saldo Titipan is exactly what the listed Pengembalian in force leave of it: a
 * correction committing between two statements cannot make the screen show a number that disagrees
 * with its own list. (Before #329 the balance was read beside the snapshot, not in it.)
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {UnitNotFoundError} when `unitId` names no house.
 */
export async function unitFinanceFor(
	db: Database,
	clock: Clock,
	actorId: string,
	unitId: string
): Promise<UnitFinance> {
	await requirePermission(db, actorId, ACTION.correctDues);

	const [unit] = await db
		.select({ id: units.id, block: units.block, number: units.number })
		.from(units)
		.where(eq(units.id, unitId))
		.limit(1);
	if (!unit) {
		throw new UnitNotFoundError(unitId);
	}

	return db.transaction(
		// One client, so its statements run one after another: `Promise.all` over a transaction is
		// what `tests/unit/no-concurrent-client-query.test.ts` guards against.
		async (transaction) => {
			const creditBalance = await creditBalanceOfUnit(transaction, unitId);
			const rows = await transaction
				.select({
					invoiceId: invoices.id,
					unitId: invoices.unitId,
					period: invoices.period,
					amount: invoices.amount,
					dueDate: invoices.dueDate,
					voidedAt: invoices.voidedAt,
					voidReason: invoices.voidReason
				})
				.from(invoices)
				.where(eq(invoices.unitId, unitId))
				.orderBy(desc(invoices.period), asc(invoices.id));
			const standings = await invoiceStandings(transaction, clock, rows);
			const allocationsByInvoice = await allocationRowsByInvoice(
				transaction,
				rows.map((row) => row.invoiceId)
			);
			const refundRows = await refundRowsOfUnit(transaction, unitId);
			const verifiedPayments = await verifiedPaymentRowsOfUnit(transaction, unitId);
			return {
				unitId: unit.id,
				block: unit.block,
				number: unit.number,
				creditBalance,
				invoices: standings.map((row) => ({
					...row,
					allocations: allocationsByInvoice.get(row.invoiceId) ?? []
				})),
				refunds: refundRows,
				verifiedPayments
			};
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' }
	);
}

/** One line of the corrections history, whichever action it records. */
export interface CorrectionHistoryEntry extends DuesCorrectionSummary {
	/** The audit row's own id, for a list key. */
	readonly id: string;
	readonly action: DuesCorrectionAction;
	readonly occurredAt: Date;
	/** The account that acted, by display name, or its raw id when the account is gone. */
	readonly actorName: string;
	/** The reason the action recorded. Every dues correction requires one. */
	readonly reason: string;
}

/**
 * What a row shows when it is not the record its action's type describes: the blank reason and
 * empty amount and Periode the untyped reader before #324 showed for a field it could not find.
 * Unreachable for a row one of this codebase's writers wrote; see `./dues-correction.ts`.
 */
const UNREADABLE_RECORD = { reason: '', amount: null, period: null } as const;

/**
 * Every dues correction ever performed on `unitId`, newest first, read from the audit log, which
 * is the one place all of them survive; see this module's doc comment.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 */
export async function correctionsHistoryFor(
	db: Database,
	actorId: string,
	unitId: string
): Promise<readonly CorrectionHistoryEntry[]> {
	await requirePermission(db, actorId, ACTION.correctDues);

	const rows = await db
		.select({
			id: auditLog.id,
			action: auditLog.action,
			occurredAt: auditLog.occurredAt,
			actorId: auditLog.actorId,
			actorName: user.name,
			targetId: auditLog.targetId,
			before: auditLog.before,
			after: auditLog.after
		})
		.from(auditLog)
		// A left join, because `audit_log.actorId` deliberately carries no foreign key: the row must
		// outlive the account it names, and this screen then shows the raw id rather than nothing.
		.leftJoin(user, eq(user.id, auditLog.actorId))
		.where(
			and(
				inArray(auditLog.action, [...DUES_CORRECTION_ACTIONS]),
				sql`${auditLog.after} ->> ${DUES_CORRECTION_UNIT_KEY}::text = ${unitId}`
			)
		)
		.orderBy(desc(auditLog.occurredAt), desc(auditLog.id));

	return rows.flatMap((row) => {
		// Always true: the query asked for these actions only. It narrows `row.action` for the entry.
		if (!isDuesCorrectionAction(row.action)) {
			return [];
		}
		const record = readDuesCorrectionRecord(row);
		if (!record) {
			// Said in the log, because on the screen this row looks like a correction whose reason was
			// never given: a check in `RECORD_KINDS` that a new action's writer does not satisfy would
			// otherwise pass as missing data.
			console.warn(
				`Audit log row "${row.id}" (action "${row.action}") is not the record its action writes; the corrections history shows it with a blank reason and no amount.`
			);
		}
		const shown = record
			? { reason: record.after.reason, ...duesCorrectionSummary(record) }
			: UNREADABLE_RECORD;
		return [
			{
				id: row.id,
				action: row.action,
				occurredAt: row.occurredAt,
				actorName: row.actorName ?? row.actorId,
				...shown
			}
		];
	});
}

/** The Alokasi rows of every invoice in `invoiceIds`, grouped by invoice, oldest first. */
async function allocationRowsByInvoice(
	db: DatabaseWriter,
	invoiceIds: readonly string[]
): Promise<ReadonlyMap<string, readonly FinanceAllocationRow[]>> {
	if (invoiceIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			allocationId: allocations.id,
			invoiceId: allocations.invoiceId,
			paymentId: allocations.paymentId,
			amount: allocations.amount,
			createdAt: allocations.createdAt
		})
		.from(allocations)
		.where(inArray(allocations.invoiceId, invoiceIds))
		.orderBy(asc(allocations.createdAt), asc(allocations.id));

	const grouped = new Map<string, FinanceAllocationRow[]>();
	for (const row of rows) {
		const entry = {
			allocationId: row.allocationId,
			paymentId: row.paymentId,
			amount: row.amount,
			createdAt: row.createdAt
		};
		const existing = grouped.get(row.invoiceId);
		if (existing) {
			existing.push(entry);
		} else {
			grouped.set(row.invoiceId, [entry]);
		}
	}
	return grouped;
}

/** The name the Koreksi row goes by in `refundRowsOfUnit`'s subquery. */
const REVERSAL_ALIAS = 'reversal';

/**
 * Every Pengembalian of `unitId`'s Pembayaran, whatever the Pembayaran's status, newest money first,
 * each with its day off its cash expense row and whether it is still in force. The day lives only on
 * the cash row (`src/lib/server/db/schema/refund.ts`: "No `occurredOn` column"), so the join is the
 * one place it can come from.
 */
async function refundRowsOfUnit(
	db: DatabaseWriter,
	unitId: string
): Promise<readonly FinanceRefundRow[]> {
	// Its own name for the Koreksi row, so the subquery's columns are told apart from the outer
	// join's `cash_transactions`. Inside a raw `sql` template the alias renders as its bare name,
	// so the `from` names the table and the alias explicitly.
	const reversal = alias(cashTransactions, REVERSAL_ALIAS);
	return db
		.select({
			refundId: refunds.id,
			paymentId: refunds.paymentId,
			amount: refunds.amount,
			occurredOn: cashTransactions.occurredOn,
			reason: refunds.reason,
			inForce: sql<boolean>`${refundInForce()}`,
			// A scalar subquery rather than a join, so a line can never be listed twice. At most one
			// Koreksi exists per line (the writer's line lock), and `refundInForce` reads the same rows.
			reversalReason: sql<string | null>`(
				select ${reversal.description}
				from ${cashTransactions} as ${sql.identifier(REVERSAL_ALIAS)}
				where ${reversal.correctionOf} = ${refunds.cashTransactionId}
				order by ${reversal.createdAt}, ${reversal.id}
				limit 1
			)`
		})
		.from(refunds)
		.innerJoin(payments, eq(payments.id, refunds.paymentId))
		.innerJoin(cashTransactions, eq(cashTransactions.id, refunds.cashTransactionId))
		.where(eq(payments.unitId, unitId))
		.orderBy(desc(cashTransactions.occurredOn), desc(refunds.createdAt), desc(refunds.id));
}

/**
 * Every verified Pembayaran of `unitId`, newest money first (`receivedOn`, then `createdAt`, then
 * `id`, the reverse of the order a spender drains them in), each with its recorder's name and its
 * Alokasi. Read in the caller's snapshot, so the Alokasi listed here are the ones listed under the
 * Tagihan beside them.
 */
async function verifiedPaymentRowsOfUnit(
	db: DatabaseWriter,
	unitId: string
): Promise<readonly FinanceVerifiedPaymentRow[]> {
	const rows = await db
		.select({
			paymentId: payments.id,
			amount: payments.amount,
			receivedOn: payments.receivedOn,
			method: payments.method,
			recordedByName: user.name
		})
		.from(payments)
		.innerJoin(residents, eq(residents.id, payments.recordedBy))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(and(eq(payments.unitId, unitId), eq(payments.status, PAYMENT_STATUS.verified)))
		.orderBy(desc(payments.receivedOn), desc(payments.createdAt), desc(payments.id));
	if (rows.length === 0) {
		return [];
	}

	const allocated = await db
		.select({
			allocationId: allocations.id,
			paymentId: allocations.paymentId,
			invoiceId: allocations.invoiceId,
			period: invoices.period,
			amount: allocations.amount
		})
		.from(allocations)
		.innerJoin(invoices, eq(invoices.id, allocations.invoiceId))
		.where(
			inArray(
				allocations.paymentId,
				rows.map((row) => row.paymentId)
			)
		)
		.orderBy(asc(invoices.period), asc(allocations.createdAt), asc(allocations.id));

	const byPayment = new Map<string, FinancePaymentAllocation[]>();
	for (const row of allocated) {
		const entry = {
			allocationId: row.allocationId,
			invoiceId: row.invoiceId,
			period: row.period,
			amount: row.amount
		};
		const existing = byPayment.get(row.paymentId);
		if (existing) {
			existing.push(entry);
		} else {
			byPayment.set(row.paymentId, [entry]);
		}
	}
	return rows.map((row) => ({ ...row, allocations: byPayment.get(row.paymentId) ?? [] }));
}
