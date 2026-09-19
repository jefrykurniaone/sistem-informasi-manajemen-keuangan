import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { listOverdueUnits } from '$lib/server/services/dues/queries';
import type { PageServerLoad } from './$types';

/**
 * Admin's daftar penunggak: every house owing something past its due date, largest total first —
 * `docs/spec-iuran-v1.md` user story 18, and the one screen the spec says explicitly "hanya bisa
 * dibuka oleh admin". Follows the shape `(app)/admin/complaints/+page.server.ts` settled: nobody
 * who is not signed in reaches the service layer, and a permission refusal becomes `error(403, …)`
 * here rather than in the service.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const overdue = await listOverdueUnits(database(), systemClock, locals.user.id);
		return { overdue };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` for the reason every other copy of this helper in this
 * codebase gives: a `catch` block that sometimes *returned* an error is what breaks SvelteKit's
 * inference of the load's return type.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminOverdue_forbidden());
	}
	throw caught;
}
