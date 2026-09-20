import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { COMPLAINT_STATUS } from '$lib/server/db/schema/complaint';
import { systemClock } from '$lib/server/ports/clock';
import type { FileStore } from '$lib/server/ports/file-store';
import { assertUuidParam } from '$lib/server/services/identifier';
import {
	addComplaintReply,
	COMPLAINT_REPLY_RULE,
	ComplaintNotFoundError,
	ComplaintReplyRuleError,
	getComplaint,
	listComplaintAttachments,
	listComplaintReplies,
	withdrawComplaint,
	type ComplaintAttachmentSummary,
	type ComplaintReplyRule
} from '$lib/server/services/complaint';
import { complaintStatusHistory } from '$lib/server/services/complaint/history';
import { ComplaintTransitionError } from '$lib/server/services/complaint/state-machine';
import { reporterIdForUser } from '$lib/server/services/complaint/visibility';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
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
 */

/** The query parameter the "lapor keluhan" screen redirects back with. */
const CREATED_PARAMETER = 'created';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}
	// `complaints.id` is a `uuid` column; a non-uuid `params.id` must be refused here, before it
	// reaches `getComplaint`'s comparison — see #111 and `$lib/server/services/identifier.ts`.
	assertUuidParam(params.id, m.complaintDetail_notFound());

	try {
		const db = database();
		const fileStore = localFileStoreFromEnvironment(systemClock);

		const complaint = await getComplaint(db, systemClock, locals.user.id, params.id);
		const [history, replies, attachments, ownResidentId] = await Promise.all([
			complaintStatusHistory(db, locals.user.id, params.id),
			listComplaintReplies(db, locals.user.id, params.id),
			listComplaintAttachments(db, locals.user.id, params.id),
			reporterIdForUser(db, locals.user.id)
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
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	reply: async ({ request, locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}
		assertUuidParam(params.id, m.complaintDetail_notFound());

		const form = await request.formData();
		const content = String(form.get('content') ?? '');

		try {
			await addComplaintReply(database(), systemClock, {
				actorId: locals.user.id,
				complaintId: params.id,
				content
			});
		} catch (caught) {
			if (caught instanceof ComplaintReplyRuleError) {
				return fail(400, { message: replyRuleMessage(caught.rule) });
			}
			throwAsRouteError(caught);
		}

		return { message: m.complaintDetail_replyAddedMessage() };
	},

	withdraw: async ({ locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}
		assertUuidParam(params.id, m.complaintDetail_notFound());

		try {
			await withdrawComplaint(database(), systemClock, {
				actorId: locals.user.id,
				complaintId: params.id
			});
		} catch (caught) {
			if (caught instanceof ComplaintTransitionError) {
				return fail(400, { message: m.complaintDetail_withdrawRefused() });
			}
			throwAsRouteError(caught);
		}

		return { message: m.complaintDetail_withdrawnMessage() };
	}
};

/** One attachment, with its `FileStore` key turned into a short-lived signed link. */
async function toLink(attachment: ComplaintAttachmentSummary, fileStore: FileStore) {
	return { id: attachment.id, url: await fileStore.signedLink(attachment.fileKey) };
}

/** An instant as a sentence, in the interface locale — the same helper the admin screen carries. */
function formatInstant(instant: Date): string {
	return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'short' }).format(
		instant
	);
}

/** The sentence a resident reads for each named Tanggapan rule refusal. */
function replyRuleMessage(rule: ComplaintReplyRule): string {
	const messages: Record<ComplaintReplyRule, () => string> = {
		[COMPLAINT_REPLY_RULE.contentRequired]: m.complaintDetail_rule_replyContentRequired,
		[COMPLAINT_REPLY_RULE.actorNotRegistered]: m.complaintDetail_rule_actorNotRegistered
	};
	return messages[rule]();
}

/**
 * Turns a caught permission refusal into a 403, or a caught missing complaint into a 404, and throws
 * it — or rethrows whatever else it was. Always throws, for the reason the admin detail screen's
 * copy of this helper is declared `never`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.complaintDetail_forbidden());
	}
	if (caught instanceof ComplaintNotFoundError) {
		throw error(404, m.complaintDetail_notFound());
	}
	throw caught;
}
