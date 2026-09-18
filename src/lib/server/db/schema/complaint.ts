import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { residents } from './resident';

/**
 * `complaints`: one report from a Warga about something that needs the pengurus's attention — a
 * dead streetlight, a blocked drain. This is the table `docs/spec-keluhan-v1.md` is written
 * around; the other three tables in this file (`complaint_attachments`,
 * `complaint_status_changes`, `complaint_replies`) all name a row here.
 *
 * Decisions settled here:
 *
 * - **`status` and `visibility` are text with check constraints, not PostgreSQL enums**, the same
 *   choice `registrations.status`, `occupancies.role` and `posts.status`/`posts.type` make: a
 *   check constraint is one plain migration away from changing, while an enum value can never be
 *   removed. The six status values and two visibility values are the ones the orchestrator's
 *   glossary correction fixed in `CONTEXT.md`, not a choice made here.
 * - **`category` has no check constraint and no list in TypeScript here.** Same choice as
 *   `posts.category`, `email_queue.kind` and `subscriptions.kind`, and for the same reason: the
 *   acceptance criteria asks for an index that supports filtering by category, not for the
 *   database to police which categories exist. Nothing in this ticket's surface builds the
 *   registry that would own a closed list.
 * - **Allowed status transitions, the requirement that `rejected` needs a reason typed by hand, and
 *   who may call `ditarik` are all service-layer rules**, per `docs/spec-keluhan-v1.md`'s own
 *   "Implementation decisions" section. This table stores the values; it does not police the
 *   state machine.
 * - **`complaints_rejection_reason_check` ties the reason to the decision**, the same shape
 *   `registrations_rejection_reason_check` uses: a reason on a row that is not `rejected` would be
 *   a sentence nobody wrote about a rejection that never happened. It does not require a rejected
 *   row to carry a reason — the spec puts that requirement at the service layer, not here — it
 *   only forbids the combination that can never be correct.
 * - **`reporterId` references `residents.id`, with no `onDelete`.** A complaint is attributed
 *   history, the same reasoning `posts.authorId` and `occupancies.residentId` already settled:
 *   nothing here may quietly erase who reported something once it has entered the pengurus's
 *   queue.
 * - **`statusChangedAt` is a plain column here, not derived from `complaint_status_changes`.** The
 *   acceptance criteria asks for an index that sorts by it directly, and the admin queue's whole
 *   point is that sort; making every list query join out to the history table to find the newest
 *   row per complaint would cost a query the column avoids for the price of one write already
 *   happening at every status change. It starts equal to `createdAt` — a fresh complaint has not
 *   changed status yet — and the service layer that moves a complaint between statuses is what
 *   keeps it in step with `complaint_status_changes`.
 * - **Three single-column indexes, not one composite.** Same reasoning as `posts`'s four indexes:
 *   the acceptance criteria asks for sorting by `statusChangedAt` and filtering by `status` and by
 *   `category` as independent operations, and single-column btree indexes let PostgreSQL combine
 *   whichever pair a given query actually filters on through a bitmap AND, rather than committing
 *   this ticket to one guessed column order.
 * - **No `updatedAt`.** `createdAt` never changes and `statusChangedAt` already answers "when did
 *   this last move"; a third timestamp would just be a second, looser answer to the same question.
 */

/**
 * What can be true of a Keluhan's status. Set by the orchestrator's glossary correction on ticket
 * #42, not chosen here — see the "Nama di kode" table in `CONTEXT.md`.
 *
 * - `new`: just reported, nobody has looked at it yet.
 * - `reviewing`: a pengurus is looking at it.
 * - `working`: being worked on.
 * - `resolved`: done.
 * - `rejected`: turned down. `rejectionReason` says why.
 * - `withdrawn`: the reporter pulled it back. Service-layer rule: only while still `new`.
 */
export const COMPLAINT_STATUS = {
	new: 'new',
	reviewing: 'reviewing',
	working: 'working',
	resolved: 'resolved',
	rejected: 'rejected',
	withdrawn: 'withdrawn'
} as const;

/** The status of one Keluhan. */
export type ComplaintStatus = (typeof COMPLAINT_STATUS)[keyof typeof COMPLAINT_STATUS];

/** Every Keluhan status there is, for a test — or a screen — that wants to walk them. */
export const COMPLAINT_STATUSES: readonly ComplaintStatus[] = Object.values(COMPLAINT_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = COMPLAINT_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * Who may see a Keluhan. Set by the orchestrator's glossary correction on ticket #42.
 *
 * - `private`: only the reporter and the pengurus. The default the spec asks for.
 * - `public`: every signed-in Warga. Never signed-out. Service-layer rule: a complaint may move
 *   from `public` to `private`, never the other way.
 */
export const COMPLAINT_VISIBILITY = {
	private: 'private',
	public: 'public'
} as const;

/** The visibility of one Keluhan. */
export type ComplaintVisibility = (typeof COMPLAINT_VISIBILITY)[keyof typeof COMPLAINT_VISIBILITY];

/** Every visibility value there is, for a test — or a screen — that wants to walk them. */
export const COMPLAINT_VISIBILITIES: readonly ComplaintVisibility[] =
	Object.values(COMPLAINT_VISIBILITY);

/** The SQL list of visibility values, built from the one object above so the two cannot drift apart. */
const VISIBILITY_LIST = COMPLAINT_VISIBILITIES.map((visibility) => `'${visibility}'`).join(', ');

export const complaints = pgTable(
	'complaints',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The Warga who reported it. */
		reporterId: uuid()
			.notNull()
			.references(() => residents.id),
		title: text().notNull(),
		/** An admin-facing choice, not a closed set the database enforces. See the doc comment. */
		category: text().notNull(),
		description: text().notNull(),
		status: text().$type<ComplaintStatus>().notNull(),
		visibility: text().$type<ComplaintVisibility>().notNull(),
		/** Why the complaint was rejected. Null unless it was. */
		rejectionReason: text(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		/** When `status` last changed. Equal to `createdAt` until the first status change. */
		statusChangedAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// The admin queue's read: everything still open, filtered by status and category,
		// sorted by how long it has been waiting.
		index('complaints_status_idx').on(table.status),
		index('complaints_category_idx').on(table.category),
		index('complaints_status_changed_at_idx').on(table.statusChangedAt),
		check('complaints_status_check', sql.raw(`status in (${STATUS_LIST})`)),
		check('complaints_visibility_check', sql.raw(`visibility in (${VISIBILITY_LIST})`)),
		check(
			'complaints_rejection_reason_check',
			sql.raw(`rejection_reason is null or status = '${COMPLAINT_STATUS.rejected}'`)
		)
	]
);

/** One row of `complaints`: one Keluhan. */
export type Complaint = typeof complaints.$inferSelect;

/** A row on its way into `complaints`. */
export type NewComplaint = typeof complaints.$inferInsert;

/**
 * `complaint_attachments`: the image files attached to one Keluhan. One row per file.
 *
 * Decisions settled here:
 *
 * - **The "at most three per complaint" rule is not a database constraint.** The ticket says so
 *   outright: it belongs to the service layer #43 and #44 build, because counting existing rows
 *   before allowing an insert is exactly the kind of check-then-act a unique index cannot express
 *   and a plain `count(*) <= 3` constraint cannot either, PostgreSQL `CHECK` constraints being
 *   unable to see other rows. This table only provides the shape that limit is enforced against.
 * - **`fileKey` is a `FileStore` key (see `src/lib/server/ports/file-store.ts`), the same choice
 *   `posts.coverImageKey` makes**, opened only through a short-lived signed link per the spec's
 *   "foto keluhan sering memuat rumah tetangga dan pelat nomor kendaraan" — nothing here stores a
 *   public URL.
 * - **`onDelete: 'cascade'` from `complaints`, unlike the foreign keys naming a person elsewhere in
 *   this schema.** An attachment has no meaning of its own once its complaint is gone; unlike
 *   `posts.authorId` or `occupancies.residentId`, which point at a person whose history must
 *   outlive the row that names them, this points at the one complaint the attachment exists to
 *   illustrate. In practice a complaint is never deleted — only its status changes — so this never
 *   fires; it is here so the constraint says what is actually true rather than a default nobody
 *   picked.
 */
export const complaintAttachments = pgTable(
	'complaint_attachments',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The Keluhan this file belongs to. */
		complaintId: uuid()
			.notNull()
			.references(() => complaints.id, { onDelete: 'cascade' }),
		/** The `FileStore` key of the attached image. */
		fileKey: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// A complaint's attachments, and what an "at most three" service-layer check counts.
		index('complaint_attachments_complaint_id_idx').on(table.complaintId)
	]
);

/** One row of `complaint_attachments`: one attached image. */
export type ComplaintAttachment = typeof complaintAttachments.$inferSelect;

/** A row on its way into `complaint_attachments`. */
export type NewComplaintAttachment = typeof complaintAttachments.$inferInsert;

/**
 * `complaint_status_changes`: the Riwayat Status of one Keluhan — one row per transition, not just
 * the latest status. `docs/spec-keluhan-v1.md`'s "Implementation decisions" section is explicit
 * about why: "pertanyaan yang benar-benar ditanyakan di rapat warga adalah 'berapa lama ini
 * menggantung', dan itu tidak bisa dijawab oleh kolom status terakhir."
 *
 * Decisions settled here:
 *
 * - **`oldStatus` is `notNull`, unlike a typical "previous value" column.** A row here records a
 *   transition, not the creation of the complaint — a fresh complaint starts at `new` with no
 *   earlier status to record, so it gets no row here, only `complaints.createdAt` and
 *   `complaints.statusChangedAt`. Every row that exists in this table names both sides of an
 *   actual move.
 * - **`oldStatus` and `newStatus` both carry the same check constraint as `complaints.status`.**
 *   The acceptance criteria's "status dibatasi pada enam nilai" is a rule about what a status
 *   value is, not about which column happens to hold it, and these two columns hold the same
 *   domain value `complaints.status` does.
 * - **`actorId` references `residents.id`, with no `onDelete`, the same reasoning as
 *   `complaints.reporterId`.** Who moved a complaint from `reviewing` to `working` is exactly the
 *   fact user story 19 ("saya ingin melihat siapa mengubah status apa dan kapan") depends on, so
 *   the row must keep meaning something even if that account is ever removed.
 * - **`onDelete: 'cascade'` from `complaints`**, the same reasoning as `complaint_attachments`:
 *   this row has no meaning without the complaint it is the history of.
 * - **`note` is nullable.** Not every transition carries one; `complaints.rejectionReason` already
 *   carries the mandatory reason for a rejection, so this column is free-text colour, not a second
 *   place that reason could live.
 */
export const complaintStatusChanges = pgTable(
	'complaint_status_changes',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The Keluhan that changed status. */
		complaintId: uuid()
			.notNull()
			.references(() => complaints.id, { onDelete: 'cascade' }),
		oldStatus: text().$type<ComplaintStatus>().notNull(),
		newStatus: text().$type<ComplaintStatus>().notNull(),
		/** Who made the change. */
		actorId: uuid()
			.notNull()
			.references(() => residents.id),
		/** Free-text colour on the transition. Not where a rejection's mandatory reason lives. */
		note: text(),
		occurredAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// A complaint's status history, oldest first by primary read pattern (the detail screen).
		index('complaint_status_changes_complaint_id_idx').on(table.complaintId),
		check('complaint_status_changes_old_status_check', sql.raw(`old_status in (${STATUS_LIST})`)),
		check('complaint_status_changes_new_status_check', sql.raw(`new_status in (${STATUS_LIST})`))
	]
);

/** One row of `complaint_status_changes`: one status transition. */
export type ComplaintStatusChange = typeof complaintStatusChanges.$inferSelect;

/** A row on its way into `complaint_status_changes`. */
export type NewComplaintStatusChange = typeof complaintStatusChanges.$inferInsert;

/**
 * `complaint_replies`: the Tanggapan on one Keluhan, from either the reporter or a pengurus.
 * `docs/spec-keluhan-v1.md` calls this "rangkaian pesan sederhana": no nested replies, no editing.
 *
 * Decisions settled here:
 *
 * - **One table, no `isFromAdmin` flag.** `authorId` already names who wrote it, and the role that
 *   account holds is a lookup at read time, the same division `posts.authorId` makes — this table
 *   does not need to know whether its author currently holds the admin role.
 * - **`authorId` references `residents.id`, with no `onDelete`**, the same reasoning as
 *   `complaints.reporterId`: a reply is attributed history and must keep meaning something even if
 *   the account that wrote it is ever removed.
 * - **`onDelete: 'cascade'` from `complaints`**, the same reasoning as the two tables above: a
 *   reply has no meaning without the complaint it replies to.
 * - **No `editedAt` and no soft-delete flag.** The spec's "tidak ada penyuntingan" is enforced by
 *   there being no update path in the service layer this ticket does not build, not by a column
 *   here recording that one was used.
 */
export const complaintReplies = pgTable(
	'complaint_replies',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The Keluhan this message is about. */
		complaintId: uuid()
			.notNull()
			.references(() => complaints.id, { onDelete: 'cascade' }),
		/** Who wrote it — the reporter or a pengurus. */
		authorId: uuid()
			.notNull()
			.references(() => residents.id),
		content: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// A complaint's replies, in the order the detail screen reads them.
		index('complaint_replies_complaint_id_idx').on(table.complaintId)
	]
);

/** One row of `complaint_replies`: one Tanggapan. */
export type ComplaintReply = typeof complaintReplies.$inferSelect;

/** A row on its way into `complaint_replies`. */
export type NewComplaintReply = typeof complaintReplies.$inferInsert;
