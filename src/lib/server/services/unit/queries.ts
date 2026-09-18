import { and, asc, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { occupancies } from '../../db/schema/occupancy';
import { units, type Unit } from '../../db/schema/unit';

/**
 * Raw reads against `units` and `occupancies`, with no permission decision in them. The service
 * layer in `./index.ts` is the only caller, and it is the one that calls `requirePermission`
 * before any of these run — see the note there on why the split is drawn this way.
 */

/** One page of the admin unit list, before pagination is decided. */
export interface UnitPageQuery {
	/** 1-based. */
	readonly page: number;
	readonly pageSize: number;
	/** Matched against `block` and `number`, case-insensitively, as a substring. */
	readonly search?: string;
	/** `false` (the default the screen starts on) hides a unit once it is deactivated. */
	readonly includeInactive: boolean;
}

/** A page of `units` rows, plus how many rows the filter matches in total. */
export interface UnitPageResult {
	readonly rows: readonly Unit[];
	readonly totalCount: number;
}

/**
 * One page of `units`, filtered by search and active status, ordered by block then number —
 * the order a resident reads a street sign in.
 */
export async function queryUnitsPage(db: Database, query: UnitPageQuery): Promise<UnitPageResult> {
	const filter = buildUnitFilter(query);

	const [rows, totalRows] = await Promise.all([
		db
			.select()
			.from(units)
			.where(filter)
			.orderBy(asc(units.block), asc(units.number))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(units).where(filter)
	]);

	return { rows, totalCount: totalRows[0]?.value ?? 0 };
}

/** The one row named by `unitId`, or `undefined` when there is none. */
export async function findUnitById(db: Database, unitId: string): Promise<Unit | undefined> {
	const [row] = await db.select().from(units).where(eq(units.id, unitId));
	return row;
}

/** What the admin screens need to know about one unit's running occupancies. */
export interface OccupancySummary {
	/** How many occupancies of the unit are still running. */
	readonly activeOccupantCount: number;
	/** Whether one of those running occupancies is the unit's primary occupant. */
	readonly hasPrimaryOccupant: boolean;
}

/**
 * The running occupancies (`ended_on is null`) of each unit in `unitIds`, summarised — "jumlah
 * penghuni aktifnya" and whether anyone is currently the Penanggung Jawab. A unit with no running
 * occupancy is absent from the result rather than present with zeroes; the caller defaults a missing
 * entry to none.
 *
 * **Both halves read "running" as `ended_on is null`**, the same predicate
 * `occupancies_primary_occupant_unique` uses. So `hasPrimaryOccupant` means exactly "the slot the
 * database guards is filled", and a primary occupant whose end date has been written but has not
 * arrived yet counts as gone here. That is deliberate and it is the conservative direction: the unit
 * shows up on the admin list as needing a primary occupant while there is still time to name the
 * successor, rather than on the day the invoices go out with nobody to address them to.
 */
export async function summarizeActiveOccupancies(
	db: Database,
	unitIds: readonly string[]
): Promise<ReadonlyMap<string, OccupancySummary>> {
	if (unitIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			unitId: occupancies.unitId,
			activeOccupantCount: count(),
			hasPrimaryOccupant: sql<boolean>`bool_or(${occupancies.isPrimaryOccupant})`
		})
		.from(occupancies)
		.where(and(inArray(occupancies.unitId, unitIds), isNull(occupancies.endedOn)))
		.groupBy(occupancies.unitId);

	return new Map(
		rows.map(({ unitId, activeOccupantCount, hasPrimaryOccupant }) => [
			unitId,
			{ activeOccupantCount, hasPrimaryOccupant }
		])
	);
}

/**
 * The combined filter a unit list page reads through: active-only unless asked otherwise, and a
 * substring match on block or number when a search term is given. `and()` drops an `undefined`
 * argument, so an empty search and `includeInactive: true` together yield an unfiltered `where`.
 */
function buildUnitFilter(query: UnitPageQuery) {
	const search = query.search?.trim();
	return and(
		query.includeInactive ? undefined : eq(units.isActive, true),
		search ? or(ilike(units.block, `%${search}%`), ilike(units.number, `%${search}%`)) : undefined
	);
}
