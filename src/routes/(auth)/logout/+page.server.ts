import { redirect } from '@sveltejs/kit';
import { AUTH_PATHS, auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * Signing out.
 *
 * **There is no page here on purpose.** Signing out only ever happens as a POST from a form, so
 * that a link on another site — or an image tag pointing at this address — cannot sign someone
 * out behind their back. SvelteKit checks the `Origin` header of every form post, which is what
 * makes that POST safe to act on. A GET lands on the `load` below, which sends the browser to the
 * sign-in page without touching the session.
 *
 * **Because there is no `+page.svelte`, neither export here may ever return.** SvelteKit throws
 * `Missing +page.svelte component for route /(auth)/logout` the moment it has to render this
 * route, and it renders whenever a `load` returns data or an action returns `fail(...)`. Both
 * exports below end in `redirect`, and a later change that makes one of them return something
 * instead has to add the component in the same breath.
 *
 * Nothing is caught. `signOut` tolerates a request with no session — it clears the cookie and
 * answers successfully — and it already swallows its own database failures, so an error reaching
 * this far is one that has not been thought about, and hiding it behind a redirect that says
 * "you are signed out" would be saying something untrue.
 */

export const load: PageServerLoad = () => {
	redirect(303, AUTH_PATHS.login);
};

export const actions: Actions = {
	default: async ({ request }) => {
		await auth().api.signOut({ headers: request.headers });
		redirect(303, AUTH_PATHS.login);
	}
};
