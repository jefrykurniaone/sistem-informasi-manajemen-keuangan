import { eq } from 'drizzle-orm';
import { readOrigin } from '../../auth';
import { rolesOf } from '../../authz';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { ROLE } from '../../db/schema/authz';
import type { Complaint } from '../../db/schema/complaint';
import { residents } from '../../db/schema/resident';
import {
	complaintStatusChangedPayload,
	COMPLAINT_STATUS_CHANGED_KIND
} from '../../email/templates/complaint-status-changed';
import { newComplaintPayload, NEW_COMPLAINT_KIND } from '../../email/templates/new-complaint';
import { enqueueEmail } from '../../email/queue';
import type { Clock } from '../../ports/clock';
import { residentsSubscribedTo } from '../subscription';
import { SUBSCRIPTION_KIND } from '../subscription/kinds';

/**
 * Where the two emails #46 adds get queued from: `new-complaint`, to every admin subscribed to it,
 * and `own-complaint-status-changed`, to the reporter. `./index.ts` calls `notifyNewComplaint` from
 * `createComplaint` and `notifyComplaintStatusChanged` from `changeComplaintStatus`, each after its
 * own transaction has already committed — see `src/lib/server/email/queue.ts`'s own doc comment for
 * why enqueueing never happens inside the transaction that causes it. `withdrawComplaint` calls
 * neither: a reporter taking their own complaint back is not a status change anyone but them
 * decided, and the acceptance criteria are explicit that it must not email them.
 *
 * ## Who receives `new-complaint`, and why it stops at admin
 *
 * `residentsSubscribedTo(db, SUBSCRIPTION_KIND.newComplaint)` already applies the kind's registry
 * default (opt-in, off) for a resident who has never answered, the same contract `notifyNewPost`
 * relies on. What it does not know is which of those residents may actually handle a Keluhan — a
 * subscribed resident who holds no `admin` role is filtered out here with `rolesOf`, the same guard
 * `requirePermission` reads `user_roles` through. An admin with no `residents` row at all never
 * appears in the subscribed list to begin with, which is the normal, unremarkable case the map's
 * own binding decision names: nobody to filter, nothing sent.
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
 * ## A failure here must never undo, or appear to undo, a committed decision
 *
 * By the time either function below runs, the Keluhan is already written or already moved — that
 * transaction has committed. Letting a failure to find a recipient or to enqueue an email propagate
 * out of `createComplaint` or `changeComplaintStatus` would report the whole operation as failed to
 * a caller who would then act as though it never happened, which is exactly backwards. Both
 * functions therefore catch their own failures, log them to the console — there is no logger in
 * this application yet, the same honest placement `dues/notification.ts` uses — and resolve rather
 * than reject.
 */

/** The locale every email in this file renders in, until a resident's own language is a stored fact. */
const COMPLAINT_EMAIL_LOCALE = 'id';

/** The absolute address of the admin detail page for `complaintId`, built from `readOrigin()`. */
function adminComplaintUrl(complaintId: string): string {
	return `${readOrigin()}/admin/complaints/${complaintId}`;
}

/** The absolute address of the reporter's own detail page for `complaintId`, built from `readOrigin()`. */
function reporterComplaintUrl(complaintId: string): string {
	return `${readOrigin()}/complaints/${complaintId}`;
}

/**
 * Runs `action`, catching and logging whatever it throws instead of letting it reach the caller —
 * see this module's doc comment for why a notification failure must never look like the business
 * operation that caused it failed too.
 */
async function swallowing(kind: string, action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		console.error(
			`Queuing a "${kind}" notification failed after the change it announces had already committed:`,
			error
		);
	}
}

/**
 * Queues one `new-complaint` email to every resident subscribed to it who also holds the `admin`
 * role.
 *
 * @param db the caller's plain database, once its own transaction has already committed — never a
 *   transaction handle, which would put the email back inside the window it is deliberately
 *   outside of.
 */
export async function notifyNewComplaint(
	db: Database,
	clock: Clock,
	complaint: Complaint
): Promise<void> {
	await swallowing(NEW_COMPLAINT_KIND, async () => {
		const subscribed = await residentsSubscribedTo(db, SUBSCRIPTION_KIND.newComplaint);
		if (subscribed.length === 0) {
			return;
		}

		const payload = newComplaintPayload({
			title: complaint.title,
			category: complaint.category,
			url: adminComplaintUrl(complaint.id),
			locale: COMPLAINT_EMAIL_LOCALE
		});

		for (const recipient of subscribed) {
			const roles = await rolesOf(db, recipient.userId);
			if (!roles.has(ROLE.admin)) {
				continue;
			}
			await enqueueEmail(db, clock, {
				recipient: recipient.email,
				kind: NEW_COMPLAINT_KIND,
				payload
			});
		}
	});
}

/**
 * Queues one `own-complaint-status-changed` email to `complaint.reporterId`, naming the status it
 * just moved to and `note` — the free-text colour on this exact transition, not read off the row —
 * together with `complaint.rejectionReason` when the move was a rejection.
 *
 * @param db the caller's plain database, once its own transaction has already committed.
 */
export async function notifyComplaintStatusChanged(
	db: Database,
	clock: Clock,
	complaint: Complaint,
	note: string | null
): Promise<void> {
	await swallowing(COMPLAINT_STATUS_CHANGED_KIND, async () => {
		const recipient = await reporterEmail(db, complaint.reporterId);
		if (!recipient) {
			return;
		}
		await enqueueEmail(db, clock, {
			recipient,
			kind: COMPLAINT_STATUS_CHANGED_KIND,
			payload: complaintStatusChangedPayload({
				title: complaint.title,
				status: complaint.status,
				note,
				rejectionReason: complaint.rejectionReason,
				url: reporterComplaintUrl(complaint.id),
				locale: COMPLAINT_EMAIL_LOCALE
			})
		});
	});
}

/** The email behind a `residents.id`, or `undefined` when the row is somehow gone. */
async function reporterEmail(db: Database, residentId: string): Promise<string | undefined> {
	const [row] = await db
		.select({ email: user.email })
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(residents.id, residentId))
		.limit(1);
	return row?.email;
}
