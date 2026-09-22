import type { LayoutServerLoad } from './$types';

/** Who is signed in, as far as a page that is not part of the application needs to know. */
interface Viewer {
	readonly name: string;
}

/**
 * The only data every route group shares: whether there is a session, and whose.
 *
 * Everything the app shell needs (the role-aware menu, the sidebar's remembered width) moved to
 * `src/routes/(app)/+layout.server.ts` together with the shell itself, because only the `(app)`
 * group renders a sidebar. Reading roles here would cost a query on every sign-in page and every
 * public Post for a menu nobody on those pages is shown.
 *
 * `viewer` is what `(public)/+layout.svelte`'s header greets a signed-in visitor with, and
 * `(app)/+layout.svelte` reads it to know whether to offer the way out. It carries the display name
 * and nothing else: this object is serialised into every page, so the email address and the account
 * id stay on the server, where `locals.user` already has them for any `load` that needs more.
 *
 * The locale is not returned here. `src/hooks.server.ts` resolves it per request and Paraglide's
 * runtime answers `getLocale()` on both sides, so a copy in load data would only be a second source
 * that could disagree with the first.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	const { user } = locals;
	const viewer: Viewer | null = user ? { name: user.name } : null;
	return { viewer };
};
