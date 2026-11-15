import { and, eq, inArray, isNull } from 'drizzle-orm';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import { invoices } from '../../db/schema/invoice';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { residentViewFor } from '../occupancy/resident-view';
import {
	INVOICE_STATUS,
	invoiceStandings,
	type InvoiceStanding,
	type InvoiceStatus
} from './invoice-standing';

/**
 * Reading Tagihan back, from the two angles `docs/spec-iuran-v1.md` asks a screen for: "saya masih
 * harus bayar berapa" for a warga, and "siapa saja yang menunggak" for an admin — a question the
 * spec is explicit nobody else may ask ("Daftar penunggak … hanya bisa dibuka oleh admin").
 * `./invoice.ts` and `./issuance.ts` own writing a Tagihan; this module only ever reads `invoices`
 * and writes nothing.
 *
 * ## Where a Tagihan stands is not decided here
 *
 * `invoices` has no status column — see that schema's own doc comment — so every screen that shows
 * "lunas", "sebagian", "belum bayar" or "menunggak" has to compute the same thing the same way, or
 * two screens can disagree about one Tagihan. Since #320 every read below selects its Tagihan and
 * hands them to `invoiceStandings` in `./invoice-standing.ts`, which sums their Alokasi, subtracts,
 * and decides the status on today's WIB day (`civilDayOf` in `src/lib/time.ts`, read once per call).
 * This module adds no sum, no remainder and no "today" of its own: it chooses which Tagihan, joins
 * the house's block and number, and sorts.
 *
 * "Today" is the WIB day because a due date is: `dueDateOfPeriod` in `./invoice.ts` writes the fifth
 * of the month in Jakarta's calendar, so menunggak flips at WIB midnight, not seven hours later.
 *
 * ## Voided Tagihan
 *
 * `void` is not one of the four states `docs/spec-iuran-v1.md` lists a warga's own Tagihan status
 * as — a cancelled Tagihan is not "belum bayar", it is nothing owed at all — so `invoicesForUser`
 * leaves voided rows out of a warga's own list entirely. Admin's `invoiceHistoryForUnit` is "seluruh
 * riwayat", so it keeps them, each carrying `INVOICE_STATUS.void` and the reason it was cancelled.
 */

/**
 * The status vocabulary, and its pure rule, re-exported from `./invoice-standing.ts` where they now
 * live. The re-export keeps the imports outside #320's surface compiling unchanged: the type in
 * `src/lib/components/dues/invoice-status-badge.svelte` and `invoice-card.svelte`, and the rule in
 * `tests/unit/invoice-void.test.ts`. A new caller imports from `./invoice-standing.ts`.
 */
export { INVOICE_STATUS, invoiceStatus, type InvoiceStatus } from './invoice-standing';

/**
 * Thrown by `invoiceHistoryForUnit` when `unitId` names no row.
 *
 * A copy of the same shape `UnitNotFoundError` in `src/lib/server/services/unit/index.ts` already
 * is, declared again here rather than imported: this ticket's `writes:` does not touch that module,
 * and a route only ever needs an `instanceof`-checkable class from whichever service it called.
 */
export class UnitNotFoundError extends Error {
	override readonly name = 'UnitNotFoundError';

	/** The id that named no unit. */
	readonly unitId: string;

	constructor(unitId: string) {
		super(`No unit exists with id "${unitId}".`);
		this.unitId = unitId;
	}
}

/** One Tagihan on a warga's own list. */
export interface ResidentInvoiceRow {
	readonly invoiceId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly period: string;
	readonly amount: Rupiah;
	readonly allocatedAmount: Rupiah;
	/** `amount` less `allocatedAmount` — what is still owed on this one Tagihan. */
	readonly remainingAmount: Rupiah;
	readonly dueDate: string;
	readonly issuedAt: Date;
	readonly status: InvoiceStatus;
}

/** A warga's own Tagihan, and the one number `docs/spec-iuran-v1.md` asks them to see without adding up. */
export interface ResidentInvoicesView {
	/** Newest Periode first. Never includes a voided Tagihan — see this module's doc comment. */
	readonly invoices: readonly ResidentInvoiceRow[];
	/** The sum of `remainingAmount` over every Tagihan whose status is `overdue`. */
	readonly totalOverdue: Rupiah;
}

/**
 * A warga's own Tagihan across every house they have ever been recorded living in, each one only if
 * it falls inside their own Masa Huni of that house — "Warga hanya melihat tagihan yang terbit dalam
 * rentang masa huninya".
 *
 * Which houses those are, and which of a house's Tagihan this person may see, are both answered by
 * `residentViewFor` in `../occupancy/resident-view.ts`, the one module every personal screen asks;
 * the view is handed to `invoiceStandings` as `visibleTo`, which keeps only the Tagihan that
 * module's `isInvoiceVisible` lets this person see. That module reads no role, so a superuser or an
 * admin who lives in a house sees here exactly what any other Warga of that house would: never the
 * months a previous occupant left behind. The admin screens (`invoiceHistoryForUnit` below) are
 * where a house's whole history is shown.
 *
 * Refuses nobody and checks no permission: the only key this function takes is the caller's own
 * account id, the same reasoning `occupiedUnitsForUser` in `../occupancy/index.ts` and
 * `residentProfileForUser` in `../resident/profile.ts` both give for guarding by row ownership
 * instead. An account recorded in no house at all — including one with no `residents` row yet — gets
 * an empty view, which is an expected state rather than an error.
 */
export async function invoicesForUser(
	db: DatabaseWriter,
	clock: Clock,
	viewerUserId: string
): Promise<ResidentInvoicesView> {
	const view = await residentViewFor(db, clock, viewerUserId);
	const unitIds = view.units.map((unit) => unit.unitId);
	if (unitIds.length === 0) {
		return { invoices: [], totalOverdue: rupiah(0) };
	}

	const rows = await invoiceRowsForUnits(db, unitIds, { includeVoid: false });
	const standings = await invoiceStandings(db, clock, rows, { visibleTo: view });

	const invoiceRows: ResidentInvoiceRow[] = standings.map(toInvoiceRow).sort(byPeriodDescending);

	const totalOverdue = rupiah(
		invoiceRows
			.filter((row) => row.status === INVOICE_STATUS.overdue)
			.reduce((total, row) => total + row.remainingAmount, 0)
	);

	return { invoices: invoiceRows, totalOverdue };
}

/** One house on admin's daftar penunggak. */
export interface OverdueUnitRow {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/** How many Tagihan of this house are menunggak. */
	readonly overdueInvoiceCount: number;
	/** The sum of what is still owed across every one of those Tagihan. */
	readonly totalOverdue: Rupiah;
}

/**
 * Every house with at least one Tagihan menunggak, largest total first — "Admin melihat daftar
 * rumah yang menunggak beserta unit, jumlah bulan, dan total tunggakan, terurut dari yang terbesar."
 *
 * Menunggak is `invoiceStandings`'s `overdue`, never a date comparison written here. A voided
 * Tagihan is never menunggak — cancelling one is exactly the acknowledgement that nothing is owed on
 * it any more — so the `where` clause leaves voided rows out before anything is summed. Every other
 * Tagihan of the complex is read and judged, including the ones not yet due; those are at most one
 * month per house, and filtering them in SQL would need a second "today" beside the one
 * `invoiceStandings` reads.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `ACTION.readOverdue` — "Peran warga
 *   tidak dapat membuka daftar penunggak", including a direct call that skips the screen entirely.
 */
export async function listOverdueUnits(
	db: DatabaseWriter,
	clock: Clock,
	actorId: string
): Promise<readonly OverdueUnitRow[]> {
	await requirePermission(db, actorId, ACTION.readOverdue);

	const candidates = await db
		.select({
			invoiceId: invoices.id,
			unitId: invoices.unitId,
			block: units.block,
			number: units.number,
			period: invoices.period,
			amount: invoices.amount,
			dueDate: invoices.dueDate,
			voidedAt: invoices.voidedAt
		})
		.from(invoices)
		.innerJoin(units, eq(units.id, invoices.unitId))
		.where(isNull(invoices.voidedAt));

	return toOverdueTotals(await invoiceStandings(db, clock, candidates));
}

/** One Tagihan on admin's full history screen for a house. */
export interface UnitInvoiceHistoryRow {
	readonly invoiceId: string;
	readonly period: string;
	readonly amount: Rupiah;
	readonly allocatedAmount: Rupiah;
	readonly remainingAmount: Rupiah;
	readonly dueDate: string;
	readonly issuedAt: Date;
	readonly status: InvoiceStatus;
	readonly voidReason: string | null;
}

/** A house, and its whole Tagihan history — admin's `/admin/overdue/[unitId]` screen. */
export interface UnitInvoiceHistory {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/** Newest Periode first, including a voided Tagihan. */
	readonly invoices: readonly UnitInvoiceHistoryRow[];
}

/**
 * Every Tagihan a house has ever had, whatever Masa Huni was running when it was issued — "Admin
 * melihat seluruh riwayat tagihan sebuah unit, termasuk sebelum masa huni penghuni sekarang." Unlike
 * `invoicesForUser`, nothing here is filtered by occupancy: that filter exists to protect a warga
 * from a previous occupant's history, and it has nothing to protect admin from.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `ACTION.readOverdue`.
 * @throws {UnitNotFoundError} when `unitId` names no house.
 */
export async function invoiceHistoryForUnit(
	db: DatabaseWriter,
	clock: Clock,
	actorId: string,
	unitId: string
): Promise<UnitInvoiceHistory> {
	await requirePermission(db, actorId, ACTION.readOverdue);

	const [unit] = await db
		.select({ id: units.id, block: units.block, number: units.number })
		.from(units)
		.where(eq(units.id, unitId))
		.limit(1);
	if (!unit) {
		throw new UnitNotFoundError(unitId);
	}

	const rows = await invoiceRowsForUnits(db, [unitId], { includeVoid: true });
	const invoiceRows = (await invoiceStandings(db, clock, rows))
		.map(toHistoryRow)
		.sort(byPeriodDescending);

	return { unitId: unit.id, block: unit.block, number: unit.number, invoices: invoiceRows };
}

/** One raw row `invoiceRowsForUnits` selects, before `invoiceStandings` adds its amounts and status. */
interface RawInvoiceRow {
	readonly invoiceId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly period: string;
	readonly amount: Rupiah;
	readonly dueDate: string;
	readonly issuedAt: Date;
	readonly voidedAt: Date | null;
	readonly voidReason: string | null;
}

/** One `RawInvoiceRow` with where it stands, as `invoiceStandings` hands it back. */
type StandingInvoiceRow = RawInvoiceRow & InvoiceStanding;

/** A warga's own row: the fields their screen shows, and nothing it does not. */
function toInvoiceRow(row: StandingInvoiceRow): ResidentInvoiceRow {
	return {
		invoiceId: row.invoiceId,
		unitId: row.unitId,
		block: row.block,
		number: row.number,
		period: row.period,
		amount: row.amount,
		allocatedAmount: row.allocatedAmount,
		remainingAmount: row.remainingAmount,
		dueDate: row.dueDate,
		issuedAt: row.issuedAt,
		status: row.status
	};
}

/** One row of admin's unit history: a warga's fields less the house, plus the void reason. */
function toHistoryRow(row: StandingInvoiceRow): UnitInvoiceHistoryRow {
	return {
		invoiceId: row.invoiceId,
		period: row.period,
		amount: row.amount,
		allocatedAmount: row.allocatedAmount,
		remainingAmount: row.remainingAmount,
		dueDate: row.dueDate,
		issuedAt: row.issuedAt,
		status: row.status,
		voidReason: row.voidReason
	};
}

/** One standing Tagihan `listOverdueUnits` reads, with the house it belongs to. */
interface OverdueCandidateRow extends InvoiceStanding {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
}

/**
 * `candidates` reduced to their menunggak Tagihan, aggregated per house and sorted largest total
 * first. What is still owed is each Tagihan's `remainingAmount`, never its full amount.
 */
function toOverdueTotals(candidates: readonly OverdueCandidateRow[]): readonly OverdueUnitRow[] {
	const byUnit = new Map<
		string,
		{ block: string; number: string; overdueInvoiceCount: number; totalOverdue: number }
	>();

	for (const candidate of candidates) {
		if (candidate.status !== INVOICE_STATUS.overdue) {
			continue;
		}

		const existing = byUnit.get(candidate.unitId);
		if (existing) {
			existing.overdueInvoiceCount += 1;
			existing.totalOverdue += candidate.remainingAmount;
			continue;
		}
		byUnit.set(candidate.unitId, {
			block: candidate.block,
			number: candidate.number,
			overdueInvoiceCount: 1,
			totalOverdue: candidate.remainingAmount
		});
	}

	return Array.from(byUnit.entries())
		.map(([unitId, totals]) => ({
			unitId,
			block: totals.block,
			number: totals.number,
			overdueInvoiceCount: totals.overdueInvoiceCount,
			totalOverdue: rupiah(totals.totalOverdue)
		}))
		.sort(
			(left, right) =>
				right.totalOverdue - left.totalOverdue || left.block.localeCompare(right.block)
		);
}

/** Newest Periode first. Fixed-width, zero-padded `YYYY-MM` periods sort correctly as plain text. */
function byPeriodDescending(
	left: { readonly period: string },
	right: { readonly period: string }
): number {
	if (left.period === right.period) {
		return 0;
	}
	return left.period > right.period ? -1 : 1;
}

/** Every Tagihan of the houses in `unitIds`, with the house's own block and number attached. */
async function invoiceRowsForUnits(
	db: DatabaseWriter,
	unitIds: readonly string[],
	options: { readonly includeVoid: boolean }
): Promise<readonly RawInvoiceRow[]> {
	return db
		.select({
			invoiceId: invoices.id,
			unitId: invoices.unitId,
			block: units.block,
			number: units.number,
			period: invoices.period,
			amount: invoices.amount,
			dueDate: invoices.dueDate,
			issuedAt: invoices.issuedAt,
			voidedAt: invoices.voidedAt,
			voidReason: invoices.voidReason
		})
		.from(invoices)
		.innerJoin(units, eq(units.id, invoices.unitId))
		.where(
			and(
				inArray(invoices.unitId, unitIds),
				options.includeVoid ? undefined : isNull(invoices.voidedAt)
			)
		);
}
