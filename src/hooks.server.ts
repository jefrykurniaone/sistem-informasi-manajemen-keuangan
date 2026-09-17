import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '$lib/server/auth';
import { paraglideMiddleware } from '$lib/paraglide/server.js';
import { getTextDirection } from '$lib/paraglide/runtime.js';

/**
 * Where a request meets better-auth, then Paraglide. `sequence()` runs `authHandle` first and
 * hands its `resolve` to `localeHandle`, so the two compose rather than one replacing the other —
 * see the ticket that added `localeHandle` (#14) and the doc comment on `authHandle` below, which
 * `sequence()` does not change.
 *
 * ## `authHandle` — unchanged from the ticket that wrote it
 *
 * Two things happen here, in this order:
 *
 * 1. **The session is read and put on `event.locals`.** Every server `load` and every form action
 *    can then ask who is making the request without fetching it again, which is the point: a
 *    later ticket that needs the caller must not have to remember how to get one, and two places
 *    reading a session two different ways is how they end up disagreeing.
 * 2. **better-auth's own endpoints are answered.** `svelteKitHandler` passes anything under
 *    `/api/auth/` straight to the library and leaves every other address to SvelteKit.
 *
 * Nothing is decided here. A session that is missing, expired or belongs to an unverified account
 * leaves `locals.user` as `null`; deciding what a page does about that belongs to the page, and
 * deciding what a service does about it belongs to the role guard in `src/lib/server/authz.ts`.
 *
 * During `building` neither step runs. Prerendering has no request to read a session from, and
 * calling `auth()` would open a connection pool to a database that is not up at build time.
 *
 * ## `localeHandle` — added by ticket #14
 *
 * Resolves the interface locale for this request using the strategy configured in
 * `vite.config.ts` (`['cookie', 'baseLocale']` — no `url`, so this never redirects or rewrites the
 * request's address) and fills the `%lang%` / `%dir%` placeholders `src/app.html` carries, so the
 * server-rendered response already carries the right `<html lang>` before any client script runs.
 * It runs after `authHandle` — session first, then locale — but the two never actually interact:
 * ordering here only matters because `sequence()` needs one, not because either handle reads what
 * the other wrote.
 *
 * `/api/auth/*` keeps working through this: `paraglideMiddleware` only reads the request to decide
 * a locale and wraps the response with `transformPageChunk`, which is a no-op on a JSON response
 * that carries no `%lang%`/`%dir%` text. `svelteKitHandler` already ran inside `authHandle` by the
 * time `localeHandle` sees the request.
 */

const authHandle: Handle = async ({ event, resolve }) => {
	if (building) {
		return resolve(event);
	}

	const instance = auth();
	const active = await instance.api.getSession({ headers: event.request.headers });
	event.locals.session = active?.session ?? null;
	event.locals.user = active?.user ?? null;

	return svelteKitHandler({ auth: instance, event, resolve, building });
};

const localeHandle: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale))
		});
	});

export const handle: Handle = sequence(authHandle, localeHandle);
