import { redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
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
 * The action always redirects, including when there was no session to end. Someone who arrives
 * here with an expired cookie wants to be at the sign-in page, not at an error.
 */

export const load: PageServerLoad = () => {
	redirect(303, AUTH_PATHS.login);
};

export const actions: Actions = {
	default: async ({ request }) => {
		try {
			await auth().api.signOut({ headers: request.headers });
		} catch (error) {
			if (!(error instanceof APIError)) {
				throw error;
			}
		}

		redirect(303, AUTH_PATHS.login);
	}
};
