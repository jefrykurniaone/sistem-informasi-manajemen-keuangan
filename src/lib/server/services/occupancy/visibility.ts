import { and, asc, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { civilDayOf } from '$lib/time';
import { ACTION, isAllowed, rolesOf, type DatabaseWriter } from '../../authz';
import { occupancies } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import type { Clock } from '../../ports/clock';

/**
 * **What a person may see of one Unit, expressed as calendar days.**
 *
 * `spec-warga-unit-v1.md` asks for this as a published contract rather than as a rule each screen
 * re-implements: "Warga hanya melihat data rumahnya untuk rentang waktu ia menghuninya. Ini
 * keputusan yang diambil di lapisan service dan disediakan sebagai satu fungsi yang dipakai spec
 * keuangan". The iuran spec and the kas-laporan spec both filter rows by date against this module;
 * neither reads `occupancies` for itself, and neither decides on its own what a resident may see.
 *
 * ## The shape, and why it is this one
 *
 * `unitVisibilityFor` answers with a `UnitVisibility`, which has exactly **two** cases:
 *
 * - `{ kind: 'all' }` — no date restriction at all. This is the answer for whoever holds
 *   `ACTION.manageOccupancies`, which is the "admin melihat seluruh riwayat Unit" half of the spec.
 * - `{ kind: 'ranges', ranges }` — only these stretches of days, both ends inclusive, sorted and
 *   non-overlapping. An empty `ranges` is the honest answer for someone who never lived here, so
 *   "sees nothing" needs no third case of its own. A caller that forgets a case it did not know
 *   existed is how a financial screen leaks a previous occupant's invoices, so there are two cases
 *   and no more.
 *
 * Two shapes were rejected on the way here, and the reasons are worth keeping:
 *
 * - **A single `{ from, to }` pair** cannot say the truth about someone who moved out and moved
 *   back in later. Collapsing two tenancies into one span from the first move-in to the last move-out
 *   would show them the months in between, when someone else lived there.
 * - **A `boolean` predicate `maySee(residentId, unitId, date)`** is enough for one row at a time and
 *   useless for a query: the iuran spec lists a resident's invoices, and asking the predicate once
 *   per candidate row means reading every row of the table first. Returning the ranges as data lets
 *   `visibilityDateFilter` push the same rule into SQL, and lets a test assert on the ranges
 *   themselves rather than on a sample of answers.
 *
 * ## Dates are strings, and stay strings
 *
 * A day is `YYYY-MM-DD`, exactly as `src/lib/server/db/schema/occupancy.ts` stores it and for the
 * reason recorded there: turning a calendar day into a `Date` makes it an instant at midnight in
 * some zone, and reading it back in another zone can move it a day. ISO-8601 days also compare
 * correctly with `<` and `>` as plain strings, so nothing in this module needs date arithmetic.
 *
 * **The visibility answer itself still never asks what day it is.** `unitVisibilityFor` returns the
 * days as data, and whether today falls inside them is the caller's question — which is what lets a
 * resident whose end date has been written but has not arrived still see the days they are living
 * through. `currentDay` and `isStillRunningOn` at the bottom of this file are the other half: the one
 * definition of "living here now", kept here because this is where the `YYYY-MM-DD` vocabulary lives,
 * and taking a `Clock` so that no caller reads the wall clock for itself.
 */

/**
 * A stretch of calendar days, both ends inclusive.
 *
 * `to: null` means the stretch has not ended — the occupancy it came from is still running, so
 * every day from `from` onwards is included.
 */
export interface DateRange {
	/** The first day included, as `YYYY-MM-DD`. */
	readonly from: string;
	/** The last day included, as `YYYY-MM-DD`, or `null` when it has not ended. */
	readonly to: string | null;
}

/** What a viewer may see of one unit's history. See this module's doc comment for the two cases. */
export type UnitVisibility =
	{ readonly kind: 'all' } | { readonly kind: 'ranges'; readonly ranges: readonly DateRange[] };

/** The whole history, with no date restriction. */
export const VISIBLE_ALWAYS: UnitVisibility = Object.freeze({ kind: 'all' });

/** Nothing at all — the answer for someone who never lived in the unit they asked about. */
export const VISIBLE_NEVER: UnitVisibility = Object.freeze({
	kind: 'ranges',
	ranges: Object.freeze([])
});

/** Who is asking, and about which house. */
export interface UnitVisibilityRequest {
	/** The signed-in account asking — a `user.id`, not a `residents.id`. */
	readonly viewerUserId: string;
	/** The house they are asking about. */
	readonly unitId: string;
}

/**
 * What `viewerUserId` may see of `unitId`'s history.
 *
 * `{ kind: 'all' }` for a caller holding `ACTION.manageOccupancies`; otherwise the days their own
 * occupancies of that unit cover, merged and sorted. An account with no `residents` row — an
 * expected state until #20 and #21 land, see `src/lib/server/services/resident/profile.ts` — sees
 * nothing, which is `VISIBLE_NEVER` rather than an error.
 *
 * This function reads; it never refuses. A caller that wants a refusal asks for the ranges and then
 * decides, because "you may see nothing here" and "you may not ask" are different answers and only
 * the second one is a 403.
 */
export async function unitVisibilityFor(
	db: DatabaseWriter,
	request: UnitVisibilityRequest
): Promise<UnitVisibility> {
	const roles = await rolesOf(db, request.viewerUserId);
	if (isAllowed(roles, ACTION.manageOccupancies)) {
		return VISIBLE_ALWAYS;
	}

	const ranges = await occupiedRangesOfUnit(db, request.viewerUserId, request.unitId);
	return ranges.length === 0 ? VISIBLE_NEVER : { kind: 'ranges', ranges };
}

/**
 * Every stretch of days `viewerUserId` occupied `unitId` for, merged and sorted — the raw material
 * `unitVisibilityFor` builds its `ranges` case from, exported for a caller that has already decided
 * the viewer is a plain resident.
 */
export async function occupiedRangesOfUnit(
	db: DatabaseWriter,
	viewerUserId: string,
	unitId: string
): Promise<readonly DateRange[]> {
	const rows = await db
		.select({ from: occupancies.startedOn, to: occupancies.endedOn })
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.where(and(eq(residents.userId, viewerUserId), eq(occupancies.unitId, unitId)))
		.orderBy(asc(occupancies.startedOn));

	return mergeDateRanges(rows);
}

/**
 * `ranges`, sorted by their first day and with every overlap folded into one range.
 *
 * Two occupancies of the same house by the same person can overlap — a correction, or an owner
 * recorded twice — and a caller should not have to care. Ranges that merely touch are left alone:
 * `[…, 2026-03-31]` and `[2026-04-01, …]` cover the same days whether they are one range or two, and
 * joining them would need day arithmetic that this module deliberately does without.
 */
export function mergeDateRanges(ranges: readonly DateRange[]): readonly DateRange[] {
	const sorted = [...ranges].sort((left, right) => compareDays(left.from, right.from));
	const merged: DateRange[] = [];

	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && isWithinOrAt(range.from, previous.to)) {
			merged[merged.length - 1] = { from: previous.from, to: laterEnd(previous.to, range.to) };
			continue;
		}
		merged.push({ from: range.from, to: range.to });
	}

	return merged;
}

/** Whether `visibility` covers `day`, given as `YYYY-MM-DD`. */
export function isVisibleOn(visibility: UnitVisibility, day: string): boolean {
	if (visibility.kind === 'all') {
		return true;
	}
	return visibility.ranges.some(
		(range) => compareDays(day, range.from) >= 0 && isWithinOrAt(day, range.to)
	);
}

/**
 * `visibility` as a condition on a `date` column, for a query that must not read what the viewer
 * may not see.
 *
 * ```ts
 * const rows = await db
 *   .select()
 *   .from(invoices)
 *   .where(and(eq(invoices.unitId, unitId), visibilityDateFilter(invoices.issuedOn, visibility)));
 * ```
 *
 * `undefined` for `{ kind: 'all' }`, because Drizzle's `and()` drops an `undefined` argument — the
 * same idiom `buildUnitFilter` in `src/lib/server/services/unit/queries.ts` already uses, so "no
 * restriction" composes without the caller writing a branch. An empty `ranges` becomes a condition
 * that matches nothing, never a missing `where` clause: the difference between those two is a whole
 * table handed to someone entitled to none of it.
 */
export function visibilityDateFilter(
	column: AnyPgColumn,
	visibility: UnitVisibility
): SQL | undefined {
	if (visibility.kind === 'all') {
		return undefined;
	}
	if (visibility.ranges.length === 0) {
		return sql`false`;
	}
	return or(
		...visibility.ranges.map((range) =>
			and(gte(column, range.from), range.to === null ? undefined : lte(column, range.to))
		)
	);
}

/**
 * Today, as the calendar day `YYYY-MM-DD` that the occupancy table's `date` columns compare against.
 *
 * **Two different questions get two different predicates, and this one belongs to only one of them.**
 *
 * - *"Is the primary-occupant slot the database guards filled?"* is `ended_on is null`, exactly what
 *   `occupancies_primary_occupant_unique` means by it, and it does not need a day at all.
 * - *"Is this person living here now?"* is `isStillRunningOn` below, and it does. An end date written
 *   before it arrives — someone announcing in March that they move out next year — is a normal thing
 *   for a superuser to record, and reading it as "already gone" tells a resident their home is not
 *   theirs.
 *
 * **The instant is read as a day in the complex's own zone.** `Clock.now()` answers which *moment*
 * it is, never which day it is somewhere, and `src/lib/time.ts` settles the zone the complex reads
 * every calendar day in — `Asia/Jakarta`, WIB. This reads `civilDayOf` from that module rather than
 * defining a second idea of "today".
 */
export function currentDay(clock: Clock): string {
	return civilDayOf(clock.now());
}

/**
 * Whether a stay ending on `endedOn` — `null` while it has not been given an end date — is still
 * running on `day`. The one definition of "living here now", shared by every screen that asks.
 */
export function isStillRunningOn(endedOn: string | null, day: string): boolean {
	return endedOn === null || compareDays(endedOn, day) >= 0;
}

/**
 * `isStillRunningOn` as a condition on an `ended_on` column, for the queries that ask the same
 * question of many rows at once.
 */
export function stillRunningOn(endedOnColumn: AnyPgColumn, day: string): SQL {
	// `or()` only widens to `undefined` when every argument is, and neither of these is.
	return or(isNull(endedOnColumn), gte(endedOnColumn, day)) as SQL;
}

/** `-1`, `0` or `1`, comparing two `YYYY-MM-DD` days. ISO days sort correctly as plain strings. */
function compareDays(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

/** Whether `day` falls on or before `end`, where a `null` end means the range never ends. */
function isWithinOrAt(day: string, end: string | null): boolean {
	return end === null || compareDays(day, end) <= 0;
}

/** The later of two ends, where `null` — "has not ended" — is later than any day. */
function laterEnd(left: string | null, right: string | null): string | null {
	if (left === null || right === null) {
		return null;
	}
	return compareDays(left, right) >= 0 ? left : right;
}
