import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { occupancies } from '../../db/schema/occupancy';
import { units, type Unit } from '../../db/schema/unit';
import { stillRunningOn } from '../occupancy/visibility';

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

/** What the admin screens need to know about one unit's occupancies. */
export interface OccupancySummary {
	/** How many people are living in the unit on the day this was asked about. */
	readonly activeOccupantCount: number;
	/** Whether the primary-occupant slot the database guards is currently filled. */
	readonly hasPrimaryOccupant: boolean;
}

/**
 * Each unit in `unitIds` summarised as of `today` — "jumlah penghuni aktifnya" and whether anyone
 * holds the Penanggung Jawab slot. A unit nobody is living in is absent from the result rather than
 * present with zeroes; the caller defaults a missing entry to none.
 *
 * **The two halves deliberately ask two different questions, with two different predicates.** They
 * used to share one, and sharing it put a false sentence on the screen.
 *
 * - `activeOccupantCount` counts a stay that is **still running on `today`**: `ended_on is null or
 *   ended_on >= today`. An end date written before it arrives — someone announcing in March that
 *   they leave next year — does not stop them living there in the meantime, and counting them as
 *   gone told a resident their own house had no occupants.
 * - `hasPrimaryOccupant` stays on `ended_on is null`, the predicate
 *   `occupancies_primary_occupant_unique` itself uses, so it means exactly "the slot the database
 *   guards is filled". A primary occupant with a future end date therefore reads as gone *here*, and
 *   that is the conservative direction on purpose: the unit surfaces on the admin list as needing a
 *   successor while there is still time to name one, rather than on the day the invoices go out with
 *   nobody to address them to. The `filter (where …)` clause is what keeps this half narrow while the
 *   row set around it is the wider one.
 *
 * `coalesce` is not decoration: `bool_or` over an empty filtered set is `null`, which would reach the
 * screen as a missing answer rather than as "no".
 */
export async function summarizeActiveOccupancies(
	db: Database,
	today: string,
	unitIds: readonly string[]
): Promise<ReadonlyMap<string, OccupancySummary>> {
	if (unitIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			unitId: occupancies.unitId,
			activeOccupantCount: count(),
			hasPrimaryOccupant: sql<boolean>`coalesce(bool_or(${occupancies.isPrimaryOccupant}) filter (where ${occupancies.endedOn} is null), false)`
		})
		.from(occupancies)
		.where(and(inArray(occupancies.unitId, unitIds), stillRunningOn(occupancies.endedOn, today)))
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
