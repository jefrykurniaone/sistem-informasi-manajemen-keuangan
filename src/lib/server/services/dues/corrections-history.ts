import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import type { Database } from '../../db';
import { allocations } from '../../db/schema/allocation';
import { auditLog } from '../../db/schema/audit';
import { user } from '../../db/schema/auth';
import { invoices } from '../../db/schema/invoice';
import { units } from '../../db/schema/unit';
import { ALLOCATION_RELEASED_ACTION } from './allocation-release';
import { creditBalanceOfUnit } from './credit-balance';
import { CREDIT_REFUNDED_ACTION } from './credit-refund';
import { INVOICE_VOIDED_ACTION } from './invoice-void';
import { UnitNotFoundError } from './queries';

/**
 * The reads behind the unit finance screen — one Unit's saldo titipan, its Tagihan with their
 * Alokasi laid out for the void and release controls, and the history of the three corrections —
 * so `src/routes/(app)/admin/units/[id]/finance/+page.server.ts` calls a service and composes no
 * query of its own.
 *
 * Guarded by `ACTION.correctDues` like the three writers beside it, on the reasoning `manageJobs`
 * records: this screen is only useful to whoever may press its buttons. It deliberately does not
 * reuse `invoiceHistoryForUnit` in `./queries.ts`, which is guarded by `ACTION.readOverdue` —
 * `admin`'s — because a superuser who is not also an admin must be able to open this screen, and
 * because this screen needs each Alokasi as a row (id, payment, amount) where that one needs only
 * the sums.
 *
 * ## Why the history is read from the audit log, and only from there
 *
 * The three actions leave different domain traces: a voided Tagihan keeps its row, a refund keeps
 * its `refunds` rows, but a released Alokasi is *deleted* — by design
 * (`src/lib/server/db/schema/allocation.ts`), with the audit log named as where the fact survives.
 * A history stitched from three different tables would therefore still need the audit log for one
 * of its thirds, so all three are read from the one place all three writers already record, keyed
 * by the `unitId` each writer puts in `after` for exactly this read. That is history-of-operations
 * territory — who did what, when, why — which is what the audit log is *for*; every rupiah the
 * screen shows as a balance still comes from the money tables through `creditBalanceOfUnit`,
 * never from audit `jsonb`.
 */

/** The three audit actions this screen calls history, in one list for the one query that reads them. */
const CORRECTION_ACTIONS = [
	INVOICE_VOIDED_ACTION,
	ALLOCATION_RELEASED_ACTION,
	CREDIT_REFUNDED_ACTION
] as const;

/** One of the three correction action names. */
export type CorrectionAction = (typeof CORRECTION_ACTIONS)[number];

/**
 * Whether `actorId` may open the unit finance screen at all, as a question on its own — for the
 * screen's `load`, the same helper shape as `assertMayRecordCashTransactions`.
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
	/** The Unit's saldo titipan right now — computed, as always, never stored. */
	readonly creditBalance: Rupiah;
	/** Every Tagihan the house has ever had, voided ones included, newest Periode first. */
	readonly invoices: readonly FinanceInvoiceRow[];
}

/**
 * One Unit's saldo titipan and Tagihan, each Tagihan carrying its Alokasi as rows — the reads the
 * void, release and refund controls decide themselves against. Plain reads with no lock: this is
 * a screen, and every write path re-reads what it needs under its own locks.
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
		db
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
			.orderBy(desc(invoices.period), asc(invoices.id))
	]);

	const allocationsByInvoice = await allocationRowsByInvoice(
		db,
		invoiceRows.map((row) => row.invoiceId)
	);

	return {
		unitId: unit.id,
		block: unit.block,
		number: unit.number,
		creditBalance,
		invoices: invoiceRows.map((row) => {
			const rows = allocationsByInvoice.get(row.invoiceId) ?? [];
			const allocatedAmount = rupiah(rows.reduce((total, each) => total + each.amount, 0));
			return {
				...row,
				allocatedAmount,
				remainingAmount: rupiah(row.amount - allocatedAmount),
				allocations: rows
			};
		})
	};
}

/** One line of the corrections history, whichever of the three actions it records. */
export interface CorrectionHistoryEntry {
	/** The audit row's own id, for a list key. */
	readonly id: string;
	readonly action: CorrectionAction;
	readonly occurredAt: Date;
	/** The account that acted, by display name — or its raw id when the account is gone. */
	readonly actorName: string;
	/** The reason the action recorded. Every one of the three requires one. */
	readonly reason: string;
	/** The money the action was about: the voided Tagihan's, the released Alokasi's, the refund's. */
	readonly amount: Rupiah | null;
	/** The Periode, for a voided Tagihan; null for the other two actions. */
	readonly period: string | null;
}

/**
 * Every void, release and refund ever performed on `unitId`, newest first — read from the audit
 * log, which is the one place all three survive; see this module's doc comment.
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
			before: auditLog.before,
			after: auditLog.after
		})
		.from(auditLog)
		// A left join, because `audit_log.actorId` deliberately carries no foreign key: the row must
		// outlive the account it names, and this screen then shows the raw id rather than nothing.
		.leftJoin(user, eq(user.id, auditLog.actorId))
		.where(
			and(
				inArray(auditLog.action, [...CORRECTION_ACTIONS]),
				sql`${auditLog.after}->>'unitId' = ${unitId}`
			)
		)
		.orderBy(desc(auditLog.occurredAt), desc(auditLog.id));

	return rows.map((row) => ({
		id: row.id,
		action: row.action as CorrectionAction,
		occurredAt: row.occurredAt,
		actorName: row.actorName ?? row.actorId,
		reason: stringField(row.after, 'reason') ?? '',
		// The released Alokasi's amount lives in `before` (the deleted row's content); the other two
		// record theirs in `after`.
		amount: numberFieldAsRupiah(row.after, 'amount') ?? numberFieldAsRupiah(row.before, 'amount'),
		period: stringField(row.after, 'period')
	}));
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

/** `field` off an audit `jsonb` value, when it is there and is a string. */
function stringField(value: unknown, field: string): string | null {
	if (typeof value === 'object' && value !== null && field in value) {
		const found = (value as Record<string, unknown>)[field];
		if (typeof found === 'string') {
			return found;
		}
	}
	return null;
}

/** `field` off an audit `jsonb` value as Rupiah, when it is there and is a number. */
function numberFieldAsRupiah(value: unknown, field: string): Rupiah | null {
	if (typeof value === 'object' && value !== null && field in value) {
		const found = (value as Record<string, unknown>)[field];
		if (typeof found === 'number') {
			return rupiah(found);
		}
	}
	return null;
}
