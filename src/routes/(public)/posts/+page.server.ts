import { database } from '$lib/server/db';
import { getLocale } from '$lib/paraglide/runtime';
import { systemClock } from '$lib/server/ports/clock';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import { isPostCategory, POST_CATEGORIES } from '$lib/server/services/post';
import { listPublicPosts, POST_WHEN } from '$lib/server/services/post/public';
import type { Post } from '$lib/server/db/schema/post';
import type { FileStore } from '$lib/server/ports/file-store';
import type { PageServerLoad } from './$types';

/**
 * The announcement board a visitor with no session opens — story 11 through 15 of
 * `docs/spec-konten-v1.md`. Every row `listPublicPosts` hands back is already `published`; this
 * route only shapes it for the page, the same split `(app)/admin/posts/+page.server.ts` makes
 * between the service's rows and the labels a person reads.
 *
 * A cover image's stored key becomes a signed link here, through the same `FileStore` port
 * `(app)/admin/posts/[id]/+page.server.ts` writes one with — this route is that key's first reader.
 * `LocalFileStore.signedLink` returns a path under `SIGNED_LINK_BASE_PATH` (`/files/…`), and no
 * route in this repository answers a request there yet: serving it is a `ServedFileStore` route
 * this ticket's `writes:` does not include, so a card whose Post has a cover image carries a link
 * that 404s until that route exists. See this ticket's delivery report for the full account; this
 * comment only marks the one line the gap touches.
 */

export const load: PageServerLoad = async ({ url }) => {
	const page = parsePositivePage(url.searchParams.get('page'));
	const category = parseCategory(url.searchParams.get('category'));
	const when =
		url.searchParams.get('when') === POST_WHEN.past ? POST_WHEN.past : POST_WHEN.upcoming;

	const result = await listPublicPosts(database(), systemClock, {
		page,
		category,
		when
	});

	const fileStore = localFileStoreFromEnvironment(systemClock);
	const cards = await Promise.all(result.posts.map((post) => toCard(post, fileStore)));

	return {
		posts: cards,
		page: result.page,
		pageSize: result.pageSize,
		totalCount: result.totalCount,
		when: result.when,
		filters: { category: category ?? '' },
		categories: POST_CATEGORIES
	};
};

/** What one card on the board needs, formatted and with its cover image resolved to a signed link. */
async function toCard(
	post: Post,
	fileStore: FileStore
): Promise<{
	id: string;
	type: string;
	category: string;
	title: string;
	summary: string;
	startsAtLabel: string | null;
	location: string | null;
	coverImageUrl: string | null;
}> {
	return {
		id: post.id,
		type: post.type,
		category: post.category,
		title: post.title,
		summary: post.summary,
		startsAtLabel: formatInstant(post.startsAt),
		location: post.location,
		coverImageUrl: post.coverImageKey ? await fileStore.signedLink(post.coverImageKey) : null
	};
}

/**
 * An instant as a sentence, in the interface locale, or `null` when there is no instant. Copied
 * from `(app)/admin/posts/+page.server.ts`'s helper of the same name for the same reason that
 * route's own comment gives: a route helper belongs next to the route that uses it.
 */
function formatInstant(instant: Date | null): string | null {
	if (!instant) {
		return null;
	}
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: 'full',
		timeStyle: 'short'
	}).format(instant);
}

/** A 1-based page number from a query string value, or `undefined` when it does not name one. */
function parsePositivePage(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * A category from the query string, or `undefined` for "every category". A value nothing
 * recognises is treated as no filter, the same reasoning
 * `(app)/admin/posts/+page.server.ts`'s copy of this helper explains: the query string is editable
 * by whoever is looking at the page, and a typo should not break the screen.
 */
function parseCategory(value: string | null): string | undefined {
	return value && isPostCategory(value) ? value : undefined;
}
