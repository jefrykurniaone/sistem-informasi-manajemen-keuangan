import { createAuthClient } from 'better-auth/svelte';

/**
 * better-auth as the browser sees it.
 *
 * **This module ships to the browser.** It holds no secret, no database handle and no
 * server-side import: everything in it is a wrapper around a `fetch` to `/api/auth/*`, which is
 * exactly what an unauthenticated stranger could write by hand. Anything that must stay on the
 * server belongs in `$lib/server/auth.ts`, which SvelteKit refuses to bundle for the client.
 *
 * Every page in this ticket signs in, signs out and resets a password through a SvelteKit form
 * action instead of through this client, so that the whole flow works with JavaScript turned off
 * and so that the session cookie is set by the same response that redirects. The client is here
 * for what form actions cannot do: reading the current session from code that is already running
 * in the browser, which is what the navigation in a later ticket will want.
 *
 * No `baseURL` is set. The client calls the origin the page was served from, which is the only
 * origin that holds the session cookie. That origin has to be the one `ORIGIN` names: better-auth
 * only answers `/api/auth/*` for requests whose origin matches its `baseURL`, so an application
 * served on a port `ORIGIN` does not name leaves everything below with nothing to call. See
 * `$lib/server/auth.ts`.
 */
export const authClient = createAuthClient();

/** The signed-in session as a store, or `null` while nobody is signed in. */
export const useSession = authClient.useSession;
