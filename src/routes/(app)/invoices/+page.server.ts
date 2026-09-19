import { redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { invoicesForUser } from '$lib/server/services/dues/queries';
import type { PageServerLoad } from './$types';

/**
 * A warga's own Tagihan: which are lunas, sebagian, belum bayar or menunggak, and the total
 * tunggakan in one number — `docs/spec-iuran-v1.md` user stories 6 and 7.
 *
 * **There is nothing to guard beyond the session.** `invoicesForUser` takes only the signed-in
 * account's own id, so there is no id in a URL or a form a caller could swap for someone else's —
 * the same reason `(app)/my-unit/+page.server.ts` gives for the same shape of load.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	return invoicesForUser(database(), systemClock, locals.user.id);
};
