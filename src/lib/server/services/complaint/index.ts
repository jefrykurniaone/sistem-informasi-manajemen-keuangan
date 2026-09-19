import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import type { Database } from '../../db';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITIES,
	COMPLAINT_VISIBILITY,
	complaintAttachments,
	complaints,
	type Complaint,
	type ComplaintStatus,
	type ComplaintVisibility
} from '../../db/schema/complaint';
import type { Clock } from '../../ports/clock';
import type { FileStore } from '../../ports/file-store';
import { storeComplaintAttachments, type ComplaintAttachmentUpload } from './attachment';
import { complaintAge, isComplaintStale, recordComplaintStatusChange } from './history';
import { notifyComplaintStatusChanged, notifyNewComplaint } from './notification';
import {
	assertComplaintTransition,
	COMPLAINT_ACTOR,
	OPEN_COMPLAINT_STATUSES
} from './state-machine';
import {
	complaintReadScopeFor,
	complaintScopeFilter,
	reporterIdForUser,
	type ComplaintReadScope
} from './visibility';

/**
 * `./reply.ts` and `./worklist.ts` are re-exported from here so that a caller of this module's
 * public surface — the admin screens in this ticket, and #44's resident screens after it — reaches
 * every Keluhan service function through the one module, the same way `listComplaints`,
 * `getComplaint` and the status movers already do. Neither file imports anything back from this
 * one: both read `./visibility.ts` directly, exactly as this module does, so there is no cycle
 * between them.
 */
export {
	addComplaintReply,
	COMPLAINT_REPLY_RULE,
	ComplaintReplyRuleError,
	listComplaintReplies,
	type AddComplaintReplyRequest,
	type ComplaintReplyRule,
	type ComplaintReplyWithAuthor
} from './reply';
export { complaintWorklistSummary, type ComplaintWorklistSummary } from './worklist';
/**
 * `./attachment.ts` is re-exported here for the same reason `./reply.ts` and `./worklist.ts` are:
 * one module surface for every Keluhan service function. It reads `./visibility.ts` directly and
 * imports nothing back from this module — `createComplaint` below imports `storeComplaintAttachments`
 * straight from `./attachment.ts` rather than through this re-export, which is what keeps this file
 * from importing itself.
 */
export {
	ATTACHMENT_CONTENT_TYPES,
	COMPLAINT_ATTACHMENT_RULE,
	ComplaintAttachmentRuleError,
	MAX_ATTACHMENTS_PER_COMPLAINT,
	MAXIMUM_ATTACHMENT_BYTES,
	MAXIMUM_ATTACHMENT_MEBIBYTES,
	listComplaintAttachments,
	storeComplaintAttachments,
	type ComplaintAttachmentRule,
	type ComplaintAttachmentSummary,
	type ComplaintAttachmentUpload,
	type StoredComplaintAttachment
} from './attachment';

/**
 * **The Keluhan service: the rules that make a complaint trustworthy.**
 *
 * `docs/spec-keluhan-v1.md` puts all of them at this layer for one stated reason — "aturan
 * 'penolakan harus beralasan' yang hanya hidup di formulir akan hilang begitu ada jalan kedua
 * menuju data yang sama". So every rule below fails when called from outside a form, and the
 * acceptance criteria are written as tests against these functions rather than against a screen.
 *
 * ## What this module owns
 *
 * - **Moving a complaint**, through `./state-machine.ts`'s table and nothing else. A transition
 *   writes the new status, a Riwayat Status row and an audit row in one transaction, so a history
 *   that disagrees with the status column is not a state this application can reach.
 * - **The two rules the database deliberately does not hold.** `complaints_rejection_reason_check`
 *   only forbids a reason on a row that is not `rejected`; requiring one *on* a rejection is here,
 *   because a `CHECK` constraint cannot tell a rejection being written now from one written last
 *   year. Likewise visibility: the column allows both values and only this module knows that the
 *   move between them goes one way.
 * - **Reading**, through `./visibility.ts` and only through it.
 *
 * ## What it deliberately does not own
 *
 * - **There is no `deleteComplaint`, and there must never be one.** `withdrawn` is what a reporter
 *   taking a complaint back means, and it keeps the history that says so. Same rule the Unit and
 *   Post services state about their own deletes.
 * - **No paging on `listComplaints`.** `listPosts` has it because the admin Post screen needed it,
 *   and the screen's ticket is where that decision belongs; the admin queue's sort — longest wait
 *   first — is the part this ticket's acceptance criteria name, and it is here.
 * - **No email.** `createComplaint` below writes the row, its Lampiran and its audit entry; queuing
 *   the "keluhan baru" message to every admin is #46, which waits on #44 landing first — see this
 *   module's own doc comment on `createComplaint`.
 *
 * ## Permission, in two halves
 *
 * `ACTION.handleComplaints` for the pengurus's moves and `ACTION.readAllComplaints` for reading
 * everything — two actions held by two different sets, with the argument recorded next to
 * `PERMISSIONS` in `src/lib/server/authz.ts`. The reporter's own two moves, withdrawing and
 * lowering visibility, are guarded by row ownership instead and refused with `PermissionDeniedError`
 * all the same, so a route never learns a second error class for a refusal of the caller.
 */

/** The audit log's `action` for a Keluhan reported for the first time. */
export const COMPLAINT_CREATED_ACTION = 'complaint_created';
/** The audit log's `action` for a Keluhan that moved between statuses, withdrawals included. */
export const COMPLAINT_STATUS_CHANGED_ACTION = 'complaint_status_changed';
/** The audit log's `action` for a Keluhan whose visibility was lowered. */
export const COMPLAINT_VISIBILITY_CHANGED_ACTION = 'complaint_visibility_changed';

/** Who is reporting, what they wrote, and the photographs they attached. */
export interface CreateComplaintRequest {
	/** The signed-in account. Resolved to a `residents` row before anything is written. */
	readonly actorId: string;
	readonly title: string;
	readonly category: string;
	readonly description: string;
	/** `private` by default in every screen this ticket builds; a resident may choose `public`. */
	readonly visibility: ComplaintVisibility;
	/** At most `MAX_ATTACHMENTS_PER_COMPLAINT` — see `./attachment.ts`. */
	readonly attachments: readonly ComplaintAttachmentUpload[];
}

/**
 * What a caller may hand `createComplaint` instead of the production `new-complaint` notifier.
 *
 * The one field is for a test only, the same shape `PublishPostSettings` in `../post/index.ts`
 * takes for `notifyNewPost`: production code never has a reason to pass it, so every existing
 * caller of `createComplaint` keeps compiling unchanged against this argument being optional.
 */
export interface CreateComplaintSettings {
	/**
	 * Replaces `notifyNewComplaint` for this call. A test hands this a spy or a no-op so it can
	 * assert on the decision to notify without a real `Database` write; production code never sets
	 * it, so `createComplaint` always queues through the real recipient list otherwise.
	 */
	readonly notify?: (db: Database, clock: Clock, complaint: Complaint) => Promise<void>;
}

/**
 * Reports a new Keluhan — user stories 1 through 3 of `docs/spec-keluhan-v1.md`, and the acceptance
 * criterion `writes:` had no service layer for at all until the orchestrator's correction to this
 * ticket added this function and `./attachment.ts`.
 *
 * A fresh complaint always starts `new` with `statusChangedAt` equal to `createdAt` — the same
 * starting point `./history.ts`'s doc comment describes — and carries no `complaint_status_changes`
 * row, because nothing has moved yet.
 *
 * **The id is minted before the row exists**, the same move `recordPayment` makes in
 * `../dues/payment.ts`: it is what lets every attachment's storage key be built and stored *before*
 * `complaints.id` is written, so `complaint_attachments.fileKey` never depends on an update that
 * happens later. Attachments are stored inside the same transaction that inserts the complaint and
 * its Lampiran rows, in the order checks, then storage, then the insert — `recordPayment`'s order,
 * extended to a batch of files: a request refused by a rule is refused before any byte is written,
 * and a row that never commits can at worst leave an unreferenced blob behind, never a Lampiran row
 * pointing at a file that is not there.
 *
 * **The `new-complaint` email is queued here, after the transaction commits.** #46's acceptance
 * criterion — "keluhan baru mengantrekan satu email kepada setiap pemegang peran admin yang
 * menyalakan langganan keluhan baru" — is `notifyNewComplaint` in `./notification.ts`, called with
 * the plain database rather than `transaction`, the same ordering `publishPost` in `../post/index.ts`
 * uses for its own `new-post` email: a Keluhan whose commit is rolled back for some other reason
 * must never have already promised an email that announces it.
 *
 * @param settings `notify` replaces `notifyNewComplaint` for this call — a test hands it a spy or a
 *   no-op so it can assert on the decision to notify without a real email being queued; production
 *   code never sets it, so every existing caller keeps compiling unchanged.
 * @throws {ComplaintRuleError} `actorNotRegistered` when `actorId` has no `residents` row to
 *   attribute the complaint to.
 * @throws {TypeError} when the title, category or description is empty after trimming, or
 *   `visibility` is not one of `COMPLAINT_VISIBILITIES` — both are mistakes a correct screen never
 *   makes, the same split `validatePostContent` in `../post/index.ts` draws between a screen bug and
 *   a domain rule.
 * @throws {ComplaintAttachmentRuleError} `tooMany`, `attachmentTooLarge` or `attachmentNotAnImage` —
 *   see `./attachment.ts`.
 */
export async function createComplaint(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	request: CreateComplaintRequest,
	settings: CreateComplaintSettings = {}
): Promise<Complaint> {
	const title = request.title.trim();
	const category = request.category.trim();
	const description = request.description.trim();
	if (title === '' || category === '' || description === '') {
		throw new TypeError('A complaint needs a non-empty title, category and description.');
	}
	if (!COMPLAINT_VISIBILITIES.includes(request.visibility)) {
		throw new TypeError(
			`"${request.visibility}" is not one of ${COMPLAINT_VISIBILITIES.join(', ')}.`
		);
	}

	// Minted here, before the row exists — see this function's doc comment.
	const id = randomUUID();

	const created = await db.transaction(async (transaction) => {
		const reporterId = await requireResidentId(transaction, request.actorId);

		// Checked and stored before the row is inserted: a batch refused by `./attachment.ts`'s rules
		// leaves nothing behind for this complaint to point at.
		const attachments = await storeComplaintAttachments(fileStore, id, request.attachments);

		const now = clock.now();
		const [row] = await transaction
			.insert(complaints)
			.values({
				id,
				reporterId,
				title,
				category,
				description,
				status: COMPLAINT_STATUS.new,
				visibility: request.visibility,
				rejectionReason: null,
				createdAt: now,
				statusChangedAt: now
			})
			.returning();

		if (attachments.length > 0) {
			await transaction.insert(complaintAttachments).values(
				attachments.map((attachment) => ({
					id: attachment.id,
					complaintId: row.id,
					fileKey: attachment.fileKey,
					createdAt: now
				}))
			);
		}

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: COMPLAINT_CREATED_ACTION,
			targetId: row.id,
			after: {
				title: row.title,
				category: row.category,
				visibility: row.visibility,
				attachmentCount: attachments.length
			}
		});

		return row;
	});

	const notify = settings.notify ?? notifyNewComplaint;
	await notify(db, clock, created);

	return created;
}

/**
 * The refusal `PermissionDeniedError` carries when somebody who is not the reporter tries to
 * withdraw a complaint. Not a value of `ACTION`: see `src/lib/server/authz.ts` for why an "only
 * their own row" rule has no entry in `PERMISSIONS`, and `services/resident/profile.ts` for the
 * same dotted name used the same way.
 */
const WITHDRAW_OWN_COMPLAINT = 'complaints.withdrawOwn';

/** The same, for lowering a complaint's visibility. */
const LOWER_OWN_COMPLAINT_VISIBILITY = 'complaints.lowerOwnVisibility';

/**
 * Every rule this service refuses a request for, other than permission and the state machine.
 *
 * Named refusals of a specific change rather than of the caller: the actor was inside their rights
 * and the request itself is what is wrong, so a route answers these with `fail(400, …)` rather than
 * a 403 — the same split `PostRuleError` and `LastSuperuserError` record.
 */
export const COMPLAINT_RULE = {
	/** A complaint was rejected without a reason. Story 16's "alasan wajib". */
	rejectionNeedsReason: 'rejectionNeedsReason',
	/** A reason was given for a move that is not a rejection. */
	reasonWithoutRejection: 'reasonWithoutRejection',
	/** A visibility change that was not `public` becoming `private`. */
	visibilityOnlyLowers: 'visibilityOnlyLowers',
	/** The signed-in account has no `residents` row, so there is nobody to attribute the move to. */
	actorNotRegistered: 'actorNotRegistered'
} as const;

/** One of the rules above. */
export type ComplaintRule = (typeof COMPLAINT_RULE)[keyof typeof COMPLAINT_RULE];

/**
 * Thrown when a request breaks one of the rules in `COMPLAINT_RULE`.
 *
 * One class carrying a `rule`, for the reason `PostRuleError` records: a route catches it once and
 * picks the sentence a person reads from `rule`, and a later rule costs an entry above instead of a
 * new `catch` arm at every call site.
 */
export class ComplaintRuleError extends Error {
	override readonly name = 'ComplaintRuleError';

	/** Which rule refused the request. */
	readonly rule: ComplaintRule;

	constructor(rule: ComplaintRule, detail: string) {
		super(`A Complaint request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/**
 * Thrown when `complaintId` names no complaint **the caller may read**.
 *
 * The two cases are one error on purpose. `getComplaint` puts the visibility rule into the `where`,
 * so a complaint somebody else reported privately and a complaint that does not exist come back
 * identically — as no row. Telling them apart is what would let a neighbour confirm, one guessed
 * address at a time, that a private complaint exists.
 */
export class ComplaintNotFoundError extends Error {
	override readonly name = 'ComplaintNotFoundError';

	/** The id that named no readable complaint. */
	readonly complaintId: string;

	constructor(complaintId: string) {
		super(`No complaint readable by this caller exists with id "${complaintId}".`);
		this.complaintId = complaintId;
	}
}

/**
 * A complaint together with how long it has sat where it is — story 13's "umur setiap keluhan,
 * supaya yang tertinggal tujuh hari terlihat jelas".
 */
export interface ComplaintWithAge extends Complaint {
	/** How long since the last status change, in milliseconds. */
	readonly ageMilliseconds: number;
	/** Whether it is still open and has been hanging longer than the threshold. */
	readonly stale: boolean;
}

/** What a complaint list asks for. */
export interface ListComplaintsRequest {
	/** The signed-in account, or `null` when nobody is signed in — which reads nothing. */
	readonly viewerUserId: string | null;
	/** Only this status. Missing means every status the viewer may read. */
	readonly status?: ComplaintStatus;
	/** Only this category. Missing means every category. */
	readonly category?: string;
	/** Only complaints that can still move — story 12's "yang belum selesai". */
	readonly onlyOpen?: boolean;
}

/**
 * Every complaint `viewerUserId` may read, longest wait first.
 *
 * The sort is story 12's "terurut dari yang paling lama menunggu", which is oldest
 * `statusChangedAt` first, and it is the same column `complaints_status_changed_at_idx` exists for.
 *
 * This function refuses nobody. A viewer who may read nothing — signed out — gets an empty list,
 * because the scope's filter is a condition that matches no row rather than a missing `where`; see
 * `./visibility.ts`.
 */
export async function listComplaints(
	db: Database,
	clock: Clock,
	request: ListComplaintsRequest
): Promise<readonly ComplaintWithAge[]> {
	const scope = await complaintReadScopeFor(db, request.viewerUserId);

	const rows = await db
		.select()
		.from(complaints)
		.where(and(...listConditions(scope, request)))
		// `id` breaks the tie so that two complaints last moved in the same instant always come back
		// in the same order.
		.orderBy(asc(complaints.statusChangedAt), asc(complaints.id));

	return rows.map((row) => withAge(clock, row));
}

/** The conditions a list query runs under: the visibility rule first, then whatever was filtered. */
function listConditions(
	scope: ComplaintReadScope,
	request: ListComplaintsRequest
): (SQL | undefined)[] {
	const conditions: (SQL | undefined)[] = [complaintScopeFilter(scope)];
	if (request.status) {
		conditions.push(eq(complaints.status, request.status));
	}
	if (request.category) {
		conditions.push(eq(complaints.category, request.category));
	}
	if (request.onlyOpen) {
		conditions.push(inArray(complaints.status, [...OPEN_COMPLAINT_STATUSES]));
	}
	return conditions;
}

/**
 * The one complaint named by `complaintId`, if `viewerUserId` may read it.
 *
 * **The visibility rule is part of the query, not a check on the row it returned.** That is what
 * makes a guessed id useless: there is no execution path in which a complaint the caller may not
 * read is ever loaded, so there is nothing for a later edit to forget to check.
 *
 * @throws {ComplaintNotFoundError} when no such complaint exists, or it exists and this viewer may
 *   not read it. Deliberately the same answer for both.
 */
export async function getComplaint(
	db: Database,
	clock: Clock,
	viewerUserId: string | null,
	complaintId: string
): Promise<ComplaintWithAge> {
	const scope = await complaintReadScopeFor(db, viewerUserId);

	const [row] = await db
		.select()
		.from(complaints)
		.where(and(eq(complaints.id, complaintId), complaintScopeFilter(scope)))
		.limit(1);

	if (!row) {
		throw new ComplaintNotFoundError(complaintId);
	}
	return withAge(clock, row);
}

/** Who is moving a complaint, which one, and where to. */
export interface ChangeComplaintStatusRequest {
	/** The signed-in account. Checked against `ACTION.handleComplaints` before anything else. */
	readonly actorId: string;
	readonly complaintId: string;
	/** Where it should go. Checked against the state machine for `COMPLAINT_ACTOR.handler`. */
	readonly to: ComplaintStatus;
	/** Free-text colour for the Riwayat Status row. Never the rejection's reason. */
	readonly note?: string | null;
	/** Required when `to` is `rejected`, and refused otherwise. */
	readonly rejectionReason?: string | null;
}

/**
 * What a caller may hand `changeComplaintStatus` instead of the production
 * `own-complaint-status-changed` notifier. The same shape `CreateComplaintSettings` takes, for the
 * same reason.
 */
export interface ChangeComplaintStatusSettings {
	/**
	 * Replaces `notifyComplaintStatusChanged` for this call. A test hands this a spy or a no-op so
	 * it can assert on the decision to notify without a real `Database` write; production code
	 * never sets it, so `changeComplaintStatus` always queues to the reporter otherwise.
	 */
	readonly notify?: (
		db: Database,
		clock: Clock,
		complaint: Complaint,
		note: string | null
	) => Promise<void>;
}

/**
 * Moves a complaint as the pengurus — stories 15 and 16, and story 18's refusal of everything else.
 *
 * `withdrawn` is not reachable from here however the request is built: the state machine says that
 * edge belongs to `COMPLAINT_ACTOR.reporter`, and this function only ever asks for the handler's.
 *
 * **The `own-complaint-status-changed` email is queued here, after the transaction commits**, the
 * same ordering `createComplaint` uses for `new-complaint` above — see that function's doc comment.
 * `withdrawComplaint` below shares `moveComplaint` with this function but never queues this email:
 * #46's acceptance criterion is explicit that a reporter withdrawing their own complaint must not
 * be emailed about it.
 *
 * @param settings `notify` replaces `notifyComplaintStatusChanged` for this call — see
 *   `ChangeComplaintStatusSettings`.
 * @throws {PermissionDeniedError} when `actorId` may not handle complaints.
 * @throws {ComplaintRuleError} `actorNotRegistered`, `rejectionNeedsReason` for a rejection with no
 *   reason, or `reasonWithoutRejection` for a reason on anything else.
 * @throws {ComplaintNotFoundError} when `complaintId` names no complaint.
 * @throws {ComplaintTransitionError} when the move is not one the handler may make.
 */
export async function changeComplaintStatus(
	db: Database,
	clock: Clock,
	request: ChangeComplaintStatusRequest,
	settings: ChangeComplaintStatusSettings = {}
): Promise<ComplaintWithAge> {
	const note = trimmedOrNull(request.note);

	const row = await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.handleComplaints);
		const actorResidentId = await requireResidentId(transaction, request.actorId);

		const [existing] = await transaction
			.select()
			.from(complaints)
			.where(eq(complaints.id, request.complaintId))
			.limit(1);
		if (!existing) {
			throw new ComplaintNotFoundError(request.complaintId);
		}

		assertComplaintTransition(existing.status, request.to, COMPLAINT_ACTOR.handler);

		return moveComplaint(transaction, clock, {
			existing,
			to: request.to,
			actorUserId: request.actorId,
			actorResidentId,
			note,
			rejectionReason: rejectionReasonFor(request.to, request.rejectionReason)
		});
	});

	const notify = settings.notify ?? notifyComplaintStatusChanged;
	await notify(db, clock, row, note);

	return withAge(clock, row);
}

/** Who is withdrawing, and which complaint. */
export interface WithdrawComplaintRequest {
	/** The signed-in account. Must be the complaint's reporter. */
	readonly actorId: string;
	readonly complaintId: string;
	/** Free-text colour for the Riwayat Status row. */
	readonly note?: string | null;
}

/**
 * Takes a complaint back — story 10, "menarik kembali keluhan saya selama belum ditangani".
 *
 * Two separate rules, refused by two separate mechanisms so that neither can stand in for the
 * other: *who* is enforced by the row's own `reporterId`, and *when* by the state machine, where
 * `withdrawn` is reachable only from `new`. An admin calling this for somebody else's complaint is
 * refused by the first even though they hold every complaint action there is.
 *
 * @throws {PermissionDeniedError} when the caller is not this complaint's reporter — and equally
 *   when the id names nothing, so that a guess cannot tell the two apart.
 * @throws {ComplaintRuleError} `actorNotRegistered`.
 * @throws {ComplaintTransitionError} when the complaint has already moved past `new`.
 */
export async function withdrawComplaint(
	db: Database,
	clock: Clock,
	request: WithdrawComplaintRequest
): Promise<ComplaintWithAge> {
	const row = await db.transaction(async (transaction) => {
		const actorResidentId = await requireResidentId(transaction, request.actorId);
		const existing = await findOwnComplaint(transaction, {
			complaintId: request.complaintId,
			actorUserId: request.actorId,
			actorResidentId,
			refusedAs: WITHDRAW_OWN_COMPLAINT
		});

		assertComplaintTransition(
			existing.status,
			COMPLAINT_STATUS.withdrawn,
			COMPLAINT_ACTOR.reporter
		);

		return moveComplaint(transaction, clock, {
			existing,
			to: COMPLAINT_STATUS.withdrawn,
			actorUserId: request.actorId,
			actorResidentId,
			note: trimmedOrNull(request.note),
			rejectionReason: null
		});
	});

	return withAge(clock, row);
}

/** Who is changing a complaint's visibility, which one, and to what. */
export interface SetComplaintVisibilityRequest {
	/** The signed-in account. Must be the complaint's reporter. */
	readonly actorId: string;
	readonly complaintId: string;
	/** The only change this accepts is `public` becoming `private`. */
	readonly to: ComplaintVisibility;
}

/**
 * Lowers a complaint from `public` to `private`, and refuses every other change.
 *
 * The spec's reason for the one-way street is worth repeating where the code is: "sesuatu yang
 * sudah terlihat tetangga tidak bisa ditarik kembali dengan mengubah satu kolom, dan berpura-pura
 * bisa akan menyesatkan". Lowering is honest — it stops new readers — and raising is not, because
 * the neighbours who already read it cannot be made to forget.
 *
 * **The reporter, and nobody else.** The spec grants this to "pelapor" and names no second actor,
 * so an admin does not get it here; giving the handler a way to hide somebody's complaint is a
 * decision no story asks for, and it costs one branch to add when one does.
 *
 * @throws {PermissionDeniedError} when the caller is not this complaint's reporter, or the id names
 *   nothing.
 * @throws {ComplaintRuleError} `actorNotRegistered`, or `visibilityOnlyLowers` for anything that is
 *   not `public` becoming `private` — a widening and a no-op alike.
 */
export async function setComplaintVisibility(
	db: Database,
	clock: Clock,
	request: SetComplaintVisibilityRequest
): Promise<ComplaintWithAge> {
	const row = await db.transaction(async (transaction) => {
		const actorResidentId = await requireResidentId(transaction, request.actorId);
		const existing = await findOwnComplaint(transaction, {
			complaintId: request.complaintId,
			actorUserId: request.actorId,
			actorResidentId,
			refusedAs: LOWER_OWN_COMPLAINT_VISIBILITY
		});

		assertVisibilityLowering(existing.visibility, request.to);

		const [updated] = await transaction
			.update(complaints)
			.set({ visibility: request.to })
			.where(eq(complaints.id, existing.id))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: COMPLAINT_VISIBILITY_CHANGED_ACTION,
			targetId: updated.id,
			before: { visibility: existing.visibility },
			after: { visibility: updated.visibility }
		});

		return updated;
	});

	return withAge(clock, row);
}

/** One transition, as the two public movers hand it over. */
interface ComplaintMove {
	readonly existing: Complaint;
	readonly to: ComplaintStatus;
	/** The signed-in account, for the audit row. */
	readonly actorUserId: string;
	/** The same person as a `residents.id`, for the Riwayat Status row. */
	readonly actorResidentId: string;
	readonly note: string | null;
	readonly rejectionReason: string | null;
}

/**
 * Writes a transition: the row, its history entry and its audit entry, from one instant.
 *
 * The single place `complaints.status` is written, which is what makes "every transition produces
 * exactly one history row" true rather than a convention every caller is trusted to keep. It runs
 * inside the caller's transaction, so a history row cannot survive a status change that rolled
 * back.
 *
 * `rejectionReason` is written on every move, not only on a rejection. It is `null` for all of them
 * except a rejection, which keeps `complaints_rejection_reason_check` satisfied by construction —
 * and because `rejected` is terminal in the state machine, there is no move *out* of it for that
 * null to erase a real reason from.
 */
async function moveComplaint(
	writer: DatabaseWriter,
	clock: Clock,
	move: ComplaintMove
): Promise<Complaint> {
	const occurredAt = clock.now();

	const [row] = await writer
		.update(complaints)
		.set({ status: move.to, rejectionReason: move.rejectionReason, statusChangedAt: occurredAt })
		.where(eq(complaints.id, move.existing.id))
		.returning();

	await recordComplaintStatusChange(writer, {
		complaintId: row.id,
		oldStatus: move.existing.status,
		newStatus: row.status,
		actorId: move.actorResidentId,
		note: move.note,
		occurredAt
	});

	await recordAuditEntry(writer, clock, {
		actorId: move.actorUserId,
		action: COMPLAINT_STATUS_CHANGED_ACTION,
		targetId: row.id,
		before: { status: move.existing.status, rejectionReason: move.existing.rejectionReason },
		after: { status: row.status, rejectionReason: row.rejectionReason }
	});

	return row;
}

/** What `findOwnComplaint` needs to load a row and to name the refusal when it cannot. */
interface OwnComplaintLookup {
	readonly complaintId: string;
	readonly actorUserId: string;
	readonly actorResidentId: string;
	readonly refusedAs: string;
}

/**
 * The complaint named by `complaintId`, but only if `actorResidentId` reported it.
 *
 * Ownership is in the `where` rather than compared afterwards, so "somebody else's" and "no such
 * complaint" are one answer — `PermissionDeniedError`, the class `requirePermission` throws, per
 * the pattern `services/resident/profile.ts` settled for a row a person owns.
 */
async function findOwnComplaint(
	writer: DatabaseWriter,
	lookup: OwnComplaintLookup
): Promise<Complaint> {
	const [row] = await writer
		.select()
		.from(complaints)
		.where(
			and(eq(complaints.id, lookup.complaintId), eq(complaints.reporterId, lookup.actorResidentId))
		)
		.limit(1);

	if (!row) {
		throw new PermissionDeniedError(lookup.actorUserId, lookup.refusedAs);
	}
	return row;
}

/**
 * The `residents.id` behind a signed-in account.
 *
 * @throws {ComplaintRuleError} `actorNotRegistered` when the account has none. An expected state,
 *   not a bug — see `src/lib/server/db/schema/resident.ts` — but not one a complaint can be
 *   attributed to, so it is refused by name rather than by a foreign key violation.
 */
async function requireResidentId(writer: DatabaseWriter, userId: string): Promise<string> {
	const residentId = await reporterIdForUser(writer, userId);
	if (!residentId) {
		throw new ComplaintRuleError(
			COMPLAINT_RULE.actorNotRegistered,
			`User "${userId}" has no residents row to attribute a complaint move to.`
		);
	}
	return residentId;
}

/**
 * The reason to store for a move to `to`, checked both ways.
 *
 * Story 16 asks for the first half — a rejection needs a reason. The second half is the service's
 * sentence for what `complaints_rejection_reason_check` would otherwise answer with a constraint
 * violation, the same division `assertTimesMatchType` makes with `posts_time_order_check`.
 */
function rejectionReasonFor(
	to: ComplaintStatus,
	rejectionReason: string | null | undefined
): string | null {
	const reason = trimmedOrNull(rejectionReason);

	if (to === COMPLAINT_STATUS.rejected) {
		if (!reason) {
			throw new ComplaintRuleError(
				COMPLAINT_RULE.rejectionNeedsReason,
				'Rejecting a complaint needs a reason the reporter can read.'
			);
		}
		return reason;
	}

	if (reason) {
		throw new ComplaintRuleError(
			COMPLAINT_RULE.reasonWithoutRejection,
			`A move to "${to}" carries no rejection reason.`
		);
	}
	return null;
}

/** Refuses any visibility change other than `public` becoming `private`. */
function assertVisibilityLowering(from: ComplaintVisibility, to: ComplaintVisibility): void {
	if (from === COMPLAINT_VISIBILITY.public && to === COMPLAINT_VISIBILITY.private) {
		return;
	}
	throw new ComplaintRuleError(
		COMPLAINT_RULE.visibilityOnlyLowers,
		`A complaint's visibility only moves from "${COMPLAINT_VISIBILITY.public}" to "${COMPLAINT_VISIBILITY.private}", not from "${from}" to "${to}".`
	);
}

/** A complaint with its age worked out, which is how every function here answers. */
function withAge(clock: Clock, row: Complaint): ComplaintWithAge {
	return {
		...row,
		ageMilliseconds: complaintAge(clock, row.statusChangedAt),
		stale: isComplaintStale(clock, row)
	};
}

/** `value` trimmed, or `null` when it was missing or all whitespace. */
function trimmedOrNull(value: string | null | undefined): string | null {
	return value?.trim() || null;
}
