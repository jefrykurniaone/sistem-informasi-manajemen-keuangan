import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import { allocations } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import { occupancies } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { COMPLEX_TIME_ZONE } from './issuance';
import { firstDayOfPeriod } from './invoice';
import { isVisibleOn, unitVisibilityFor, type UnitVisibility } from '../occupancy/visibility';

/**
 * Reading Tagihan back, from the two angles `docs/spec-iuran-v1.md` asks a screen for: "saya masih
 * harus bayar berapa" for a warga, and "siapa saja yang menunggak" for an admin — a question the
 * spec is explicit nobody else may ask ("Daftar penunggak … hanya bisa dibuka oleh admin").
 * `./invoice.ts` and `./issuance.ts` own writing a Tagihan; this module only ever reads `invoices`
 * and `allocations` and writes nothing.
 *
 * ## Status is computed here, once, and nowhere else
 *
 * `invoices` has no status column — see that schema's own doc comment — so every screen that shows
 * "lunas", "sebagian", "belum bayar" or "menunggak" has to compute the same comparison the same way,
 * or two screens can disagree about one Tagihan. `invoiceStatus` below is that one comparison,
 * exported and pure so a test can walk every combination of amount, allocation and due date without
 * a database.
 *
 * ## Which "today" decides "sudah lewat jatuh tempo"
 *
 * This is the decision `./issuance.ts`'s own doc comment leaves to "the iuran spec", naming the gap
 * outright: `currentDay(clock)` in `../occupancy/visibility.ts` reads a **UTC** calendar day, while
 * `dueDateOfPeriod` in `./invoice.ts` writes a due date that means the fifth **in `COMPLEX_TIME_ZONE`
 * (Asia/Jakarta)** — the same zone issuance reads the Tarif and the Pembebasan against. Comparing a
 * Jakarta-meant date to a UTC-read "today" would not fail loudly; it would flip the menunggak badge
 * at the wrong instant, up to seven hours off, twice a day, forever.
 *
 * This module reads "today" in `COMPLEX_TIME_ZONE`, not in UTC, with `todayInComplexZone` below —
 * the same `Intl.DateTimeFormat(timeZone, …)` technique `civilDateFormatter` in
 * `src/lib/server/scheduler/registry.ts` already uses to turn an instant into a civil date without
 * depending on locale part order. The choice is deliberate rather than a copy of what the rest of
 * this codebase already does: `duesRateOn`'s "in force today" and `visibility.ts`'s "living here
 * now" both still read UTC, and both say plainly that is a known, accepted skew this ticket is not
 * the one to close. Menunggak is different — it is the one figure this whole spec exists to get
 * right ("saya masih harus bayar berapa"), it is read against a due date that was itself written in
 * Jakarta's calendar, and admin's daftar penunggak is exactly the number a pengurus acts on. Reusing
 * the UTC convention here would not be consistency; it would be the same seven-hour error the rest
 * of the codebase tolerates, applied to the one number this ticket is responsible for getting right.
 *
 * ## Voided Tagihan
 *
 * `void` is not one of the four states `docs/spec-iuran-v1.md` lists a warga's own Tagihan status
 * as — a cancelled Tagihan is not "belum bayar", it is nothing owed at all — so `invoicesForUser`
 * leaves voided rows out of a warga's own list entirely. Admin's `invoiceHistoryForUnit` is "seluruh
 * riwayat", so it keeps them, each carrying `INVOICE_STATUS.void` and the reason it was cancelled.
 */

/**
 * What a computed Tagihan status can be. Not in `CONTEXT.md`'s "Nama di kode" table because it is
 * not a stored value with a value set to enumerate — `docs/spec-iuran-v1.md:163-165` is explicit
 * that there is no status column at all. `void` is the one exception, and it is already the code
 * name `CONTEXT.md` gives "pembatalan Tagihan".
 */
export const INVOICE_STATUS = {
	paid: 'paid',
	partial: 'partial',
	unpaid: 'unpaid',
	overdue: 'overdue',
	void: 'void'
} as const;

/** One of the values `INVOICE_STATUS` names. */
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

/** Just enough of a Tagihan, plus what has been allocated to it, to decide its status. */
export interface InvoiceStatusInput {
	readonly amount: Rupiah;
	readonly allocatedAmount: Rupiah;
	/** The day payment is due, as `YYYY-MM-DD`. */
	readonly dueDate: string;
	/** When this Tagihan was cancelled, or `null` while it stands. */
	readonly voidedAt: Date | null;
}

/**
 * A Tagihan's status, computed rather than read — `docs/spec-iuran-v1.md:163-165` verbatim:
 * "Lunas, sebagian, atau belum bayar adalah perbandingan antara besaran Tagihan dan jumlah
 * Alokasinya. Menunggak adalah belum lunas dan sudah lewat jatuh tempo."
 *
 * Menunggak takes precedence over sebagian and belum bayar rather than sitting beside them: a
 * Tagihan that is both partly paid and past its due date is shown as menunggak, not sebagian, which
 * is what the glossary's own wording ("belum lunas **dan** sudah lewat jatuh tempo") asks for — it
 * describes one state, not a fifth combination.
 *
 * @param today the day, as `YYYY-MM-DD`, "sudah lewat jatuh tempo" is decided against. See this
 *   module's doc comment for why that day has to come from `todayInComplexZone`, not
 *   `currentDay(clock)`.
 */
export function invoiceStatus(invoice: InvoiceStatusInput, today: string): InvoiceStatus {
	if (invoice.voidedAt !== null) {
		return INVOICE_STATUS.void;
	}
	if (invoice.allocatedAmount >= invoice.amount) {
		return INVOICE_STATUS.paid;
	}
	if (invoice.dueDate < today) {
		return INVOICE_STATUS.overdue;
	}
	return invoice.allocatedAmount > 0 ? INVOICE_STATUS.partial : INVOICE_STATUS.unpaid;
}

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
 * it was issued during the stretch of days `../occupancy/visibility.ts` says that Masa Huni covers —
 * "Warga hanya melihat tagihan yang terbit dalam rentang masa huninya".
 *
 * `firstDayOfPeriod(invoice.period)` stands in for "the day this Tagihan was issued": issuance reads
 * the Tarif and the Pembebasan on exactly that day (see `./issuance.ts`), so it is the one day this
 * Tagihan's existence is actually decided on, and it is a value already carried by `period` rather
 * than a second date this module would have to invent. The filtering runs row by row through
 * `isVisibleOn` rather than pushing `visibilityDateFilter` into the query: a warga's own list is
 * already scoped to the handful of houses they have occupied, so there is no table scan this would
 * save, and `isVisibleOn` is the same published contract either way.
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
	const unitIds = await unitsEverOccupiedBy(db, viewerUserId);
	if (unitIds.length === 0) {
		return { invoices: [], totalOverdue: rupiah(0) };
	}

	const visibilityByUnit = new Map(
		await Promise.all(
			unitIds.map(async (unitId): Promise<readonly [string, UnitVisibility]> => [
				unitId,
				await unitVisibilityFor(db, { viewerUserId, unitId })
			])
		)
	);

	const rows = await invoiceRowsForUnits(db, unitIds, { includeVoid: false });
	const visibleRows = rows.filter((row) => {
		const visibility = visibilityByUnit.get(row.unitId);
		return visibility !== undefined && isVisibleOn(visibility, firstDayOfPeriod(row.period));
	});

	const allocatedByInvoice = await allocatedAmountsByInvoice(
		db,
		visibleRows.map((row) => row.invoiceId)
	);
	const today = todayInComplexZone(clock);

	const invoiceRows: ResidentInvoiceRow[] = visibleRows
		.map((row) => toInvoiceRow(row, allocatedByInvoice, today))
		.sort(byPeriodDescending);

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
 * A voided Tagihan is never menunggak — cancelling one is exactly the acknowledgement that nothing
 * is owed on it any more — and neither is one that is fully allocated despite being past due, which
 * is why the SQL filter (not void, past due) is only the first half of the test and the amount is
 * still checked in `toOverdueTotals` below.
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

	const today = todayInComplexZone(clock);
	const candidates = await db
		.select({
			invoiceId: invoices.id,
			unitId: invoices.unitId,
			block: units.block,
			number: units.number,
			amount: invoices.amount
		})
		.from(invoices)
		.innerJoin(units, eq(units.id, invoices.unitId))
		.where(and(isNull(invoices.voidedAt), lt(invoices.dueDate, today)));

	if (candidates.length === 0) {
		return [];
	}

	const allocatedByInvoice = await allocatedAmountsByInvoice(
		db,
		candidates.map((candidate) => candidate.invoiceId)
	);

	return toOverdueTotals(candidates, allocatedByInvoice);
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
	const allocatedByInvoice = await allocatedAmountsByInvoice(
		db,
		rows.map((row) => row.invoiceId)
	);
	const today = todayInComplexZone(clock);

	const invoiceRows = rows
		.map((row) => toHistoryRow(row, allocatedByInvoice, today))
		.sort(byPeriodDescending);

	return { unitId: unit.id, block: unit.block, number: unit.number, invoices: invoiceRows };
}

/** One raw row `invoiceRowsForUnits` selects, before an allocated amount or a status is attached. */
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

/** What `allocatedByInvoice` and `invoiceStatus` add to one `RawInvoiceRow`. */
interface ComputedInvoiceAmounts {
	readonly allocatedAmount: Rupiah;
	readonly remainingAmount: Rupiah;
	readonly status: InvoiceStatus;
}

/** The allocated amount, the remaining amount, and the status computed from both. */
function computeInvoiceAmounts(
	row: RawInvoiceRow,
	allocatedByInvoice: ReadonlyMap<string, Rupiah>,
	today: string
): ComputedInvoiceAmounts {
	const allocatedAmount = allocatedByInvoice.get(row.invoiceId) ?? rupiah(0);
	return {
		allocatedAmount,
		remainingAmount: rupiah(row.amount - allocatedAmount),
		status: invoiceStatus(
			{ amount: row.amount, allocatedAmount, dueDate: row.dueDate, voidedAt: row.voidedAt },
			today
		)
	};
}

/** `RawInvoiceRow`, plus the allocated amount and the status computed from it — a warga's own row. */
function toInvoiceRow(
	row: RawInvoiceRow,
	allocatedByInvoice: ReadonlyMap<string, Rupiah>,
	today: string
): ResidentInvoiceRow {
	return {
		invoiceId: row.invoiceId,
		unitId: row.unitId,
		block: row.block,
		number: row.number,
		period: row.period,
		amount: row.amount,
		dueDate: row.dueDate,
		issuedAt: row.issuedAt,
		...computeInvoiceAmounts(row, allocatedByInvoice, today)
	};
}

/** `RawInvoiceRow`, plus its computed amounts and its void reason — one row of admin's unit history. */
function toHistoryRow(
	row: RawInvoiceRow,
	allocatedByInvoice: ReadonlyMap<string, Rupiah>,
	today: string
): UnitInvoiceHistoryRow {
	return {
		invoiceId: row.invoiceId,
		period: row.period,
		amount: row.amount,
		dueDate: row.dueDate,
		issuedAt: row.issuedAt,
		voidReason: row.voidReason,
		...computeInvoiceAmounts(row, allocatedByInvoice, today)
	};
}

/** One candidate row `listOverdueUnits` reads before the allocated amount narrows it to menunggak. */
interface OverdueCandidateRow {
	readonly invoiceId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly amount: Rupiah;
}

/**
 * `candidates` — already past due and never voided — reduced to the houses that are still owed
 * money on at least one of them, aggregated and sorted largest total first.
 */
function toOverdueTotals(
	candidates: readonly OverdueCandidateRow[],
	allocatedByInvoice: ReadonlyMap<string, Rupiah>
): readonly OverdueUnitRow[] {
	const byUnit = new Map<
		string,
		{ block: string; number: string; overdueInvoiceCount: number; totalOverdue: number }
	>();

	for (const candidate of candidates) {
		const allocatedAmount = allocatedByInvoice.get(candidate.invoiceId) ?? rupiah(0);
		const remaining = candidate.amount - allocatedAmount;
		if (remaining <= 0) {
			continue;
		}

		const existing = byUnit.get(candidate.unitId);
		if (existing) {
			existing.overdueInvoiceCount += 1;
			existing.totalOverdue += remaining;
			continue;
		}
		byUnit.set(candidate.unitId, {
			block: candidate.block,
			number: candidate.number,
			overdueInvoiceCount: 1,
			totalOverdue: remaining
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

/** Every distinct house `viewerUserId` has ever had a Masa Huni of, in no particular order. */
async function unitsEverOccupiedBy(
	db: DatabaseWriter,
	viewerUserId: string
): Promise<readonly string[]> {
	const rows = await db
		.selectDistinct({ unitId: occupancies.unitId })
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.where(eq(residents.userId, viewerUserId));
	return rows.map((row) => row.unitId);
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

/**
 * How much has been allocated to each of `invoiceIds`, keyed by invoice id and absent for one with
 * no allocation at all — the caller reads a missing entry as zero.
 *
 * `::text` and `coalesce`, the same idiom `SIGNED_TOTAL` in `src/lib/server/services/cash/balance.ts`
 * uses: PostgreSQL widens `sum(bigint)` to `numeric`, which the driver would otherwise hand back as
 * a string only sometimes depending on how it happens to be configured, and `sum` over an empty
 * group is `null`.
 */
async function allocatedAmountsByInvoice(
	db: DatabaseWriter,
	invoiceIds: readonly string[]
): Promise<ReadonlyMap<string, Rupiah>> {
	if (invoiceIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			invoiceId: allocations.invoiceId,
			total: sql<string>`coalesce(sum(${allocations.amount}), 0)::text`
		})
		.from(allocations)
		.where(inArray(allocations.invoiceId, invoiceIds))
		.groupBy(allocations.invoiceId);

	return new Map(rows.map((row) => [row.invoiceId, rupiah(Number(row.total))]));
}

/**
 * A formatter that renders an instant as the calendar day it falls on in `COMPLEX_TIME_ZONE`. Built
 * once and reused — the same shape `civilDateFormatter` in `src/lib/server/scheduler/registry.ts`
 * already is, for the same reason: a fresh `Intl.DateTimeFormat` is not free to construct.
 */
const OVERDUE_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
	timeZone: COMPLEX_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/**
 * `YYYY-MM-DD` for the day `clock.now()` falls on **in `COMPLEX_TIME_ZONE`**, built from the parts
 * rather than a formatted string so the order never depends on locale. See this module's doc
 * comment for why "sudah lewat jatuh tempo" is decided in this zone and not in UTC.
 */
function todayInComplexZone(clock: Clock): string {
	const parts = OVERDUE_DAY_FORMATTER.formatToParts(clock.now());
	const partOfType = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${partOfType('year')}-${partOfType('month')}-${partOfType('day')}`;
}
