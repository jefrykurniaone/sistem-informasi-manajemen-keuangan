import { asc, desc, eq } from 'drizzle-orm';
import type { DatabaseWriter } from '../../authz';
import { occupancies } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { firstDayOfPeriod } from '../dues/invoice';
import {
	currentDay,
	isStillRunningOn,
	isVisibleOn,
	mergeDateRanges,
	type DateRange
} from './visibility';

/**
 * **A Warga's own houses, and which of a house's Tagihan are theirs to see.** The one place every
 * personal screen asks, #306 decision 1.
 *
 * Three questions, all about one person and never about what that person may do:
 *
 * 1. Which Units has this person ever had a Masa Huni of? `ResidentView.units`.
 * 2. Which of them are they living in today? `ResidentUnit.occupiedToday`, the existing "sedang
 *    menghuni" predicate `isStillRunningOn` in `./visibility.ts`, read on `currentDay(clock)`.
 * 3. May they see a given Tagihan? `isInvoiceVisible`: yes exactly when the first day of the
 *    Tagihan's Periode falls inside one of their own Masa Huni of that Unit, both ends inclusive.
 *    That is the rule "Tagihan saya" and the payment picker (`89948c3`) already applied, moved here
 *    unchanged.
 *
 * ## This module reads no role, on purpose
 *
 * `unitVisibilityFor` in `./visibility.ts` answers "the whole history" to whoever holds
 * `ACTION.manageOccupancies`. That is right for an admin screen and wrong for a personal one: it
 * made a superuser who lives in a house see the previous occupant's unpaid months as their own debt
 * on "Tagihan saya", on the Beranda and in the payment form. Nothing here imports `rolesOf`,
 * `isAllowed` or `ACTION`; the one import from `../../authz` is the `DatabaseWriter` type, which is
 * erased at compile time. A `ResidentView` has no "all" case to forget about, so a personal screen
 * built on it cannot be widened by a role.
 *
 * Every personal screen goes through here: "Tagihan saya" (`invoicesForUser` in
 * `../dues/queries.ts`), the payment picker and the payment guard (`../dues/payment.ts`), the
 * payment list route, and the Warga card on the Beranda (`../dashboard/index.ts`). The admin
 * screens keep their own reads, which show a Unit's whole history.
 *
 * ## Why a loaded view rather than one query per question
 *
 * A person has a handful of Masa Huni, so one read of all of them answers all three questions for
 * every house at once, and a screen asking the second and the third question gets answers taken
 * from the same rows on the same day. The view holds no names of other occupants: the payment guard
 * only needs a yes or no, and "Rumah saya" (`occupiedUnitsForUser` in `./index.ts`) is the screen
 * that shows who else lives there.
 *
 * Imported by its own path, not re-exported from `./index.ts`.
 */

/** One Unit this person has had a Masa Huni of. */
export interface ResidentUnit {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/**
	 * The days this person's own Masa Huni of this Unit cover, merged and sorted by
	 * `mergeDateRanges`, both ends inclusive, `to: null` while a stay has no end date. Never empty:
	 * a Unit is only in the view because at least one Masa Huni put it there.
	 */
	readonly ranges: readonly DateRange[];
	/**
	 * Whether at least one of those Masa Huni is running today, by `isStillRunningOn`: started on or
	 * before today, and its last day not written yet or not yet passed.
	 */
	readonly occupiedToday: boolean;
}

/** Everything a personal screen needs to know about one person's houses. */
export interface ResidentView {
	/**
	 * Every Unit with at least one Masa Huni of this person, ended, running or not yet started. Most
	 * recent move-in first, the order `occupiedUnitsForUser` lists stays in. Empty for an account with
	 * no `residents` row or no Masa Huni at all, which is an expected state rather than an error.
	 */
	readonly units: readonly ResidentUnit[];
}

/** The `ResidentView` of an account recorded in no house. */
const EMPTY_VIEW: ResidentView = Object.freeze({ units: Object.freeze([]) });

/**
 * The houses of the person signed in as `userId`, read once, with "today" taken from `clock` in the
 * complex's zone.
 *
 * Takes only the caller's own account id and refuses nobody: there is no other id a caller could
 * swap in, the same row-ownership reasoning `occupiedUnitsForUser` gives.
 */
export async function residentViewFor(
	db: DatabaseWriter,
	clock: Clock,
	userId: string
): Promise<ResidentView> {
	const stays = await db
		.select({
			unitId: occupancies.unitId,
			block: units.block,
			number: units.number,
			startedOn: occupancies.startedOn,
			endedOn: occupancies.endedOn
		})
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.innerJoin(units, eq(units.id, occupancies.unitId))
		.where(eq(residents.userId, userId))
		// The same order `occupiedUnitsForUser` reads stays in, so a Unit's place in the view is
		// where its most recent move-in put it, and the screens keep the order they had.
		.orderBy(desc(occupancies.startedOn), desc(occupancies.createdAt), asc(occupancies.id));

	if (stays.length === 0) {
		return EMPTY_VIEW;
	}

	const today = currentDay(clock);
	const byUnit = new Map<
		string,
		{ block: string; number: string; ranges: DateRange[]; occupiedToday: boolean }
	>();
	for (const stay of stays) {
		const range = { from: stay.startedOn, to: stay.endedOn };
		const runningToday = isStillRunningOn(stay, today);
		const existing = byUnit.get(stay.unitId);
		if (existing) {
			existing.ranges.push(range);
			existing.occupiedToday ||= runningToday;
			continue;
		}
		byUnit.set(stay.unitId, {
			block: stay.block,
			number: stay.number,
			ranges: [range],
			occupiedToday: runningToday
		});
	}

	return {
		units: [...byUnit].map(([unitId, unit]) => ({
			unitId,
			block: unit.block,
			number: unit.number,
			ranges: mergeDateRanges(unit.ranges),
			occupiedToday: unit.occupiedToday
		}))
	};
}

/** The Units of `view` this person is living in today, in the view's order. */
export function unitsOccupiedToday(view: ResidentView): readonly ResidentUnit[] {
	return view.units.filter((unit) => unit.occupiedToday);
}

/** Whether this person is living in `unitId` today. */
export function occupiesToday(view: ResidentView, unitId: string): boolean {
	return view.units.some((unit) => unit.unitId === unitId && unit.occupiedToday);
}

/** The two facts of a Tagihan its visibility is decided by. Any invoice row selected with both fits. */
export interface InvoiceVisibilityKey {
	readonly unitId: string;
	/** The Periode, as `YYYY-MM`. */
	readonly period: string;
}

/**
 * Whether this person may see `invoice` on a personal screen: the first day of its Periode falls
 * inside one of their own Masa Huni of its Unit, both ends inclusive.
 *
 * `false` for a Tagihan of a Unit this person never had a Masa Huni of. The day comparison is
 * `isVisibleOn` in `./visibility.ts`, given only this person's own ranges and never the
 * `{ kind: 'all' }` case.
 *
 * @throws {TypeError} when `invoice.period` is not a `YYYY-MM` Periode, from `firstDayOfPeriod`.
 */
export function isInvoiceVisible(view: ResidentView, invoice: InvoiceVisibilityKey): boolean {
	const unit = view.units.find((candidate) => candidate.unitId === invoice.unitId);
	if (!unit) {
		return false;
	}
	return isVisibleOn({ kind: 'ranges', ranges: unit.ranges }, firstDayOfPeriod(invoice.period));
}
