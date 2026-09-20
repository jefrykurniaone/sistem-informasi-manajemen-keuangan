import { and, count, eq, gte, lt } from 'drizzle-orm';
import { civilMonthOf } from '$lib/time';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import { COMPLAINT_STATUS, complaints } from '../../db/schema/complaint';
import type { Clock } from '../../ports/clock';

/**
 * **The admin queue's monthly summary: how many Keluhan came in and how many were finished this
 * calendar month.**
 *
 * Story 20 — "sebagai admin, saya ingin melihat berapa keluhan masuk dan selesai bulan ini, supaya
 * ada yang bisa dilaporkan di rapat warga" — is the only acceptance criterion this ticket has with
 * no service function behind it yet: `listComplaints` in `./index.ts` filters by status, category
 * and `onlyOpen`, which answers the worklist and the `stale` highlight, but never counted anything
 * by month. This module is that count, and nothing else.
 *
 * ## "Masuk" and "selesai" are both read off columns that already exist
 *
 * A complaint counts as having come in this month when its `createdAt` falls inside it — the
 * instant it was reported, never touched again. A complaint counts as finished this month when its
 * `status` is `resolved` **and** `statusChangedAt` falls inside it: `statusChangedAt` is exactly
 * the instant a complaint's status last moved (`./index.ts`'s `moveComplaint` writes both in the
 * same transaction), so for a complaint that is currently `resolved` it is exactly the moment it
 * became so. No new column and no join to `complaint_status_changes` are needed for either count.
 *
 * ## The month is read from the `Clock`, and boundaries are calendar, not rolling
 *
 * "Bulan berjalan" is the calendar month the clock is currently in — the 1st through the last day
 * — not "the last 30 days", so a test can move a fake clock to the last day of a month and prove
 * the count resets on the next call after the 1st. **The boundaries are WIB calendar months**,
 * read with `civilMonthOf` from `$lib/time` — the complex's own zone, `Asia/Jakarta` — the same
 * module `currentDay(clock)` in `../occupancy/visibility.ts` reads its own calendar day from.
 *
 * ## Gated the same way the admin queue itself is
 *
 * This is a read, and `listComplaints` documents that it "refuses nobody" because the same function
 * also serves a resident's own list. This function serves only the admin worklist screen, so it
 * calls `requirePermission` itself, against `ACTION.readAllComplaints` — the same action that makes
 * `listComplaints` return every complaint rather than a scoped few, and the one a superuser holds
 * without also holding `ACTION.handleComplaints`, exactly as `src/lib/server/authz.ts` records for
 * why the two Keluhan actions are split.
 */

/** How many complaints came in, and how many were resolved, in one calendar month. */
export interface ComplaintWorklistSummary {
	/** Complaints whose `createdAt` falls in the month. */
	readonly openedThisMonth: number;
	/** Complaints whose `status` is `resolved` and whose `statusChangedAt` falls in the month. */
	readonly resolvedThisMonth: number;
}

/**
 * The current month's summary — story 20.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `ACTION.readAllComplaints`.
 */
export async function complaintWorklistSummary(
	db: DatabaseWriter,
	clock: Clock,
	actorId: string
): Promise<ComplaintWorklistSummary> {
	await requirePermission(db, actorId, ACTION.readAllComplaints);

	const { start, end } = currentMonthRange(clock.now());

	const [[opened], [resolved]] = await Promise.all([
		db
			.select({ total: count() })
			.from(complaints)
			.where(and(gte(complaints.createdAt, start), lt(complaints.createdAt, end))),
		db
			.select({ total: count() })
			.from(complaints)
			.where(
				and(
					eq(complaints.status, COMPLAINT_STATUS.resolved),
					gte(complaints.statusChangedAt, start),
					lt(complaints.statusChangedAt, end)
				)
			)
	]);

	return {
		openedThisMonth: opened?.total ?? 0,
		resolvedThisMonth: resolved?.total ?? 0
	};
}

/** How many hours WIB sits ahead of UTC. `Asia/Jakarta` has no daylight saving, so this is fixed. */
const WIB_OFFSET_HOURS = 7;

/**
 * The `[start, end)` instants of the **WIB** calendar month `instant` falls in. `end` is exclusive
 * — the first instant of the *next* month — so the range is built from plain `>=`/`<` comparisons
 * rather than an inclusive upper bound that would need its own end-of-month arithmetic.
 *
 * The month itself is read with `civilMonthOf`; the boundary instants are then the first moment of
 * that month, and of the month after it, at 00:00 WIB — which `Date.UTC` reaches directly by asking
 * for hour `-7`, the same as 17:00 UTC the day before.
 */
function currentMonthRange(instant: Date): { start: Date; end: Date } {
	const [year, month] = civilMonthOf(instant).split('-').map(Number);
	const start = new Date(Date.UTC(year, month - 1, 1, -WIB_OFFSET_HOURS, 0, 0, 0));
	const end = new Date(Date.UTC(year, month, 1, -WIB_OFFSET_HOURS, 0, 0, 0));
	return { start, end };
}
