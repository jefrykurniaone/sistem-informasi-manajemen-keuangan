import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db';
import { ROLE, userRoles } from '../../db/schema/authz';
import type { Complaint } from '../../db/schema/complaint';
import { residents } from '../../db/schema/resident';
import { announce, type RecipientResolver } from '../../email/announce';
import {
	complaintStatusChangedPayload,
	COMPLAINT_STATUS_CHANGED_KIND
} from '../../email/templates/complaint-status-changed';
import { newComplaintPayload, NEW_COMPLAINT_KIND } from '../../email/templates/new-complaint';
import type { Clock } from '../../ports/clock';

/**
 * What the two emails #46 adds say and who they are addressed to: `new-complaint`, to every admin,
 * and `own-complaint-status-changed`, to the reporter. `./index.ts` calls `notifyNewComplaint` from
 * `createComplaint` and `notifyComplaintStatusChanged` from `changeComplaintStatus`, each after its
 * own transaction has already committed and wrapped in `announceAfterCommit` — see
 * `src/lib/server/email/queue.ts`'s own doc comment for why enqueueing never happens inside the
 * transaction that causes it. `withdrawComplaint` calls neither: a reporter taking their own
 * complaint back is not a status change anyone but them decided, and the acceptance criteria are
 * explicit that it must not email them.
 *
 * This module only names the recipients and builds the payloads. `../../email/announce.ts` does the
 * rest: the Langganan, the address lookup, the link origin and the language.
 *
 * ## Who receives `new-complaint`, and why it stops at admin
 *
 * `new-complaint` is an opt-in kind, so `announce` narrows the addressed residents to those
 * subscribed to it, by the kind's registry default (off) for a resident who has never answered —
 * the same contract `notifyNewPost` relies on. What `announce` does not know is which residents may
 * actually handle a Keluhan, so the addressed list is every resident whose account holds the `admin`
 * role (`adminResidents` below), the same `user_roles` table `requirePermission` reads. An admin
 * with no `residents` row at all is not in that list to begin with, which is the normal,
 * unremarkable case the map's own binding decision names: nobody to address, nothing sent.
 *
 * ## What every recipient is sent, and why it stays inside the visibility rule
 *
 * Neither template ever carries `complaints.description`. An admin may read every Keluhan
 * (`ACTION.readAllComplaints`) and a reporter may always read their own, so routing by recipient —
 * every admin for the first email, the reporter alone for the second — already satisfies "no
 * private Keluhan content to someone not entitled to read it" without the payload needing to know
 * the visibility rule itself. The link in each email points at a page already guarded by that same
 * rule: `/admin/complaints/[id]` for the admin email, `/complaints/[id]` for the reporter's.
 *
 * ## A failure here is the caller's to contain
 *
 * Both functions throw whatever `announce` throws. By the time either runs, the Keluhan is already
 * written or already moved — that transaction has committed — so `createComplaint` and
 * `changeComplaintStatus` wrap the call in `announceAfterCommit`, which logs the failure and reports
 * the committed change as the success it is (#309, decision 1). The rule sits at the call site so it
 * holds for a notifier injected through the settings as well.
 */

/** Every resident whose account holds the `admin` role, before any Langganan is applied. */
const adminResidents: RecipientResolver = async (db) => {
	const rows = await db
		.select({ id: residents.id })
		.from(residents)
		.innerJoin(userRoles, eq(userRoles.userId, residents.userId))
		.where(eq(userRoles.role, ROLE.admin))
		.orderBy(asc(residents.createdAt), asc(residents.id));
	return rows.map((row) => row.id);
};

/**
 * Queues one `new-complaint` email to every admin subscribed to it.
 *
 * @param db the caller's plain database, once its own transaction has already committed — never a
 *   transaction handle, which would put the email back inside the window it is deliberately
 *   outside of.
 * @throws whatever `announce` throws; `createComplaint` is the caller that keeps it from failing the
 *   Keluhan.
 */
export async function notifyNewComplaint(
	db: Database,
	clock: Clock,
	complaint: Complaint
): Promise<void> {
	await announce(db, clock, {
		kind: NEW_COMPLAINT_KIND,
		recipients: adminResidents,
		payload: ({ link, locale }) =>
			newComplaintPayload({
				title: complaint.title,
				category: complaint.category,
				url: link(`/admin/complaints/${complaint.id}`),
				locale
			})
	});
}

/**
 * Queues one `own-complaint-status-changed` email to `complaint.reporterId`, naming the status it
 * just moved to and `note` — the free-text colour on this exact transition, not read off the row —
 * together with `complaint.rejectionReason` when the move was a rejection.
 *
 * @param db the caller's plain database, once its own transaction has already committed.
 * @throws whatever `announce` throws; `changeComplaintStatus` is the caller that keeps it from
 *   failing the transition.
 */
export async function notifyComplaintStatusChanged(
	db: Database,
	clock: Clock,
	complaint: Complaint,
	note: string | null
): Promise<void> {
	await announce(db, clock, {
		kind: COMPLAINT_STATUS_CHANGED_KIND,
		recipients: [complaint.reporterId],
		payload: ({ link, locale }) =>
			complaintStatusChangedPayload({
				title: complaint.title,
				status: complaint.status,
				note,
				rejectionReason: complaint.rejectionReason,
				url: link(`/complaints/${complaint.id}`),
				locale
			})
	});
}
