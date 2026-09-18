import { and, asc, eq } from 'drizzle-orm';
import type { DatabaseWriter } from '../../authz';
import { user } from '../../db/schema/auth';
import {
	complaintStatusChanges,
	complaints,
	type ComplaintStatus,
	type ComplaintStatusChange
} from '../../db/schema/complaint';
import { residents } from '../../db/schema/resident';
import type { Clock } from '../../ports/clock';
import { isTerminalComplaintStatus } from './state-machine';
import { complaintReadScopeFor, complaintScopeFilter } from './visibility';

/**
 * **The Riwayat Status of a Keluhan: one row per transition, and the age that falls out of it.**
 *
 * `docs/spec-keluhan-v1.md` keeps the history rather than only the latest status for a stated
 * reason — "pertanyaan yang benar-benar ditanyakan di rapat warga adalah 'berapa lama ini
 * menggantung', dan itu tidak bisa dijawab oleh kolom status terakhir" — and both halves of that
 * sentence live here: `recordComplaintStatusChange` writes the row, and `complaintAge` answers the
 * question.
 *
 * ## `complaints.statusChangedAt` and this table say the same thing, and one instant keeps them so
 *
 * `src/lib/server/db/schema/complaint.ts` chose to carry `statusChangedAt` as a column rather than
 * derive it, because the admin queue sorts by it and a join to find the newest history row per
 * complaint would cost a query on every list. That choice is only safe while the two are written
 * together, which is why `occurredAt` is a parameter here rather than something this function reads
 * off the clock for itself: `moveComplaint` in `./index.ts` takes one instant from the `Clock`, puts
 * it on the row and on the history entry, and writes both inside one transaction. Read the clock
 * twice and the column disagrees with the row that explains it by however long the two statements
 * took.
 *
 * ## Age is read from the clock, never from the database's `now()`
 *
 * `complaintAge` takes a `Clock`, so a test moves time by hand and proves a seven-day-old complaint
 * is highlighted without waiting a week or depending on what the database server thinks the time
 * is. `src/lib/server/ports/clock.ts` says why that port exists; nothing in this feature calls
 * `new Date()`.
 */

/**
 * How long a complaint may sit without moving before the admin queue highlights it: seven days.
 *
 * A constant, not a setting. The spec is explicit — "Daftar admin menyorot yang melewati ambang
 * yang ditetapkan sebagai tetapan, bukan kebijakan yang bisa diatur — belum ada yang meminta itu
 * bisa diatur" — and a number nobody has asked to change is cheaper to read here than to look up in
 * a settings table that would then need a screen, a permission and a migration of its own.
 */
export const STALE_COMPLAINT_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/** What `recordComplaintStatusChange` needs to write one row of the history. */
export interface ComplaintStatusChangeToRecord {
	readonly complaintId: string;
	readonly oldStatus: ComplaintStatus;
	readonly newStatus: ComplaintStatus;
	/** Who made the change, as a `residents.id`. */
	readonly actorId: string;
	/** Free-text colour on the transition. Never where a rejection's mandatory reason lives. */
	readonly note: string | null;
	/**
	 * When it happened, taken from the `Clock` by the caller and written to
	 * `complaints.statusChangedAt` in the same transaction.
	 */
	readonly occurredAt: Date;
}

/**
 * Writes one row of a complaint's history.
 *
 * Called by `moveComplaint` in `./index.ts` inside the transaction that writes the new status,
 * never on its own: a history row describing a change that was not committed would be a record of
 * something that never happened.
 *
 * @param writer the caller's transaction.
 */
export async function recordComplaintStatusChange(
	writer: DatabaseWriter,
	entry: ComplaintStatusChangeToRecord
): Promise<ComplaintStatusChange> {
	const [row] = await writer.insert(complaintStatusChanges).values(entry).returning();
	return row;
}

/** One transition, with the name of whoever made it — story 19's "siapa mengubah status apa". */
export interface ComplaintStatusChangeWithActor extends ComplaintStatusChange {
	readonly actorName: string;
}

/**
 * A complaint's transitions, oldest first, for a viewer who may read that complaint.
 *
 * The visibility rule is in the `where` through the join onto `complaints`, so a viewer who may not
 * read the complaint gets an empty history rather than somebody else's timeline. An empty answer
 * therefore means either "not yours to read" or "it has not moved yet", which are deliberately
 * indistinguishable from out here: a screen that wants to tell a reader their complaint is missing
 * asks `getComplaint`, which is the one function that refuses.
 *
 * @param viewerUserId the signed-in account, or `null` when nobody is signed in.
 */
export async function complaintStatusHistory(
	db: DatabaseWriter,
	viewerUserId: string | null,
	complaintId: string
): Promise<readonly ComplaintStatusChangeWithActor[]> {
	const scope = await complaintReadScopeFor(db, viewerUserId);

	const rows = await db
		.select({ change: complaintStatusChanges, actorName: user.name })
		.from(complaintStatusChanges)
		.innerJoin(complaints, eq(complaints.id, complaintStatusChanges.complaintId))
		.innerJoin(residents, eq(residents.id, complaintStatusChanges.actorId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(and(eq(complaintStatusChanges.complaintId, complaintId), complaintScopeFilter(scope)))
		// `id` breaks the tie so that two transitions stamped by the same fake instant still come
		// back in one stable order.
		.orderBy(asc(complaintStatusChanges.occurredAt), asc(complaintStatusChanges.id));

	return rows.map((row) => ({ ...row.change, actorName: row.actorName }));
}

/**
 * How long a complaint has sat in its current status, in milliseconds.
 *
 * Measured from `statusChangedAt` — which is `createdAt` until the first transition — so a fresh
 * complaint's age is how long nobody has looked at it, which is what story 13 asks to see.
 * Never negative: a clock set back behind a stored instant answers `0` rather than a number that
 * would sort a complaint ahead of every other one.
 */
export function complaintAge(clock: Clock, statusChangedAt: Date): number {
	return Math.max(0, clock.now().getTime() - statusChangedAt.getTime());
}

/** The parts of a complaint that decide whether it is hanging. */
export interface ComplaintAgeSubject {
	readonly status: ComplaintStatus;
	readonly statusChangedAt: Date;
}

/**
 * Whether a complaint has been hanging longer than `STALE_COMPLAINT_AGE_MILLISECONDS`.
 *
 * Only an open complaint can hang: "menyorot keluhan yang menggantung" is about work nobody has
 * finished, and a complaint that was resolved a year ago is old rather than late. Which statuses
 * count as open is read from the state machine's own table, so a status is open here exactly when
 * it still has somewhere to go.
 */
export function isComplaintStale(clock: Clock, complaint: ComplaintAgeSubject): boolean {
	if (isTerminalComplaintStatus(complaint.status)) {
		return false;
	}
	return complaintAge(clock, complaint.statusChangedAt) > STALE_COMPLAINT_AGE_MILLISECONDS;
}
