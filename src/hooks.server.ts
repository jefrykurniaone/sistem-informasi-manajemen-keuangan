import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '$lib/server/auth';

/**
 * The one place a request meets better-auth.
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
 * deciding what a service does about it will belong to the role guard a later ticket adds.
 *
 * During `building` neither step runs. Prerendering has no request to read a session from, and
 * calling `auth()` would open a connection pool to a database that is not up at build time.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (building) {
		return resolve(event);
	}

	const instance = auth();
	const active = await instance.api.getSession({ headers: event.request.headers });
	event.locals.session = active?.session ?? null;
	event.locals.user = active?.user ?? null;

	return svelteKitHandler({ auth: instance, event, resolve, building });
};
