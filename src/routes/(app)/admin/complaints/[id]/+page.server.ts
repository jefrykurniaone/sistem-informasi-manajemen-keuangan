import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { ACTION, requirePermission } from '#lib/server/authz.ts';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '#lib/server/db/schema/complaint.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
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
	changeComplaintStatus,
	COMPLAINT_REPLY_RULE,
	COMPLAINT_RULE,
	ComplaintReplyRuleError,
	ComplaintRuleError,
	getComplaint,
	listComplaintReplies,
	type ComplaintReplyRule,
	type ComplaintRule
} from '#lib/server/services/complaint/index.ts';
import { complaintStatusHistory } from '#lib/server/services/complaint/history.ts';
import {
	COMPLAINT_ACTOR,
	complaintTransitionActor,
	ComplaintTransitionError
} from '#lib/server/services/complaint/state-machine.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The admin detail screen for one Keluhan: its own text, the full Riwayat Status (story 19), the
 * reply thread, a form to add to it (stories 6/17), and the one dialog that moves its status
 * (stories 15, 16, 18).
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): `PermissionDeniedError`
 * becomes `error(403, …)`, `ComplaintNotFoundError` becomes `error(404, …)`, both here rather than
 * in the service, and a rule refusal or a refused transition is a rejected form —
 * `fail(400, …)` — because the actor was inside their rights and the specific request is what was
 * wrong.
 */

/** The 403 for anyone who may not handle Keluhan, and the 404 for an id that names none. */
const PAGE = {
	forbidden: m.adminComplaintDetail_forbidden,
	notFound: m.adminComplaintDetail_notFound
} satisfies PageMessages;

/** `changeStatus`: a named Keluhan rule, or a move the state machine does not allow the handler. */
const CHANGE_STATUS_FORM = {
	...PAGE,
	fallback: m.adminComplaintDetail_invalidForm,
	refusals: [
		refusal(ComplaintRuleError, ({ error }) => complaintRuleMessage(error.rule)),
		refusal(ComplaintTransitionError, ({ error }) =>
			m.adminComplaintDetail_transitionRefused({ from: error.from, to: error.to })
		)
	]
} satisfies FormMessages;

/** `reply`: a named Tanggapan rule. */
const REPLY_FORM = {
	...PAGE,
	fallback: m.adminComplaintDetail_invalidForm,
	refusals: [refusal(ComplaintReplyRuleError, ({ error }) => replyRuleMessage(error.rule))]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	// `complaints.id` is a `uuid` column — see #111 and `#lib/server/services/identifier.ts`.
	const complaintId = requireUuidParam(params.id, PAGE);

	const { db, clock } = productionDependencies();
	try {
		await requirePermission(db, user.id, ACTION.readAllComplaints);

		const complaint = await getComplaint(db, clock, user.id, complaintId);
		const [history, replies] = await Promise.all([
			complaintStatusHistory(db, user.id, complaintId),
			listComplaintReplies(db, user.id, complaintId)
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
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	changeStatus: async ({ request, locals, params }) => {
		const user = requireUser(locals);
		const complaintId = requireUuidParam(params.id, PAGE);

		const form = await request.formData();
		const to = readText(form, 'to');
		const note = readText(form, 'note');
		const rejectionReason = readText(form, 'rejectionReason');

		if (!isComplaintStatus(to)) {
			return fail(400, { message: m.adminComplaintDetail_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			await changeComplaintStatus(db, clock, {
				actorId: user.id,
				complaintId,
				to,
				note: note || null,
				rejectionReason: rejectionReason || null
			});
		} catch (caught) {
			return failOrThrow(caught, CHANGE_STATUS_FORM);
		}

		return { message: m.adminComplaintDetail_statusChangedMessage() };
	},

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

/** An instant as a sentence, in the complex's own zone — `#lib/time.ts`'s `formatDateTime`. */
function formatInstant(instant: Date): string {
	return formatDateTime(instant);
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
