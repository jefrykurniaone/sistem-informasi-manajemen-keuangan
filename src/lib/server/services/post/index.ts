import { and, count, desc, eq } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import {
	posts,
	POST_STATUS,
	POST_TYPE,
	type Post,
	type PostStatus,
	type PostType
} from '../../db/schema/post';
import { residents } from '../../db/schema/resident';
import type { Clock } from '../../ports/clock';
import type { FileStore } from '../../ports/file-store';
import { renderPostBody } from './markdown';

/**
 * The announcement board's write side: an admin writing a kegiatan or a pengumuman, saving it as a
 * draft, previewing it, publishing it, editing it afterwards, and archiving it — `spec-konten-v1.md`
 * user stories 1 through 10.
 *
 * ## What this module owns and what it deliberately does not
 *
 * - **There is no `deletePost`, and there must never be one.** Story 10 asks to archive a
 *   publication "tanpa menghapusnya", and `archived` is the state that means it. The same rule the
 *   Unit service states about `deleteUnit`.
 * - **The public reading surface is not here.** `docs/spec-konten-v1.md`'s "Halaman publik punya dua
 *   wajah" filtering, the upcoming-events ordering and the category filter belong to the ticket that
 *   builds the public board (#40). What that ticket needs from this one is `renderPostBody` in
 *   `./markdown.ts`, which is the security boundary and is exported for exactly that reason.
 * - **The database owns three rules and this module owns the rest.** `posts_type_check`,
 *   `posts_status_check` and `posts_time_order_check` are in `src/lib/server/db/schema/post.ts`.
 *   Everything below — an `announcement` may not carry event times, an `event` needs a start time,
 *   which status may become which, and which categories exist — was deliberately left out of the
 *   schema for this layer to enforce; see that file's doc comment for why.
 *
 * ## The category registry
 *
 * `posts.category` is free text with an index and no check constraint, and the schema's doc comment
 * hands the registry of real categories to this module. `POST_CATEGORIES` is that registry, and it
 * follows the shape `src/lib/server/services/subscription/kinds.ts` already settled for
 * `subscriptions.kind`: kebab-case string values, listed in one place, validated by the service so
 * that changing the list costs no migration.
 *
 * The five values are the Indonesian civic terms `docs/spec-konten-v1.md` names — posyandu, kerja
 * bakti, perayaan, rapat, umum. They stay Indonesian because they are *data*, the way
 * `'invoice-issued'` is data, and because "posyandu" and "kerja bakti" name institutions of
 * Indonesian neighbourhood life that have no English name to translate them into; inventing one
 * would be inventing a concept `CONTEXT.md` does not have. Every identifier in this file is
 * English, and the label a person reads comes from `messages/*.json`, not from the value.
 *
 * ## Permission
 *
 * One action, `ACTION.managePosts`, covering the admin list, the write operations and the preview —
 * the same "the list is only useful to whoever may act on it" reasoning `ACTION.manageUnits` records.
 * It is granted to `admin` and to nobody else; `src/lib/server/authz.ts` holds the decision and the
 * argument for it. Every function here takes the caller and starts with `requirePermission`, so the
 * acceptance criterion that a `resident` cannot call a single write operation on a Post is decided
 * in one place rather than function by function.
 */

/** The audit log's `action` for a Post that was written for the first time. */
export const POST_CREATED_ACTION = 'post_created';
/** The audit log's `action` for a Post whose content was edited. */
export const POST_UPDATED_ACTION = 'post_updated';
/** The audit log's `action` for a Post that reached the public board. */
export const POST_PUBLISHED_ACTION = 'post_published';
/** The audit log's `action` for a Post that was taken off the public board. */
export const POST_ARCHIVED_ACTION = 'post_archived';
/** The audit log's `action` for a Post whose cover image was uploaded or replaced. */
export const POST_COVER_IMAGE_SET_ACTION = 'post_cover_image_set';

/** The default page size for the admin Post list. */
export const DEFAULT_POST_PAGE_SIZE = 20;

/**
 * Every category an admin may file a Post under, in the order the write screen offers them.
 *
 * Values, not identifiers: see this module's doc comment for why they are the Indonesian civic
 * terms and where the label a person reads comes from.
 */
export const POST_CATEGORIES = ['posyandu', 'kerja-bakti', 'perayaan', 'rapat', 'umum'] as const;

/** One of the categories above. */
export type PostCategory = (typeof POST_CATEGORIES)[number];

/** Whether `value` is a category this application knows about. */
export function isPostCategory(value: string): value is PostCategory {
	return (POST_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Which status a Post may move to from the one it has.
 *
 * The three legal moves are `draft` to `published`, `published` to `archived`, and `archived` back
 * to `published`; every other pair is refused. Two absences are deliberate. A `draft` cannot be
 * archived, because a draft nobody has seen is abandoned by leaving it alone, and an `archived`
 * row would claim it was once current. Nothing can go back to `draft`, because `published` means it
 * has already been on the public board and possibly shared into a WhatsApp group — un-publishing it
 * is what `archived` is for, and pretending it was never written is a claim this application cannot
 * make true.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
	[POST_STATUS.draft]: [POST_STATUS.published],
	[POST_STATUS.published]: [POST_STATUS.archived],
	[POST_STATUS.archived]: [POST_STATUS.published]
};

/** Whether a Post may move from `from` to `to`. Decided purely from the table above. */
export function isAllowedPostTransition(from: PostStatus, to: PostStatus): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The largest cover image this application accepts: 256 KiB.
 *
 * The number is set by the request body limit, not by taste. `@sveltejs/adapter-node` refuses a
 * request body larger than `BODY_SIZE_LIMIT`, which defaults to 512 K and is not configured
 * anywhere in this repository. A limit larger than that would be a limit this service never gets to
 * apply: `vite dev` has no such ceiling, so an oversized upload would be accepted while developing
 * and answered with a bare 413 in production, which is the worst of both. 256 KiB leaves room for
 * the multipart envelope and is comfortably enough for what a cover image is for — a share card at
 * roughly 1200 pixels wide is well under it.
 *
 * Raising it means raising both: `BODY_SIZE_LIMIT` in the deployment environment *and* this
 * constant. This ticket can only reach the second one — `.env.example` and the adapter options in
 * `vite.config.ts` are outside its surface — so it sets the one that is safe on its own.
 */
export const MAXIMUM_COVER_IMAGE_BYTES = 256 * 1024;

/**
 * The image formats a cover image may be in, and the file extension each one is stored under.
 *
 * The extension is taken from here rather than from the uploaded file's name on purpose: the name
 * arrives from a browser form and becomes part of a storage key, and a key is a path.
 */
const COVER_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp'
};

/**
 * The first bytes each accepted format really starts with.
 *
 * The content type on an upload is whatever the browser — or whoever is talking to this application
 * instead of a browser — chose to send, so it is a claim, not a fact. A cover image is served from
 * a page that is open without an account, and a file that is not an image but says it is one is
 * exactly the shape of an upload that becomes a script when something downstream sniffs its content
 * rather than believing its type. `WEBP` is checked at offset 8, after the `RIFF` container header
 * and the four-byte length that follows it.
 */
const COVER_IMAGE_SIGNATURES: Readonly<
	Record<string, readonly { readonly offset: number; readonly bytes: readonly number[] }[]>
> = {
	'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
	'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
	'image/webp': [
		{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
		{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }
	]
};

/** Every content type a cover image may be uploaded as, for a screen that builds an `accept` list. */
export const COVER_IMAGE_CONTENT_TYPES: readonly string[] = Object.keys(COVER_IMAGE_EXTENSIONS);

/**
 * Every rule this service refuses a request for, other than permission.
 *
 * These are named refusals of a specific change, not of the caller: the actor was inside their
 * rights and the request itself is what is wrong, so a route answers them with `fail(400, …)`
 * rather than a 403 — the same split `LastSuperuserError` records in `src/lib/errors.ts`.
 */
export const POST_RULE = {
	/** A `pengumuman` was given a start time, an end time or a place. */
	announcementHasEventTimes: 'announcementHasEventTimes',
	/** A `kegiatan` was saved without a start time. */
	eventNeedsStartTime: 'eventNeedsStartTime',
	/** A `kegiatan`'s end time is earlier than its start time. */
	endsBeforeStart: 'endsBeforeStart',
	/** The category named is not one `POST_CATEGORIES` knows. */
	unknownCategory: 'unknownCategory',
	/** The signed-in admin has no `residents` row, so there is nobody to attribute the Post to. */
	authorNotRegistered: 'authorNotRegistered',
	/** The uploaded cover image is not one of the accepted image formats. */
	coverImageNotAnImage: 'coverImageNotAnImage',
	/** The uploaded cover image is larger than `MAXIMUM_COVER_IMAGE_BYTES`. */
	coverImageTooLarge: 'coverImageTooLarge'
} as const;

/** One of the rules above. */
export type PostRule = (typeof POST_RULE)[keyof typeof POST_RULE];

/**
 * Thrown when a request breaks one of the rules in `POST_RULE`.
 *
 * One class carrying a `rule` rather than one class per rule: a route catches this once and picks
 * the sentence a person reads from `rule`, and a later rule costs an entry in `POST_RULE` and a
 * message instead of a new `catch` arm at every call site. Declared here rather than in
 * `src/lib/errors.ts` for the same reason `UnitConflictError` is declared in the Unit service — a
 * named error belonging to one service module lives in that module.
 */
export class PostRuleError extends Error {
	override readonly name = 'PostRuleError';

	/** Which rule refused the request. */
	readonly rule: PostRule;

	constructor(rule: PostRule, detail: string) {
		super(`A Post request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/**
 * Thrown when a status change is not one of the three `ALLOWED_TRANSITIONS` permits.
 *
 * Separate from `PostRuleError` because it carries a different pair of values — where the Post is
 * and where it was asked to go — and because a route showing "this cannot go from published back to
 * draft" wants both of them, not a rule name.
 */
export class PostTransitionError extends Error {
	override readonly name = 'PostTransitionError';

	/** The status the Post is in. */
	readonly from: PostStatus;
	/** The status it was asked to move to. */
	readonly to: PostStatus;

	constructor(from: PostStatus, to: PostStatus) {
		super(`A Post cannot move from "${from}" to "${to}".`);
		this.from = from;
		this.to = to;
	}
}

/**
 * Thrown when `postId` names no row. A caller only reaches this with an id the admin screen never
 * linked to, because the id is read straight from the URL, so it is a 404 rather than a rejected
 * form — the same reasoning `UnitNotFoundError` records.
 */
export class PostNotFoundError extends Error {
	override readonly name = 'PostNotFoundError';

	/** The id that named no Post. */
	readonly postId: string;

	constructor(postId: string) {
		super(`No post exists with id "${postId}".`);
		this.postId = postId;
	}
}

/** A Post together with the name of whoever wrote it — story 18's "siapa penulisnya". */
export interface PostWithAuthor extends Post {
	readonly authorName: string;
}

/** What an admin typed into the write screen, before it has been checked or trimmed. */
export interface PostContent {
	readonly type: PostType;
	readonly title: string;
	readonly summary: string;
	/** The author's Markdown, stored exactly as typed and sanitized only when it is displayed. */
	readonly bodyMarkdown: string;
	/** One of `POST_CATEGORIES`. */
	readonly category: string;
	/** When the kegiatan starts. `null` for a pengumuman. */
	readonly startsAt: Date | null;
	/** When the kegiatan ends. `null` for a pengumuman, or when only the start is known. */
	readonly endsAt: Date | null;
	/** Where the kegiatan happens. `null` for a pengumuman. */
	readonly location: string | null;
}

/**
 * Refuses anyone who may not reach the Post write screens, and answers nothing otherwise.
 *
 * It exists for the "tulis terbitan" screen, which loads a blank form and so has no data to fetch
 * that a permission check could come attached to. Without this, that screen would either call the
 * guard in `src/lib/server/authz.ts` from the route — putting a permission decision somewhere other
 * than the service layer, which `spec-fondasi-v1.md` asks it not to — or render an empty form to a
 * resident and only refuse them once they pressed save.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 */
export async function assertMayManagePosts(db: Database, actorId: string): Promise<void> {
	await requirePermission(db, actorId, ACTION.managePosts);
}

/** What the admin Post list screen asks for. */
export interface ListPostsRequest {
	/** The user asking. Checked against `ACTION.managePosts` before anything else. */
	readonly actorId: string;
	/** 1-based. Defaults to `1`. */
	readonly page?: number;
	/** Defaults to `DEFAULT_POST_PAGE_SIZE`. */
	readonly pageSize?: number;
	/** Only this status. Missing means every status, which is what an admin list is for. */
	readonly status?: PostStatus;
	/** Only this type. Missing means both. */
	readonly type?: PostType;
	/** Only this category. Missing means every category. */
	readonly category?: string;
}

/** One page of the admin Post list. */
export interface PostListResult {
	readonly posts: readonly PostWithAuthor[];
	readonly page: number;
	readonly pageSize: number;
	readonly totalCount: number;
}

/**
 * One page of every Post there is, newest first, whatever its status — this is the admin list, and
 * the drafts are the point of it.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 */
export async function listPosts(db: Database, request: ListPostsRequest): Promise<PostListResult> {
	await requirePermission(db, request.actorId, ACTION.managePosts);

	const page = normalizePage(request.page);
	const pageSize = normalizePageSize(request.pageSize);
	const filter = postFilter(request);

	const rows = await db
		.select({ post: posts, authorName: user.name })
		.from(posts)
		.innerJoin(residents, eq(residents.id, posts.authorId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(filter)
		// `id` breaks the tie so that two Posts written in the same instant always come back in the
		// same order, which is what makes paging over them stable.
		.orderBy(desc(posts.createdAt), desc(posts.id))
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	const [totals] = await db.select({ value: count() }).from(posts).where(filter);

	return {
		posts: rows.map((row) => ({ ...row.post, authorName: row.authorName })),
		page,
		pageSize,
		totalCount: totals?.value ?? 0
	};
}

/**
 * The one Post named by `postId`, for the admin edit screen.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 * @throws {PostNotFoundError} when `postId` names no Post.
 */
export async function getPost(
	db: Database,
	actorId: string,
	postId: string
): Promise<PostWithAuthor> {
	await requirePermission(db, actorId, ACTION.managePosts);

	const [row] = await db
		.select({ post: posts, authorName: user.name })
		.from(posts)
		.innerJoin(residents, eq(residents.id, posts.authorId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(posts.id, postId))
		.limit(1);
	if (!row) {
		throw new PostNotFoundError(postId);
	}
	return { ...row.post, authorName: row.authorName };
}

/**
 * What the preview screen shows: the body exactly as a visitor would read it, rendered and
 * sanitized, without touching the row.
 *
 * Story 4 asks to see the result before publishing, and the acceptance criterion adds that the
 * preview must not change the status. It cannot: this function writes nothing at all. It still takes
 * a caller and checks permission, because rendering is what the public page will do with this Post
 * and there is no reason for anyone outside the admin screen to reach it.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 */
export async function previewPostBody(
	db: Database,
	actorId: string,
	bodyMarkdown: string
): Promise<string> {
	await requirePermission(db, actorId, ACTION.managePosts);
	return renderPostBody(bodyMarkdown);
}

/** Who is writing, and what they wrote. */
export interface CreatePostRequest extends PostContent {
	/** The signed-in admin. Checked against `ACTION.managePosts`, then resolved to a `residents` row. */
	readonly actorId: string;
}

/**
 * Writes a new Post. It always starts as a `draft`; publishing is a separate, audited step.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 * @throws {TypeError} when the title, the summary or the body is empty after trimming.
 * @throws {PostRuleError} for any of the shape rules in `POST_RULE`.
 */
export async function createPost(
	db: Database,
	clock: Clock,
	request: CreatePostRequest
): Promise<Post> {
	const content = validatePostContent(request);

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.managePosts);

		const authorId = await residentIdForUser(transaction, request.actorId);
		if (!authorId) {
			throw new PostRuleError(
				POST_RULE.authorNotRegistered,
				`User "${request.actorId}" has no residents row to attribute a Post to.`
			);
		}

		const [row] = await transaction
			.insert(posts)
			.values({
				...content,
				status: POST_STATUS.draft,
				authorId,
				publishedAt: null,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: POST_CREATED_ACTION,
			targetId: row.id,
			after: auditSnapshot(row)
		});

		return row;
	});
}

/** Who is editing, which Post, and what it should say now. */
export interface UpdatePostRequest extends PostContent {
	/** The signed-in admin. Checked against `ACTION.managePosts` before anything else. */
	readonly actorId: string;
	readonly postId: string;
}

/**
 * Replaces a Post's content, whatever its status. Story 9 asks for exactly this — a published
 * kegiatan whose hour changed is edited in place, not republished — so the status and `publishedAt`
 * are left alone here and only the two transition functions below ever move them.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 * @throws {TypeError} when the title, the summary or the body is empty after trimming.
 * @throws {PostRuleError} for any of the shape rules in `POST_RULE`.
 * @throws {PostNotFoundError} when `postId` names no Post.
 */
export async function updatePost(
	db: Database,
	clock: Clock,
	request: UpdatePostRequest
): Promise<Post> {
	const content = validatePostContent(request);

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.managePosts);

		const existing = await findPost(transaction, request.postId);

		const [row] = await transaction
			.update(posts)
			.set(content)
			.where(eq(posts.id, request.postId))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: POST_UPDATED_ACTION,
			targetId: row.id,
			before: auditSnapshot(existing),
			after: auditSnapshot(row)
		});

		return row;
	});
}

/** Who is moving a Post, and which one. */
export interface PostStatusChangeRequest {
	/** The signed-in admin. Checked against `ACTION.managePosts` before anything else. */
	readonly actorId: string;
	readonly postId: string;
}

/**
 * Puts a Post on the public board, from `draft` or from `archived`.
 *
 * `publishedAt` is stamped only the first time. Story 18 asks an admin to see *when* a publication
 * was published, and for one that was archived and brought back that answer is still the day it
 * first reached the board — restamping it would quietly rewrite the record every time somebody
 * un-archived something.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 * @throws {PostNotFoundError} when `postId` names no Post.
 * @throws {PostTransitionError} when the Post is already published.
 */
export async function publishPost(
	db: Database,
	clock: Clock,
	request: PostStatusChangeRequest
): Promise<Post> {
	return changePostStatus(db, clock, request, POST_STATUS.published, POST_PUBLISHED_ACTION);
}

/**
 * Takes a Post off the public board without deleting it — story 10.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 * @throws {PostNotFoundError} when `postId` names no Post.
 * @throws {PostTransitionError} when the Post is not published.
 */
export async function archivePost(
	db: Database,
	clock: Clock,
	request: PostStatusChangeRequest
): Promise<Post> {
	return changePostStatus(db, clock, request, POST_STATUS.archived, POST_ARCHIVED_ACTION);
}

/** Shared body of `publishPost` and `archivePost`: they differ only in target status and audit name. */
async function changePostStatus(
	db: Database,
	clock: Clock,
	request: PostStatusChangeRequest,
	to: PostStatus,
	action: string
): Promise<Post> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.managePosts);

		const existing = await findPost(transaction, request.postId);
		if (!isAllowedPostTransition(existing.status, to)) {
			throw new PostTransitionError(existing.status, to);
		}

		const [row] = await transaction
			.update(posts)
			.set({
				status: to,
				publishedAt:
					to === POST_STATUS.published
						? (existing.publishedAt ?? clock.now())
						: existing.publishedAt
			})
			.where(eq(posts.id, request.postId))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action,
			targetId: row.id,
			before: { status: existing.status, publishedAt: existing.publishedAt },
			after: { status: row.status, publishedAt: row.publishedAt }
		});

		return row;
	});
}

/** Who is uploading, onto which Post, and the file itself. */
export interface SetPostCoverImageRequest {
	/** The signed-in admin. Checked against `ACTION.managePosts` before anything else. */
	readonly actorId: string;
	readonly postId: string;
	/** What the upload claims the file is. Checked against the bytes, not believed. */
	readonly contentType: string;
	readonly content: Uint8Array;
}

/**
 * Stores a Post's cover image through the `FileStore` port and records its key on the row.
 *
 * The bytes go to the port and never to a path this module builds itself, and the key is derived
 * from the Post's own id and the format's extension — never from the uploaded file's name, which
 * arrives from a browser and would be a path fragment chosen by whoever sent it. Replacing a JPEG
 * with a PNG changes the key, so the file the old key pointed at is deleted rather than left behind.
 *
 * `FileStore.store` overwrites, so an upload retried after a timeout leaves one file, not two.
 *
 * @throws {PermissionDeniedError} when `actorId` may not manage Posts.
 * @throws {PostNotFoundError} when `postId` names no Post.
 * @throws {PostRuleError} `coverImageTooLarge` past `MAXIMUM_COVER_IMAGE_BYTES`, or
 *   `coverImageNotAnImage` when the content type is not an accepted one or the bytes do not start
 *   the way that format really starts.
 */
export async function setPostCoverImage(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	request: SetPostCoverImageRequest
): Promise<Post> {
	const key = coverImageKeyFor(request);

	const existing = await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.managePosts);
		return findPost(transaction, request.postId);
	});

	await fileStore.store(key, request.content);

	const updated = await db.transaction(async (transaction) => {
		const [row] = await transaction
			.update(posts)
			.set({ coverImageKey: key })
			.where(eq(posts.id, request.postId))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: POST_COVER_IMAGE_SET_ACTION,
			targetId: row.id,
			before: { coverImageKey: existing.coverImageKey },
			after: { coverImageKey: row.coverImageKey }
		});

		return row;
	});

	// Only once the row points at the new file: a delete that ran first would leave a Post whose
	// cover image key names a file that is already gone if the update then failed.
	if (existing.coverImageKey && existing.coverImageKey !== key) {
		await fileStore.delete(existing.coverImageKey);
	}

	return updated;
}

/** Checks an upload and works out the storage key it belongs at. */
function coverImageKeyFor(request: SetPostCoverImageRequest): string {
	if (request.content.byteLength > MAXIMUM_COVER_IMAGE_BYTES) {
		throw new PostRuleError(
			POST_RULE.coverImageTooLarge,
			`The uploaded cover image is ${request.content.byteLength} bytes; the limit is ${MAXIMUM_COVER_IMAGE_BYTES}.`
		);
	}

	const extension = COVER_IMAGE_EXTENSIONS[request.contentType];
	if (!extension) {
		throw new PostRuleError(
			POST_RULE.coverImageNotAnImage,
			`"${request.contentType}" is not one of ${COVER_IMAGE_CONTENT_TYPES.join(', ')}.`
		);
	}
	if (!hasSignatureOf(request.content, request.contentType)) {
		throw new PostRuleError(
			POST_RULE.coverImageNotAnImage,
			`The uploaded bytes do not start the way a "${request.contentType}" file starts.`
		);
	}

	return `posts/${request.postId}/cover.${extension}`;
}

/** Whether `content` really begins the way a file of `contentType` begins. */
function hasSignatureOf(content: Uint8Array, contentType: string): boolean {
	const signature = COVER_IMAGE_SIGNATURES[contentType] ?? [];
	return signature.every((part) =>
		part.bytes.every((byte, index) => content[part.offset + index] === byte)
	);
}

/**
 * Checks and trims what an admin typed.
 *
 * Empty required text is a `TypeError`, matching `createUnit`: a form that lets a field through
 * empty is a mistake in the screen, and the screen checks for it before it ever calls this. The
 * domain rules — which are refusals a correct screen can still run into — are `PostRuleError`.
 */
function validatePostContent(content: PostContent): PostContent {
	const title = content.title.trim();
	const summary = content.summary.trim();
	const bodyMarkdown = content.bodyMarkdown.trim();
	if (title === '' || summary === '' || bodyMarkdown === '') {
		throw new TypeError('A post needs a non-empty title, summary and body.');
	}

	if (!isPostCategory(content.category)) {
		throw new PostRuleError(
			POST_RULE.unknownCategory,
			`"${content.category}" is not one of ${POST_CATEGORIES.join(', ')}.`
		);
	}

	const location = content.location?.trim() || null;
	assertTimesMatchType(content, location);

	return {
		type: content.type,
		title,
		summary,
		bodyMarkdown,
		category: content.category,
		startsAt: content.startsAt,
		endsAt: content.endsAt,
		location
	};
}

/**
 * The three type rules `docs/spec-konten-v1.md` left out of the database for this layer: a
 * pengumuman carries no event times or place, a kegiatan has a start, and a kegiatan that has both
 * ends no earlier than it starts.
 *
 * The last one is also `posts_time_order_check` in the schema. Both are right: the database keeps
 * the row honest against anything that writes it, and this keeps the admin screen answering with a
 * sentence rather than with a constraint violation.
 */
function assertTimesMatchType(content: PostContent, location: string | null): void {
	if (content.type === POST_TYPE.announcement) {
		if (content.startsAt || content.endsAt || location) {
			throw new PostRuleError(
				POST_RULE.announcementHasEventTimes,
				'A pengumuman carries no start time, end time or place.'
			);
		}
		return;
	}

	if (!content.startsAt) {
		throw new PostRuleError(POST_RULE.eventNeedsStartTime, 'A kegiatan needs a start time.');
	}
	if (content.endsAt && content.endsAt.getTime() < content.startsAt.getTime()) {
		throw new PostRuleError(POST_RULE.endsBeforeStart, 'A kegiatan cannot end before it starts.');
	}
}

/** The one Post named by `postId`, or `PostNotFoundError`. */
async function findPost(writer: DatabaseWriter, postId: string): Promise<Post> {
	const [row] = await writer.select().from(posts).where(eq(posts.id, postId)).limit(1);
	if (!row) {
		throw new PostNotFoundError(postId);
	}
	return row;
}

/** The `residents` row belonging to a signed-in account, or `undefined` when it has none. */
async function residentIdForUser(
	writer: DatabaseWriter,
	userId: string
): Promise<string | undefined> {
	const [row] = await writer
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId))
		.limit(1);
	return row?.id;
}

/**
 * What an audit row records about a Post.
 *
 * Deliberately not `bodyMarkdown`. An audit row exists so that a later reader can see who changed
 * what, and a body is long enough that two copies of it per edit would bury every other column in
 * the log; the fields below are the ones somebody reading the log is actually asking about.
 */
function auditSnapshot(row: Post): Record<string, unknown> {
	return {
		type: row.type,
		title: row.title,
		category: row.category,
		status: row.status,
		startsAt: row.startsAt,
		endsAt: row.endsAt,
		location: row.location
	};
}

/** The `where` clause for a list request, or `undefined` when nothing was filtered. */
function postFilter(request: ListPostsRequest) {
	const conditions = [];
	if (request.status) {
		conditions.push(eq(posts.status, request.status));
	}
	if (request.type) {
		conditions.push(eq(posts.type, request.type));
	}
	if (request.category) {
		conditions.push(eq(posts.category, request.category));
	}
	return conditions.length > 0 ? and(...conditions) : undefined;
}

/** `page`, defaulted to `1` and floored at `1`. */
function normalizePage(page: number | undefined): number {
	if (!page || !Number.isFinite(page) || page < 1) {
		return 1;
	}
	return Math.floor(page);
}

/** `pageSize`, defaulted to `DEFAULT_POST_PAGE_SIZE` and floored at `1`. */
function normalizePageSize(pageSize: number | undefined): number {
	if (!pageSize || !Number.isFinite(pageSize) || pageSize < 1) {
		return DEFAULT_POST_PAGE_SIZE;
	}
	return Math.floor(pageSize);
}
