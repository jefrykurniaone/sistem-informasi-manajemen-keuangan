import { and, asc, count, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { posts, POST_STATUS, POST_TYPE, type Post } from '../../db/schema/post';
import type { Clock } from '../../ports/clock';
import { PostNotFoundError, type PostCategory } from './index';

/**
 * The announcement board's public reading side: a visitor with no session opening `/posts` or
 * `/posts/[id]`, per `docs/spec-konten-v1.md`'s "Halaman publik punya dua wajah" and the ticket
 * that builds the pages themselves (#40).
 *
 * ## Why this is not a function added to `./index.ts`
 *
 * Every read `./index.ts` already has — `listPosts`, `getPost`, `previewPostBody` — starts with
 * `requirePermission(db, actorId, ACTION.managePosts)`, because they are the admin screen's own
 * reads and an admin list is "only useful to whoever may act on it". A public read has no `actorId`
 * at all: there is no session, so there is nothing to check permission against. Bolting an
 * `actorId?: string` onto `listPosts` to skip the check when it is missing would make one function
 * do two unrelated things and would put "does this request need permission at all" inside the
 * function instead of in its name — the same one-concern-one-file idiom `./markdown.ts`,
 * `../occupancy/visibility.ts` and `../subscription/kinds.ts` already follow.
 *
 * ## The one rule this module exists to hold
 *
 * **Every function here returns only a Post whose `status` is `published`, with no exception for a
 * guessed id.** `getPublishedPost` filters on `status` in the same `where` clause that filters on
 * `id`, not in a check performed after the row comes back — a `draft` or `archived` Post is
 * indistinguishable from one that never existed, which is exactly what
 * `docs/spec-konten-v1.md`'s testing decision asks for: "permintaan publik atas daftar dan atas
 * satu Post tidak pernah mengembalikan draf atau arsip, termasuk saat pengenalnya ditebak
 * langsung."
 *
 * ## The query-string shape this module hands the route
 *
 * `ListPublicPostsRequest.when` is this ticket's answer to "kegiatan yang akan datang mudah
 * ditemukan; yang sudah lewat tidak memenuhi layar" (goals) together with story 12's "melihat
 * kegiatan dan pengumuman yang sudah lewat kalau saya mencarinya" — the spec asks for the shape,
 * the ticket's dispatch note leaves choosing it to this module:
 *
 * - `'upcoming'` (the default): an `event` counts only while its `startsAt` has not passed yet, and
 *   every `announcement` counts always — announcements have no date of their own to age out by.
 *   Sorted with `event` rows first, soonest `startsAt` first, then `announcement` rows newest
 *   published first. This is the literal order the first acceptance criterion names: "kegiatan yang
 *   akan datang lebih dulu, terurut dari yang paling dekat, lalu pengumuman terbaru."
 * - `'past'`: an `event` counts once its `startsAt` has passed, and every `announcement` still
 *   counts — every `announcement` a visitor can see was, by definition, published in the past
 *   relative to the moment they are looking, so none is excluded from this view. The two are
 *   interleaved into one feed, newest moment first, using an event's `startsAt` and an
 *   announcement's `publishedAt` as the same "when did this happen" value. That satisfies the
 *   second acceptance criterion — "kegiatan dan pengumuman yang sudah lewat dapat ditemukan lewat
 *   penyaring pada halaman daftar yang sama" — without a second route or a second page, which the
 *   ticket's dispatch note rules out ("Halaman arsip terpisah karena itu tidak dibuat").
 *
 * The boundary in both is `startsAt` against `now`, never `endsAt`: `docs/spec-konten-v1.md`'s own
 * testing decision describes the fake-clock test as events "tersebar sebelum dan sesudah waktu
 * sekarang", which is a statement about `startsAt`, not about whether an event is still under way.
 *
 * `category` is the other half of the query string: an exact match against `posts.category`,
 * validated by the route before it reaches here — the same split `(app)/admin/posts/+page.server.ts`
 * makes with its own `parseCategory`, so an unrecognised value is treated as no filter rather than
 * as an error a visitor caused by editing a URL.
 */

/** The two ways the public list can be scoped, chosen by the `when` query-string parameter. */
export const POST_WHEN = {
	upcoming: 'upcoming',
	past: 'past'
} as const;

/** One of the two values above. */
export type PostWhen = (typeof POST_WHEN)[keyof typeof POST_WHEN];

/** The default page size for the public Post list. Smaller than the admin list's, which pages 20. */
export const DEFAULT_PUBLIC_POST_PAGE_SIZE = 10;

/** What the public list page asks for. */
export interface ListPublicPostsRequest {
	/** 1-based. Defaults to `1`. */
	readonly page?: number;
	/** Defaults to `DEFAULT_PUBLIC_POST_PAGE_SIZE`. */
	readonly pageSize?: number;
	/** Only this category. Missing or unrecognised means every category. */
	readonly category?: PostCategory | string;
	/** Defaults to `POST_WHEN.upcoming`. */
	readonly when?: PostWhen;
}

/** One page of the public Post list. */
export interface PublicPostListResult {
	readonly posts: readonly Post[];
	readonly page: number;
	readonly pageSize: number;
	readonly totalCount: number;
	/** Which of the two views this result answers, normalized from whatever the request asked for. */
	readonly when: PostWhen;
}

/**
 * One page of every `published` Post, scoped and ordered by `request.when` — see this module's doc
 * comment for what each of the two views means and why.
 *
 * Never throws for a caller: there is no permission to check and no id to fail to find, which is
 * the whole difference from `listPosts` in `./index.ts`.
 */
export async function listPublicPosts(
	db: Database,
	clock: Clock,
	request: ListPublicPostsRequest = {}
): Promise<PublicPostListResult> {
	const page = normalizePage(request.page);
	const pageSize = normalizePageSize(request.pageSize);
	const when = request.when === POST_WHEN.past ? POST_WHEN.past : POST_WHEN.upcoming;
	const now = clock.now();

	const filter = publicPostFilter(request.category, when, now);

	const rows = await db
		.select()
		.from(posts)
		.where(filter)
		.orderBy(...publicPostOrder(when))
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	const [totals] = await db.select({ value: count() }).from(posts).where(filter);

	return { posts: rows, page, pageSize, totalCount: totals?.value ?? 0, when };
}

/**
 * The one Post named by `postId`, for the public detail page.
 *
 * @throws {PostNotFoundError} when `postId` names no Post, when it names one that is not
 *   `published`, or — from the outside these two are the same thing, which is the point.
 */
export async function getPublishedPost(db: Database, postId: string): Promise<Post> {
	const [row] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.status, POST_STATUS.published)))
		.limit(1);
	if (!row) {
		throw new PostNotFoundError(postId);
	}
	return row;
}

/**
 * The `where` clause every public read shares: always `published`, always scoped by `when`, and
 * optionally narrowed by `category`.
 */
function publicPostFilter(category: string | undefined, when: PostWhen, now: Date) {
	const scope =
		when === POST_WHEN.past
			? or(
					eq(posts.type, POST_TYPE.announcement),
					and(eq(posts.type, POST_TYPE.event), lt(posts.startsAt, now))
				)
			: or(
					eq(posts.type, POST_TYPE.announcement),
					and(eq(posts.type, POST_TYPE.event), gte(posts.startsAt, now))
				);

	const conditions = [eq(posts.status, POST_STATUS.published), scope];
	if (category) {
		conditions.push(eq(posts.category, category));
	}
	return and(...conditions);
}

/**
 * The `order by` for one of the two views.
 *
 * `'past'` is one reverse-chronological feed: `coalesce(startsAt, publishedAt)` is an event's own
 * moment for an `event` row and the moment it reached the board for an `announcement` row, and
 * ordering by that one expression is what interleaves the two types into a single "most recently
 * relevant first" list.
 *
 * `'upcoming'` cannot use one expression the same way, because ordering announcements by `startsAt`
 * would put every one of them first or last depending on how `NULL` sorts, which is an accident of
 * the column rather than a decision. It orders by three criteria instead: `event` rows before
 * `announcement` rows, `event` rows by `startsAt` ascending, `announcement` rows by `publishedAt`
 * descending — exactly the two-part order the acceptance criterion names.
 */
function publicPostOrder(when: PostWhen) {
	if (when === POST_WHEN.past) {
		return [desc(sql`coalesce(${posts.startsAt}, ${posts.publishedAt})`), desc(posts.id)];
	}
	return [
		desc(sql`${posts.type} = ${POST_TYPE.event}`),
		asc(sql`case when ${posts.type} = ${POST_TYPE.event} then ${posts.startsAt} end`),
		desc(sql`case when ${posts.type} = ${POST_TYPE.announcement} then ${posts.publishedAt} end`),
		desc(posts.id)
	];
}

/** `page`, defaulted to `1` and floored at `1`. Mirrors `./index.ts`'s copy for the same reason. */
function normalizePage(page: number | undefined): number {
	if (!page || !Number.isFinite(page) || page < 1) {
		return 1;
	}
	return Math.floor(page);
}

/** `pageSize`, defaulted to `DEFAULT_PUBLIC_POST_PAGE_SIZE` and floored at `1`. */
function normalizePageSize(pageSize: number | undefined): number {
	if (!pageSize || !Number.isFinite(pageSize) || pageSize < 1) {
		return DEFAULT_PUBLIC_POST_PAGE_SIZE;
	}
	return Math.floor(pageSize);
}
