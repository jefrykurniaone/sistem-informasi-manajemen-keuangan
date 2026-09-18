import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import {
	POST_STATUSES,
	POST_TYPES,
	type PostStatus,
	type PostType
} from '$lib/server/db/schema/post';
import {
	DEFAULT_POST_PAGE_SIZE,
	isPostCategory,
	listPosts,
	POST_CATEGORIES
} from '$lib/server/services/post';
import type { PageServerLoad } from './$types';

/**
 * The admin screen for the announcement board: every Post there is, drafts included, with filters
 * for status, type and category. Follows the shape
 * `src/routes/(app)/admin/units/+page.server.ts` settled — nobody who is not signed in reaches the
 * service layer, and `PermissionDeniedError` becomes `error(403, …)` here, never in the service.
 *
 * Writing, editing, previewing, publishing and archiving all live on the two screens below this
 * one; this route has no actions at all.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const page = parsePositivePage(url.searchParams.get('page'));
	const status = parseStatus(url.searchParams.get('status'));
	const type = parseType(url.searchParams.get('type'));
	const category = parseCategory(url.searchParams.get('category'));

	try {
		const result = await listPosts(database(), {
			actorId: locals.user.id,
			page,
			pageSize: DEFAULT_POST_PAGE_SIZE,
			status,
			type,
			category
		});
		return {
			// The two instants are formatted here rather than in the page. Formatting in the component
			// would run once on the server and again in the browser, against two different time zones
			// and two different locale databases, which is a hydration mismatch waiting to happen.
			posts: result.posts.map((post) => ({
				id: post.id,
				type: post.type,
				status: post.status,
				category: post.category,
				title: post.title,
				summary: post.summary,
				authorName: post.authorName,
				startsAtLabel: formatInstant(post.startsAt),
				publishedAtLabel: formatInstant(post.publishedAt)
			})),
			page: result.page,
			pageSize: result.pageSize,
			totalCount: result.totalCount,
			filters: { status: status ?? '', type: type ?? '', category: category ?? '' },
			categories: POST_CATEGORIES,
			statuses: POST_STATUSES,
			types: POST_TYPES
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

/**
 * An instant as a sentence, in the interface locale, or `null` when there is no instant.
 *
 * The zone is the server's own, which is the complex's zone in any real deployment — `Clock` in
 * `src/lib/server/ports/clock.ts` deliberately does not know about zones, and inventing a
 * zone-aware helper is not this ticket's to do. `(app)/admin/posts/[id]/+page.server.ts` carries the
 * same helper for the same reason the three admin screens each carry their own
 * `throwAsRouteError`: a route helper belongs next to the route that uses it.
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
 * A status from the query string, or `undefined` for "every status".
 *
 * A value nothing recognises is treated as no filter at all rather than as an error: the query
 * string is editable by whoever is looking at the page, and answering a typo with a broken screen
 * helps nobody. The same reasoning applies to the two below.
 */
function parseStatus(value: string | null): PostStatus | undefined {
	return POST_STATUSES.find((status) => status === value);
}

/** A type from the query string, or `undefined` for "both types". */
function parseType(value: string | null): PostType | undefined {
	return POST_TYPES.find((type) => type === value);
}

/** A category from the query string, or `undefined` for "every category". */
function parseCategory(value: string | null): string | undefined {
	return value && isPostCategory(value) ? value : undefined;
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what a load function returns, exactly as the unit and
 * roles screens' copies of this helper explain.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminPosts_forbidden());
	}
	throw caught;
}
