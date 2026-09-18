import { and, asc, count, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
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

/**
 * How many occupancies of each unit in `unitIds` are still running (`ended_on is null`) — "jumlah
 * penghuni aktifnya" on the admin screen. A unit with no running occupancy is absent from the
 * result rather than present with `0`; the caller defaults a missing entry to `0`.
 */
export async function countActiveOccupants(
	db: Database,
	unitIds: readonly string[]
): Promise<ReadonlyMap<string, number>> {
	if (unitIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({ unitId: occupancies.unitId, value: count() })
		.from(occupancies)
		.where(and(inArray(occupancies.unitId, unitIds), isNull(occupancies.endedOn)))
		.groupBy(occupancies.unitId);

	return new Map(rows.map((row) => [row.unitId, row.value]));
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
