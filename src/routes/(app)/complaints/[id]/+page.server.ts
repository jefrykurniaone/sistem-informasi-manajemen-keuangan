import * as m from '#lib/paraglide/messages.js';
import { COMPLAINT_STATUS } from '#lib/server/db/schema/complaint.ts';
import type { FileStore } from '#lib/server/ports/file-store.ts';
import {
	failOrThrow,
	productionDependencies,
	refusal,
	requireUser,
	requireUuidParam,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import { formatDateTime } from '#lib/time.ts';
import {
	addComplaintReply,
	COMPLAINT_REPLY_RULE,
	ComplaintReplyRuleError,
	getComplaint,
	listComplaintAttachments,
	listComplaintReplies,
	withdrawComplaint,
	type ComplaintAttachmentSummary,
	type ComplaintReplyRule
} from '#lib/server/services/complaint/index.ts';
import { complaintStatusHistory } from '#lib/server/services/complaint/history.ts';
import { ComplaintTransitionError } from '#lib/server/services/complaint/state-machine.ts';
import { reporterIdForUser } from '#lib/server/services/complaint/visibility.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * A Warga's own view of one Keluhan: its text, the full Riwayat Status (read-only here — moving the
 * status is the pengurus's screen, `/admin/complaints/[id]`), the Tanggapan thread with a compose box
 * when this is the caller's own complaint, its photographs behind short-lived signed links, and the
 * one action a reporter still has over their own complaint while it is still `new`.
 *
 * The same screen also serves a `public` complaint reported by somebody else — the ticket's own
 * "warga dapat membaca daftar keluhan yang ditandai umum, tanpa bisa mengubah apa pun di dalamnya".
 * `getComplaint` already refuses a complaint this viewer may not read at all (`ComplaintNotFoundError`
 * for a private complaint that is not theirs, indistinguishable from one that does not exist); what
 * is left for this route to decide is only whether the *write* affordances — the reply compose box
 * and the withdraw button — belong on the page at all, and that is `isOwner`, computed once here from
 * `reporterIdForUser` and handed to the components that render them.
 *
 * ## Where the signed link is minted, and why that satisfies the ticket's own attachment rule
 *
 * `src/lib/server/ports/file-store.ts` states the rule outright: a signed link "belongs in a page a
 * recipient already reached through a permission check". `getComplaint` above is that check — it has
 * already refused a viewer who may not read this complaint before this `load` ever calls
 * `fileStore.signedLink`, so every link minted below is minted only for somebody already proven
 * entitled to the complaint the photograph belongs to. There is no second route serving attachments;
 * `src/routes/files/[...key]/+server.ts` is the only one, per the orchestrator's correction to this
 * ticket's `writes:`.
 *
 * ## Refusals
 *
 * Through `src/lib/server/route-action.ts` (#318): `PermissionDeniedError` is a 403,
 * `ComplaintNotFoundError` a 404, and a rule refusal a rejected form, `fail(400, …)`.
 */

/** The 403, and the 404 for an id that names no Keluhan this viewer may read. */
const PAGE = {
	forbidden: m.complaintDetail_forbidden,
	notFound: m.complaintDetail_notFound
} satisfies PageMessages;

/** `reply`: a named Tanggapan rule. */
const REPLY_FORM = {
	...PAGE,
	fallback: m.complaintDetail_invalidForm,
	refusals: [refusal(ComplaintReplyRuleError, ({ error }) => replyRuleMessage(error.rule))]
} satisfies FormMessages;

/** `withdraw`: a move to `withdrawn` the state machine refuses, one sentence for every case. */
const WITHDRAW_FORM = {
	...PAGE,
	fallback: m.complaintDetail_invalidForm,
	refusals: [refusal(ComplaintTransitionError, m.complaintDetail_withdrawRefused)]
} satisfies FormMessages;

/** The query parameter the "lapor keluhan" screen redirects back with. */
const CREATED_PARAMETER = 'created';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	// `complaints.id` is a `uuid` column; a non-uuid `params.id` must be refused here, before it
	// reaches `getComplaint`'s comparison — see #111 and `#lib/server/services/identifier.ts`.
	const complaintId = requireUuidParam(params.id, PAGE);

	try {
		const { db, clock, fileStore } = productionDependencies();

		const complaint = await getComplaint(db, clock, user.id, complaintId);
		const [history, replies, attachments, ownResidentId] = await Promise.all([
			complaintStatusHistory(db, user.id, complaintId),
			listComplaintReplies(db, user.id, complaintId),
			listComplaintAttachments(db, user.id, complaintId),
			reporterIdForUser(db, user.id)
		]);

		const isOwner = ownResidentId !== undefined && complaint.reporterId === ownResidentId;

		return {
			complaint: {
				id: complaint.id,
				title: complaint.title,
				category: complaint.category,
				description: complaint.description,
				status: complaint.status,
				rejectionReason: complaint.rejectionReason,
				isOwner,
				canWithdraw: isOwner && complaint.status === COMPLAINT_STATUS.new
			},
			history: history.map((change) => ({
				id: change.id,
				oldStatus: change.oldStatus,
				newStatus: change.newStatus,
				actorName: change.actorName,
				occurredAtLabel: formatInstant(change.occurredAt),
				note: change.note
			})),
			replies: replies.map((reply) => ({
				id: reply.id,
				authorName: reply.authorName,
				content: reply.content,
				createdAtLabel: formatInstant(reply.createdAt)
			})),
			attachments: await Promise.all(
				attachments.map((attachment) => toLink(attachment, fileStore))
			),
			justCreated: url.searchParams.get(CREATED_PARAMETER) === '1'
		};
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	reply: async ({ request, locals, params }) => {
		const user = requireUser(locals);
		const complaintId = requireUuidParam(params.id, PAGE);

		const form = await request.formData();
		// Not trimmed here: what counts as an empty Tanggapan is `addComplaintReply`'s rule.
		const content = String(form.get('content') ?? '');

		const { db, clock } = productionDependencies();
		try {
			await addComplaintReply(db, clock, {
				actorId: user.id,
				complaintId,
				content
			});
		} catch (caught) {
			return failOrThrow(caught, REPLY_FORM);
		}

		return { message: m.complaintDetail_replyAddedMessage() };
	},

	withdraw: async ({ locals, params }) => {
		const user = requireUser(locals);
		const complaintId = requireUuidParam(params.id, PAGE);

		const { db, clock } = productionDependencies();
		try {
			await withdrawComplaint(db, clock, {
				actorId: user.id,
				complaintId
			});
		} catch (caught) {
			return failOrThrow(caught, WITHDRAW_FORM);
		}

		return { message: m.complaintDetail_withdrawnMessage() };
	}
};

/** One attachment, with its `FileStore` key turned into a short-lived signed link. */
async function toLink(attachment: ComplaintAttachmentSummary, fileStore: FileStore) {
	return { id: attachment.id, url: await fileStore.signedLink(attachment.fileKey) };
}

/** An instant as a sentence, in the complex's own zone — `#lib/time.ts`'s `formatDateTime`. */
function formatInstant(instant: Date): string {
	return formatDateTime(instant);
}

/** The sentence a resident reads for each named Tanggapan rule refusal. */
function replyRuleMessage(rule: ComplaintReplyRule): string {
	const messages: Record<ComplaintReplyRule, () => string> = {
		[COMPLAINT_REPLY_RULE.contentRequired]: m.complaintDetail_rule_replyContentRequired,
		[COMPLAINT_REPLY_RULE.actorNotRegistered]: m.complaintDetail_rule_actorNotRegistered
	};
	return messages[rule]();
}
