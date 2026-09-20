import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { residents } from './resident';

/**
 * `posts`: the announcement board. One row is one publication — a Post — of either type: `event`
 * (kegiatan), which has a time and a place, or `announcement` (pengumuman), which does not.
 *
 * Decisions settled here:
 *
 * - **One table for both types, not two.** `docs/spec-konten-v1.md` settles this outright: the two
 *   types share eight of eleven columns, and two tables would mean two list screens, two edit
 *   screens, and the same bug fixed twice. `type` is the discriminator, and `startsAt`, `endsAt`
 *   and `location` are the three columns only an `event` row fills in.
 * - **Which columns an `announcement` may not fill in is a service-layer rule, not a database
 *   one.** The spec says so explicitly ("Batasan bahwa `pengumuman` tidak boleh punya waktu
 *   kegiatan dipaksakan di lapisan service"), and the ticket's testing decisions list it as a
 *   service-layer table of cases, not a database constraint. A database-level rule tying
 *   `startsAt`'s nullability to `type` would need a constraint that reads another column to decide
 *   whether a third may be null, which PostgreSQL can express but which duplicates a rule the
 *   service already has to enforce anyway (an `event` also needs a non-null `startsAt` before it
 *   may be published, which is a status transition, not an insert-time shape).
 * - **`type` is text with a check constraint, not a PostgreSQL enum**, the same choice
 *   `occupancies.role` and `email_queue.status` make: a check constraint is one plain migration
 *   away from changing, while an enum value can never be removed.
 * - **`status` is text with a check constraint, for the same reason.** Three values — `draft`,
 *   `published`, `archived` — and only `published` is ever shown on the public board; that
 *   filtering is service-layer, per the spec's "Halaman publik punya dua wajah."
 * - **`category` has no check constraint and no list in TypeScript here.** This is the same choice
 *   `email_queue.kind` and `subscriptions.kind` make and for the same reason: the acceptance
 *   criteria for this ticket asks for an index that supports filtering by category, not for the
 *   database to police which categories exist. The spec's five categories (posyandu, kerja bakti,
 *   perayaan, rapat, umum) are an admin-facing choice list, not a closed set the schema owns — a
 *   check constraint here would mean a migration every time that list changes, which is exactly the
 *   cost `email_queue.kind`'s doc comment already argues against. The registry that knows which
 *   categories really exist is given to the service layer that #39 builds, not to this table.
 * - **`bodyHtml` stores sanitized HTML, not Markdown and not what the author typed verbatim.**
 *   `docs/spec-post-editor-v1.md` replaces the Markdown body with the HTML a rich-text editor
 *   produces, and `src/lib/server/services/post/sanitize.ts` filters it against a whitelist twice:
 *   once by the service before this column is written, so nothing dangerous is ever stored, and
 *   again when a page renders the column, so a later narrowing of the whitelist reaches rows that
 *   were written before it. Neither pass is optional; see that module's doc comment.
 * - **`coverImageKey` is nullable text, no foreign key.** It is a `FileStore` key (see
 *   `src/lib/server/ports/file-store.ts`), a caller-chosen string rather than a row this table could
 *   reference, and a post may exist — as a fresh draft — before an admin has uploaded a cover image.
 * - **`publishedAt` is nullable and has no database default.** It is null for a draft and for an
 *   archived post that was never published, and is written by the service the moment it publishes,
 *   using the injected `Clock` — the same rule `createdAt` follows on every table in this schema, so
 *   that a test can decide what time either instant is.
 * - **`startsAt` and `endsAt` are `timestamp` with `withTimezone: true`, not `date`.** Unlike
 *   `occupancies.startedOn`, a kegiatan's start is a moment with a time of day — "posyandu jam
 *   9 pagi" — not a calendar day, so it needs the resolution and the time zone a plain `date` would
 *   throw away.
 * - **`posts_time_order_check` refuses an `endsAt` earlier than `startsAt`, whenever both are
 *   present.** This is the one rule the acceptance criteria puts on the database rather than the
 *   service: "Basis data menolak waktu selesai yang lebih awal dari waktu mulai." Both sides may be
 *   null — an `announcement` row leaves both null, and a fresh `event` draft may have neither yet —
 *   so the constraint only fires once there is an actual pair to compare, the same shape as
 *   `occupancies_date_order_check`.
 * - **`authorId` references `residents.id`, with no `onDelete`.** A Post is attributed history —
 *   the acceptance criteria for #16 and #12 already settled that a resident who authored something
 *   is not the kind of row this application deletes out from under its own record — so the default
 *   `no action` applies, the same choice `occupancies.residentId` and `invitations.createdBy` make
 *   for the same reason: nothing here may quietly erase who wrote a publication that has already
 *   reached the public board.
 * - **Four single-column indexes, not one composite.** The acceptance criteria asks for filtering
 *   by status, by type and by category, and for sorting by `startsAt`, as independent operations —
 *   an admin screen might filter by type alone, the public board by status and category together,
 *   a "kegiatan mendatang" screen by status and `startsAt` order. A fixed composite index only helps
 *   the one column order it was built with; four single-column btree indexes let PostgreSQL combine
 *   whichever pair a given query actually filters on through a bitmap AND, and cost one row each to
 *   maintain rather than committing this early to one guessed access pattern.
 */

/**
 * The two kinds of publication on the announcement board.
 *
 * - `event`: has a time and a place — a kegiatan.
 * - `announcement`: does not — a pengumuman.
 */
export const POST_TYPE = {
	event: 'event',
	announcement: 'announcement'
} as const;

/** The type of one Post. */
export type PostType = (typeof POST_TYPE)[keyof typeof POST_TYPE];

/** Every Post type there is, for a test — or a screen — that wants to walk them. */
export const POST_TYPES: readonly PostType[] = Object.values(POST_TYPE);

/** The SQL list of types, built from the one object above so the two cannot drift apart. */
const TYPE_LIST = POST_TYPES.map((type) => `'${type}'`).join(', ');

/**
 * What can be true of a Post.
 *
 * - `draft`: being written. Visible only to its author and other admins.
 * - `published`: visible on the public board.
 * - `archived`: no longer current, hidden from the public board, not deleted.
 */
export const POST_STATUS = {
	draft: 'draft',
	published: 'published',
	archived: 'archived'
} as const;

/** The status of one Post. */
export type PostStatus = (typeof POST_STATUS)[keyof typeof POST_STATUS];

/** Every Post status there is, for a test — or a screen — that wants to walk them. */
export const POST_STATUSES: readonly PostStatus[] = Object.values(POST_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = POST_STATUSES.map((status) => `'${status}'`).join(', ');

export const posts = pgTable(
	'posts',
	{
		id: uuid().primaryKey().defaultRandom(),
		type: text().$type<PostType>().notNull(),
		title: text().notNull(),
		summary: text().notNull(),
		/** The body as sanitized HTML. Sanitized again when a post is displayed. */
		bodyHtml: text().notNull(),
		/** The `FileStore` key of the cover image, or null while none has been uploaded. */
		coverImageKey: text(),
		/** An admin-facing choice, not a closed set the database enforces. See the doc comment. */
		category: text().notNull(),
		status: text().$type<PostStatus>().notNull(),
		/** Who wrote it. */
		authorId: uuid()
			.notNull()
			.references(() => residents.id),
		/** When it was published. Null until then. */
		publishedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		/** When the kegiatan starts. Null for an `announcement`, or for an `event` still being drafted. */
		startsAt: timestamp({ withTimezone: true }),
		/** When the kegiatan ends. Null for an `announcement`, or when only the start is known yet. */
		endsAt: timestamp({ withTimezone: true }),
		/** Where the kegiatan happens. Null for an `announcement`. */
		location: text()
	},
	(table) => [
		index('posts_status_idx').on(table.status),
		index('posts_type_idx').on(table.type),
		index('posts_category_idx').on(table.category),
		index('posts_starts_at_idx').on(table.startsAt),
		check('posts_type_check', sql.raw(`type in (${TYPE_LIST})`)),
		check('posts_status_check', sql.raw(`status in (${STATUS_LIST})`)),
		check(
			'posts_time_order_check',
			sql`starts_at is null or ends_at is null or ends_at >= starts_at`
		)
	]
);

/** One row of `posts`: one publication on the announcement board. */
export type Post = typeof posts.$inferSelect;

/** A row on its way into `posts`. */
export type NewPost = typeof posts.$inferInsert;
