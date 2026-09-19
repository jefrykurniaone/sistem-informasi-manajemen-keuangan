import { and, asc, eq } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import { ACTION, isAllowed, rolesOf, type DatabaseWriter } from '../../authz';
import { user } from '../../db/schema/auth';
import { complaintReplies, complaints, type ComplaintReply } from '../../db/schema/complaint';
import { residents } from '../../db/schema/resident';
import type { Clock } from '../../ports/clock';
import { complaintReadScopeFor, complaintScopeFilter, reporterIdForUser } from './visibility';

/**
 * **Tanggapan: the reply thread on one Keluhan.**
 *
 * `docs/spec-keluhan-v1.md` calls this "rangkaian pesan sederhana" — no nested replies, no editing
 * — and the acceptance criteria this ticket adds it for are stories 6 and 17: the reporter adding
 * one on their own complaint, and the pengurus adding one that the reporter reads. #44 calls
 * `addComplaintReply` from the resident side for exactly the first of those, which is why the
 * contract below carries `actorId` and decides for itself who may write, rather than trusting
 * whichever screen calls it.
 *
 * ## Who may reply, and how that is decided
 *
 * A reply is only ever legitimate from two identities — the same two `./state-machine.ts` names
 * for a status move: the `handler` (whoever holds `ACTION.handleComplaints`) and the `reporter`
 * (the complaint's own `reporterId`). Neither identity is re-derived from a visibility guess here:
 *
 * - **Whether the complaint exists at all, for this caller, comes from `complaintReadScopeFor` and
 *   `complaintScopeFilter`** — the same functions and the same `where`-clause shape `getComplaint`
 *   in `./index.ts` uses. A complaint the caller may not read is answered exactly like a complaint
 *   that does not exist, which is what keeps a guessed id from confirming a private complaint's
 *   existence.
 * - **Whether the caller may *write* on a complaint they can read is a narrower question than
 *   whether they may read it.** A `public` complaint is readable by every signed-in Warga, but the
 *   spec's reply stories only ever name the reporter and the pengurus — a neighbour reading a
 *   `public` complaint is not one of them. So after the existence check above, this module asks a
 *   second, separate question — handler or reporter — and refuses everyone else with the same
 *   `PermissionDeniedError` shape `withdrawComplaint` and `setComplaintVisibility` in `./index.ts`
 *   already use for an "only their own row" rule that is not a `PERMISSIONS` entry.
 */

/**
 * The refusal `PermissionDeniedError` carries when whoever is asking is neither this complaint's
 * reporter nor a handler. Not a value of `ACTION`: see `src/lib/server/authz.ts` for why an "only
 * their own row" rule has no entry in `PERMISSIONS`.
 */
const REPLY_TO_COMPLAINT = 'complaints.reply';

/** Every rule this module refuses a reply for, other than who is asking. */
export const COMPLAINT_REPLY_RULE = {
	/** A reply with no content, or content that is only whitespace. */
	contentRequired: 'contentRequired',
	/** The signed-in account has no `residents` row, so there is nobody to attribute the reply to. */
	actorNotRegistered: 'actorNotRegistered'
} as const;

/** One of the rules above. */
export type ComplaintReplyRule = (typeof COMPLAINT_REPLY_RULE)[keyof typeof COMPLAINT_REPLY_RULE];

/**
 * Thrown when a reply breaks one of the rules in `COMPLAINT_REPLY_RULE`.
 *
 * A named error belonging to this module rather than a shared one, the same reasoning
 * `ComplaintTransitionError` records in `./state-machine.ts`: this rule belongs to replies alone,
 * not to moving a complaint between statuses.
 */
export class ComplaintReplyRuleError extends Error {
	override readonly name = 'ComplaintReplyRuleError';

	/** Which rule refused the reply. */
	readonly rule: ComplaintReplyRule;

	constructor(rule: ComplaintReplyRule, detail: string) {
		super(`A Complaint reply was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** Who is replying, to which complaint, and with what. */
export interface AddComplaintReplyRequest {
	/** The signed-in account. Must be this complaint's reporter, or hold `ACTION.handleComplaints`. */
	readonly actorId: string;
	readonly complaintId: string;
	readonly content: string;
}

/**
 * Adds one reply to a complaint's thread — story 6 (the reporter) and story 17 (the pengurus), one
 * function for both because the rule is the same shape either way: whoever holds
 * `ACTION.handleComplaints`, or the complaint's own reporter, and nobody else.
 *
 * @throws {PermissionDeniedError} `complaints.reply` when the caller may read the complaint but is
 *   neither its reporter nor a handler — and equally when the id names no complaint this caller may
 *   read at all, so that a guess cannot tell the two apart.
 * @throws {ComplaintReplyRuleError} `actorNotRegistered` when the caller has no `residents` row, or
 *   `contentRequired` when the reply is empty.
 */
export async function addComplaintReply(
	db: DatabaseWriter,
	clock: Clock,
	request: AddComplaintReplyRequest
): Promise<ComplaintReply> {
	const content = request.content.trim();
	if (content === '') {
		throw new ComplaintReplyRuleError(
			COMPLAINT_REPLY_RULE.contentRequired,
			'A complaint reply must not be empty.'
		);
	}

	const scope = await complaintReadScopeFor(db, request.actorId);
	const [existing] = await db
		.select()
		.from(complaints)
		.where(and(eq(complaints.id, request.complaintId), complaintScopeFilter(scope)))
		.limit(1);
	if (!existing) {
		throw new PermissionDeniedError(request.actorId, REPLY_TO_COMPLAINT);
	}

	const actorResidentId = await reporterIdForUser(db, request.actorId);
	if (!actorResidentId) {
		throw new ComplaintReplyRuleError(
			COMPLAINT_REPLY_RULE.actorNotRegistered,
			`User "${request.actorId}" has no residents row to attribute a complaint reply to.`
		);
	}

	const roles = await rolesOf(db, request.actorId);
	const isHandler = isAllowed(roles, ACTION.handleComplaints);
	const isReporter = existing.reporterId === actorResidentId;
	if (!isHandler && !isReporter) {
		throw new PermissionDeniedError(request.actorId, REPLY_TO_COMPLAINT);
	}

	const [row] = await db
		.insert(complaintReplies)
		.values({
			complaintId: existing.id,
			authorId: actorResidentId,
			content,
			createdAt: clock.now()
		})
		.returning();
	return row;
}

/** One reply, with the name of whoever wrote it. */
export interface ComplaintReplyWithAuthor extends ComplaintReply {
	readonly authorName: string;
}

/**
 * A complaint's replies, oldest first, for a viewer who may read that complaint.
 *
 * The same visibility rule `complaintStatusHistory` in `./history.ts` applies, and for the same
 * reason: the read is inside the `where`, so a viewer who may not read the complaint gets an empty
 * thread rather than somebody else's conversation, and an empty answer is deliberately
 * indistinguishable from "nothing has been said yet".
 *
 * @param viewerUserId the signed-in account, or `null` when nobody is signed in.
 */
export async function listComplaintReplies(
	db: DatabaseWriter,
	viewerUserId: string | null,
	complaintId: string
): Promise<readonly ComplaintReplyWithAuthor[]> {
	const scope = await complaintReadScopeFor(db, viewerUserId);

	const rows = await db
		.select({ reply: complaintReplies, authorName: user.name })
		.from(complaintReplies)
		.innerJoin(complaints, eq(complaints.id, complaintReplies.complaintId))
		.innerJoin(residents, eq(residents.id, complaintReplies.authorId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(and(eq(complaintReplies.complaintId, complaintId), complaintScopeFilter(scope)))
		.orderBy(asc(complaintReplies.createdAt), asc(complaintReplies.id));

	return rows.map((row) => ({ ...row.reply, authorName: row.authorName }));
}
