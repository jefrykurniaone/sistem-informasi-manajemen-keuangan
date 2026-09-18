import {
	COMPLAINT_STATUS,
	COMPLAINT_STATUSES,
	type ComplaintStatus
} from '../../db/schema/complaint';

/**
 * **Which status a Keluhan may move to, from the one it has, and whose move it is.**
 *
 * `docs/spec-keluhan-v1.md` puts this here rather than in the database on purpose — "Perpindahan
 * yang diizinkan ditetapkan secara eksplisit di lapisan service; perpindahan lain ditolak" — and
 * `src/lib/server/db/schema/complaint.ts` records the other half of that decision: the table
 * constrains *which six values exist*, and nothing about which of them may follow which.
 *
 * ## The table carries the actor, not just the edge
 *
 * Two of this spec's rules are about *who* moves a complaint, not about where it may go:
 * a rejection is the pengurus's decision, and a withdrawal is the reporter's. Written as two
 * tables — one of legal edges and one of who may use them — they would be two places to change
 * when a status is added, and the second one is the one somebody forgets. So one table answers
 * both questions: `ALLOWED_TRANSITIONS[from][to]` is the actor the move belongs to, or `undefined`
 * when the move is not legal at all.
 *
 * That is also what keeps an admin from withdrawing somebody else's complaint through the
 * pengurus's own status screen. `changeComplaintStatus` asks for edges belonging to
 * `COMPLAINT_ACTOR.handler`; `withdrawComplaint` asks for edges belonging to
 * `COMPLAINT_ACTOR.reporter`. Neither function carries a hand-written list of the statuses it will
 * accept, so neither can drift from this table.
 *
 * ## Why these edges and not others
 *
 * Every edge below traces to a sentence of the spec, and the absences are as deliberate as the
 * entries:
 *
 * - **`new → reviewing → working → resolved`** is user story 15 read literally: "mengubah status
 *   keluhan menjadi ditinjau, dikerjakan, lalu selesai". There is no shortcut from `reviewing` to
 *   `resolved`. An admin who finds the streetlight already fixed passes through `working` for one
 *   step, which costs a click and keeps the queue's meaning exact: `working` is "somebody took
 *   this on", and a complaint that reached `resolved` without it would claim nobody did.
 * - **`rejected` is reachable from every open status**, because story 16's "menolak keluhan dengan
 *   alasan wajib" names no point in the process at which it stops being possible. A complaint can
 *   turn out to be somebody else's responsibility on first read or after a site visit, and both are
 *   the same answer to the reporter.
 * - **`withdrawn` only from `new`, and only by the reporter**, which is the spec verbatim:
 *   "`ditarik` hanya bisa dilakukan pelapor dan hanya selama status masih `baru`". Once a pengurus
 *   has looked at it, the complaint is work that happened and the reporter pulling it out from
 *   under them would erase that.
 * - **Nothing leaves `resolved`, `rejected` or `withdrawn`.** Story 18's own example — "dari selesai
 *   kembali ke baru" — is the shape of this rule, and the three terminal statuses are simply the
 *   rows with no outgoing edges. `isTerminalComplaintStatus` reads that off the table rather than
 *   repeating the list, so a later status is terminal or open by virtue of what this table says
 *   about it and not by virtue of somebody remembering to add it to a second constant.
 * - **No move backwards between open statuses**, such as `working → reviewing`. Nothing asks for
 *   one, and a status that can go round in circles makes "berapa lama ini menggantung" — the whole
 *   reason `complaint_status_changes` exists — a question with more than one answer. Adding one
 *   later costs one entry here and nothing else, which is the point of keeping the table this
 *   small.
 */

/**
 * Who a transition belongs to.
 *
 * `handler` rather than `pengurus`: `CONTEXT.md` lists "pengurus" under _Hindari_ for the Admin
 * role, because it is what people call the committee in real life and not a role this system has.
 * The English name for what `CONTEXT.md` calls "menangani Keluhan" is what this value means, and it
 * is the same word `ACTION.handleComplaints` is named after.
 */
export const COMPLAINT_ACTOR = {
	/** Whoever holds `ACTION.handleComplaints` — see `src/lib/server/authz.ts`. */
	handler: 'handler',
	/** The Warga named by `complaints.reporterId`, and nobody else. */
	reporter: 'reporter'
} as const;

/** One of the actors above. */
export type ComplaintActor = (typeof COMPLAINT_ACTOR)[keyof typeof COMPLAINT_ACTOR];

/** Every status a complaint may move to from one status, and whose move each one is. */
type TransitionsFrom = Readonly<Partial<Record<ComplaintStatus, ComplaintActor>>>;

/** The one table. See this module's doc comment for why each edge is here and each absence is not. */
const ALLOWED_TRANSITIONS: Readonly<Record<ComplaintStatus, TransitionsFrom>> = {
	[COMPLAINT_STATUS.new]: {
		[COMPLAINT_STATUS.reviewing]: COMPLAINT_ACTOR.handler,
		[COMPLAINT_STATUS.rejected]: COMPLAINT_ACTOR.handler,
		[COMPLAINT_STATUS.withdrawn]: COMPLAINT_ACTOR.reporter
	},
	[COMPLAINT_STATUS.reviewing]: {
		[COMPLAINT_STATUS.working]: COMPLAINT_ACTOR.handler,
		[COMPLAINT_STATUS.rejected]: COMPLAINT_ACTOR.handler
	},
	[COMPLAINT_STATUS.working]: {
		[COMPLAINT_STATUS.resolved]: COMPLAINT_ACTOR.handler,
		[COMPLAINT_STATUS.rejected]: COMPLAINT_ACTOR.handler
	},
	[COMPLAINT_STATUS.resolved]: {},
	[COMPLAINT_STATUS.rejected]: {},
	[COMPLAINT_STATUS.withdrawn]: {}
};

/**
 * The actor a move from `from` to `to` belongs to, or `undefined` when there is no such move.
 *
 * The one question the table answers, and the one both `changeComplaintStatus` and
 * `withdrawComplaint` ask it.
 */
export function complaintTransitionActor(
	from: ComplaintStatus,
	to: ComplaintStatus
): ComplaintActor | undefined {
	return ALLOWED_TRANSITIONS[from][to];
}

/** Whether a complaint may move from `from` to `to` at all, whoever is asking. */
export function isAllowedComplaintTransition(from: ComplaintStatus, to: ComplaintStatus): boolean {
	return complaintTransitionActor(from, to) !== undefined;
}

/**
 * Whether a complaint that reached `status` can still move anywhere.
 *
 * Read off the table rather than from a list of its own, so that "which statuses are final" cannot
 * disagree with "which moves exist".
 */
export function isTerminalComplaintStatus(status: ComplaintStatus): boolean {
	return Object.keys(ALLOWED_TRANSITIONS[status]).length === 0;
}

/**
 * The statuses a complaint can still move out of — what story 12's "daftar keluhan yang belum
 * selesai" means, and what `isComplaintStale` measures the age of.
 */
export const OPEN_COMPLAINT_STATUSES: readonly ComplaintStatus[] = COMPLAINT_STATUSES.filter(
	(status) => !isTerminalComplaintStatus(status)
);

/**
 * Thrown when a status change is not one this table permits — either because no such move exists,
 * or because it exists and belongs to somebody other than whoever asked.
 *
 * One class for both, carrying `by`, because a screen showing "selesai tidak bisa kembali ke baru"
 * and one showing "penarikan hanya bisa dilakukan pelapor" are both answering "this move is not
 * yours to make" and want the same three values to say so. Declared here rather than in
 * `src/lib/errors.ts` for the reason `PostTransitionError` and `UnitConflictError` record: a named
 * error belonging to one service module lives in that module, and only `PermissionDeniedError` —
 * which every route already catches — is shared.
 */
export class ComplaintTransitionError extends Error {
	override readonly name = 'ComplaintTransitionError';

	/** The status the complaint is in. */
	readonly from: ComplaintStatus;
	/** The status it was asked to move to. */
	readonly to: ComplaintStatus;
	/** Who was asking. */
	readonly by: ComplaintActor;

	constructor(from: ComplaintStatus, to: ComplaintStatus, by: ComplaintActor) {
		super(`A Complaint cannot move from "${from}" to "${to}" as the ${by}.`);
		this.from = from;
		this.to = to;
		this.by = by;
	}
}

/**
 * The status a complaint moves to, checked against the table for `by`.
 *
 * @throws {ComplaintTransitionError} when the move does not exist, or belongs to the other actor.
 */
export function assertComplaintTransition(
	from: ComplaintStatus,
	to: ComplaintStatus,
	by: ComplaintActor
): void {
	if (complaintTransitionActor(from, to) !== by) {
		throw new ComplaintTransitionError(from, to, by);
	}
}
