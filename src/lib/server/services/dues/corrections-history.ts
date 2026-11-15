import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Rupiah } from '#lib/money.ts';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import type { Database } from '../../db';
import { allocations } from '../../db/schema/allocation';
import { auditLog } from '../../db/schema/audit';
import { user } from '../../db/schema/auth';
import { invoices } from '../../db/schema/invoice';
import { units } from '../../db/schema/unit';
import { creditBalanceOfUnit } from './credit-balance';
import {
	DUES_CORRECTION_ACTIONS,
	DUES_CORRECTION_UNIT_KEY,
	duesCorrectionSummary,
	isDuesCorrectionAction,
	readDuesCorrectionRecord,
	type DuesCorrectionAction,
	type DuesCorrectionSummary
} from './dues-correction';
import { allocatedAmountsOf } from './invoice-standing';
import { UnitNotFoundError } from './queries';

/**
 * The reads behind the unit finance screen: one Unit's Saldo Titipan, its Tagihan with their
 * Alokasi laid out for the void and release controls, and the history of the dues corrections, so
 * `src/routes/(app)/admin/units/[id]/finance/+page.server.ts` calls a service and composes no query
 * of its own. The corrections themselves, and the typed Audit Log record each one leaves, are the
 * dues-correction module's, `./dues-correction.ts`.
 *
 * Guarded by `ACTION.correctDues` like the corrections it shows, on the reasoning `manageJobs`
 * records: this screen is only useful to whoever may press its buttons. It deliberately does not
 * reuse `invoiceHistoryForUnit` in `./queries.ts`, which is guarded by `ACTION.readOverdue`
 * (`admin`'s), because a superuser who is not also an admin must be able to open this screen, and
 * because this screen needs each Alokasi as a row (id, payment, amount) where that one needs only
 * the sums. The sums themselves are `allocatedAmountsOf`'s, in `./invoice-standing.ts`: this module
 * adds up no Alokasi of its own.
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
	/** The calendar month it is for, as `YYYY-MM`. */
	readonly period: string;
	readonly amount: Rupiah;
	readonly allocatedAmount: Rupiah;
	/** `amount` less `allocatedAmount`. */
	readonly remainingAmount: Rupiah;
	readonly dueDate: string;
	/** When this Tagihan was cancelled, or `null` while it stands. */
	readonly voidedAt: Date | null;
	readonly voidReason: string | null;
	/** Oldest first. Empty for a Tagihan nothing has paid toward. */
	readonly allocations: readonly FinanceAllocationRow[];
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
}

/**
 * One Unit's Saldo Titipan and Tagihan, each Tagihan carrying its Alokasi as rows: the reads the
 * void, release and refund controls decide themselves against. No lock: this is a screen, and every
 * write path re-reads what it needs under its own locks.
 *
 * The Tagihan, their allocated sums and their Alokasi rows are read in one read-only `repeatable
 * read` transaction, one snapshot for all three statements. Each Tagihan's `allocatedAmount` is
 * then exactly the sum of the Alokasi rows listed under it, as it was when this function still
 * added those rows up itself: a correction committing between two statements cannot make the
 * screen show a sum that disagrees with its own list.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {UnitNotFoundError} when `unitId` names no house.
 */
export async function unitFinanceFor(
	db: Database,
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

	const [creditBalance, invoiceRows] = await Promise.all([
		creditBalanceOfUnit(db, unitId),
		db.transaction(
			// One client, so its three statements run one after another: `Promise.all` over a
			// transaction is what `tests/unit/no-concurrent-client-query.test.ts` guards against.
			async (transaction) => {
				const rows = await transaction
					.select({
						invoiceId: invoices.id,
						period: invoices.period,
						amount: invoices.amount,
						dueDate: invoices.dueDate,
						voidedAt: invoices.voidedAt,
						voidReason: invoices.voidReason
					})
					.from(invoices)
					.where(eq(invoices.unitId, unitId))
					.orderBy(desc(invoices.period), asc(invoices.id));
				const withAmounts = await allocatedAmountsOf(transaction, rows);
				const allocationsByInvoice = await allocationRowsByInvoice(
					transaction,
					rows.map((row) => row.invoiceId)
				);
				return withAmounts.map((row) => ({
					...row,
					allocations: allocationsByInvoice.get(row.invoiceId) ?? []
				}));
			},
			{ isolationLevel: 'repeatable read', accessMode: 'read only' }
		)
	]);

	return {
		unitId: unit.id,
		block: unit.block,
		number: unit.number,
		creditBalance,
		invoices: invoiceRows
	};
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
