import { error } from '@sveltejs/kit';

/**
 * Whether a route param is shaped like a PostgreSQL `uuid` column's text form — the one check
 * every `[id]`/`[unitId]` route that compares `params` straight to a `uuid` column needs, and the
 * one place it is written (#111).
 *
 * ## Why this exists
 *
 * A route like `(public)/posts/[id]` reads `params.id` off the URL and hands it, unchecked, to a
 * query comparing it to `posts.id`, a `uuid` column. PostgreSQL's `uuid` type has no implicit cast
 * from an arbitrary string: a value that is not shaped like a uuid — `new`, `abc`, `1` — makes the
 * comparison itself fail with a driver error, which every route in this codebase leaves uncaught,
 * so it reaches the visitor as a 500. A real-but-missing uuid, by contrast, is exactly the "no
 * row" case every route already turns into a 404. The two are indistinguishable to a visitor who
 * typed a URL — "not a uuid" and "a uuid nobody used" both mean "there's nothing at this id" — so
 * this module makes the first case answer exactly like the second.
 *
 * `/posts/new`, the report this ticket started from, is unlucky in one more way: `new` also names a
 * sibling static route (`/admin/posts/new`), which is what made the dev log's `params: new` easy to
 * misread as a routing bug rather than an unguarded query.
 */

/**
 * A fixed-length, non-backtracking match for a PostgreSQL `uuid` column's canonical text form: 32
 * hex digits in the 8-4-4-4-12 grouping. Every quantifier is bounded and there is no overlap
 * between groups, so this cannot backtrack catastrophically (SonarQube S5852/S8786).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is shaped like a PostgreSQL `uuid` column's text form. */
export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/**
 * Refuses a route param that is not shaped like a `uuid`, before it ever reaches a query that
 * would compare it to one — see this module's doc comment for why that comparison is otherwise a
 * 500. Every `[id]`/`[unitId]` route's `load` and every action of its that reads the same param
 * calls this first, so the check exists in this one function rather than being copied into each
 * route as its own regex.
 *
 * `notFoundMessage` is the calling route's own not-found sentence — the same one it already throws
 * for a real-but-missing id — so a visitor who typed a non-uuid id reads exactly the page a visitor
 * who typed an unused uuid reads.
 *
 * @throws always throws SvelteKit's `error(404, notFoundMessage)` when `value` is not a uuid;
 *   returns normally otherwise.
 */
export function assertUuidParam(value: string, notFoundMessage: string): void {
	if (!isUuid(value)) {
		throw error(404, notFoundMessage);
	}
}
