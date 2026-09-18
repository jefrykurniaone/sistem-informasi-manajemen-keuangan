import { redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { ownRegistrationStatus } from '$lib/server/services/registration';
import type { PageServerLoad } from './$types';

/**
 * What a self-registrant sees while — or instead of — being let in. It is the one page of the
 * `(app)` group that `src/routes/(app)/+layout.server.ts` does not redirect away from, and it exists
 * so that "pendaftaran Anda sedang ditinjau" is a sentence somebody reads rather than an empty
 * screen they guess at.
 *
 * **There is nothing to guard beyond the session.** The only key `ownRegistrationStatus` takes is
 * the signed-in account's own address, so there is no id in a URL or a form anybody could swap for
 * somebody else's — the same reasoning `src/routes/(app)/my-unit/+page.server.ts` records. This load
 * reads and never writes, so it has no action and no `PermissionDeniedError` to translate.
 *
 * **An account with no registration at all is a real state, and the page says so honestly.** It is
 * what a pengurus seeded from outside looks like, and what a sign-up whose registration row did not
 * land looks like; both are better served by a page that admits it than by one that invents a
 * pending request.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const registration = await ownRegistrationStatus(database(), locals.user.email);
	return { registration: registration ?? null };
};
