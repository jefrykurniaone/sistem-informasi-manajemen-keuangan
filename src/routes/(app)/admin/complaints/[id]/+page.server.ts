import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { ACTION, requirePermission } from '$lib/server/authz';
import { database } from '$lib/server/db';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '$lib/server/db/schema/complaint';
import { systemClock } from '$lib/server/ports/clock';
import {
	addComplaintReply,
	changeComplaintStatus,
	COMPLAINT_REPLY_RULE,
	COMPLAINT_RULE,
	ComplaintNotFoundError,
	ComplaintReplyRuleError,
	ComplaintRuleError,
	getComplaint,
	listComplaintReplies,
	type ComplaintReplyRule,
	type ComplaintRule
} from '$lib/server/services/complaint';
import { complaintStatusHistory } from '$lib/server/services/complaint/history';
import {
	COMPLAINT_ACTOR,
	complaintTransitionActor,
	ComplaintTransitionError
} from '$lib/server/services/complaint/state-machine';
import type { Actions, PageServerLoad } from './$types';

/**
 * The admin detail screen for one Keluhan: its own text, the full Riwayat Status (story 19), the
 * reply thread, a form to add to it (stories 6/17), and the one dialog that moves its status
 * (stories 15, 16, 18).
 *
 * Follows the shape `(app)/admin/posts/[id]/+page.server.ts` settled: `PermissionDeniedError`
 * becomes `error(403, …)`, `ComplaintNotFoundError` becomes `error(404, …)`, both here rather than
 * in the service, and a named rule refusal or a refused transition is a rejected form —
 * `fail(400, …)` — because the actor was inside their rights and the specific request is what was
 * wrong.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const db = database();
		await requirePermission(db, locals.user.id, ACTION.readAllComplaints);

		const complaint = await getComplaint(db, systemClock, locals.user.id, params.id);
		const [history, replies] = await Promise.all([
			complaintStatusHistory(db, locals.user.id, params.id),
			listComplaintReplies(db, locals.user.id, params.id)
		]);

		return {
			complaint: {
				id: complaint.id,
				title: complaint.title,
				category: complaint.category,
				description: complaint.description,
				status: complaint.status,
				visibility: complaint.visibility,
				rejectionReason: complaint.rejectionReason,
				ageDays: Math.floor(complaint.ageMilliseconds / (24 * 60 * 60 * 1000)),
				stale: complaint.stale
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
			// Only the moves that belong to the handler, per `./state-machine.ts`'s own table — never
			// `withdrawn`, which belongs to the reporter alone, whatever this screen's caller holds.
			allowedTransitions: allowedHandlerTransitionsFrom(complaint.status)
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	changeStatus: async ({ request, locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const to = String(form.get('to') ?? '').trim();
		const note = String(form.get('note') ?? '').trim();
		const rejectionReason = String(form.get('rejectionReason') ?? '').trim();

		if (!isComplaintStatus(to)) {
			return fail(400, { message: m.adminComplaintDetail_invalidForm() });
		}

		try {
			await changeComplaintStatus(database(), systemClock, {
				actorId: locals.user.id,
				complaintId: params.id,
				to,
				note: note || null,
				rejectionReason: rejectionReason || null
			});
		} catch (caught) {
			if (caught instanceof ComplaintRuleError) {
				return fail(400, { message: complaintRuleMessage(caught.rule) });
			}
			if (caught instanceof ComplaintTransitionError) {
				return fail(400, {
					message: m.adminComplaintDetail_transitionRefused({ from: caught.from, to: caught.to })
				});
			}
			throwAsRouteError(caught);
		}

		return { message: m.adminComplaintDetail_statusChangedMessage() };
	},

	reply: async ({ request, locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

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

		return { message: m.adminComplaintDetail_replyAddedMessage() };
	}
};

/** Whether `value` is one of the six status values, narrowing it for `changeComplaintStatus`. */
function isComplaintStatus(value: string): value is ComplaintStatus {
	return (COMPLAINT_STATUSES as readonly string[]).includes(value);
}

/**
 * Every status `from` may move to as the handler — never as the reporter — read straight off
 * `./state-machine.ts`'s table rather than a list kept here. This is the one place that table's
 * answer turns into what the dialog is allowed to offer.
 */
function allowedHandlerTransitionsFrom(from: ComplaintStatus): readonly ComplaintStatus[] {
	return COMPLAINT_STATUSES.filter(
		(to) => complaintTransitionActor(from, to) === COMPLAINT_ACTOR.handler
	);
}

/** An instant as a sentence, in the interface locale — the same helper the posts screens carry. */
function formatInstant(instant: Date): string {
	return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'short' }).format(
		instant
	);
}

/** The sentence a person reads for each named Keluhan rule refusal. */
function complaintRuleMessage(rule: ComplaintRule): string {
	const messages: Record<ComplaintRule, () => string> = {
		[COMPLAINT_RULE.rejectionNeedsReason]: m.adminComplaintDetail_rule_rejectionNeedsReason,
		[COMPLAINT_RULE.reasonWithoutRejection]: m.adminComplaintDetail_rule_reasonWithoutRejection,
		[COMPLAINT_RULE.visibilityOnlyLowers]: m.adminComplaintDetail_rule_visibilityOnlyLowers,
		[COMPLAINT_RULE.actorNotRegistered]: m.adminComplaintDetail_rule_actorNotRegistered
	};
	return messages[rule]();
}

/** The sentence a person reads for each named Tanggapan rule refusal. */
function replyRuleMessage(rule: ComplaintReplyRule): string {
	const messages: Record<ComplaintReplyRule, () => string> = {
		[COMPLAINT_REPLY_RULE.contentRequired]: m.adminComplaintDetail_rule_replyContentRequired,
		[COMPLAINT_REPLY_RULE.actorNotRegistered]: m.adminComplaintDetail_rule_actorNotRegistered
	};
	return messages[rule]();
}

/**
 * Turns a caught permission refusal into a 403, or a caught missing complaint into a 404, and
 * throws it — or rethrows whatever else it was. Always throws, for the reason the posts screens'
 * copies of this helper are declared `never`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminComplaintDetail_forbidden());
	}
	if (caught instanceof ComplaintNotFoundError) {
		throw error(404, m.adminComplaintDetail_notFound());
	}
	throw caught;
}
