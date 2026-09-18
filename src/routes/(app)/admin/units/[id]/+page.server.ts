import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	deactivateUnit,
	getUnit,
	reactivateUnit,
	UnitNotFoundError
} from '$lib/server/services/unit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser detail screen for one unit: what it is, how many occupancies of it are running,
 * and the one button that switches it off or back on. Follows the same shape
 * `src/routes/(app)/admin/units/+page.server.ts` and `src/routes/(app)/admin/roles/+page.server.ts`
 * settled — nobody who is not signed in reaches the service layer, and a permission refusal becomes
 * `error(403, …)` here, never in the service.
 *
 * `UnitNotFoundError` becomes a 404: `params.id` is read straight from the URL, so an id that names
 * no unit is a request the admin screen never produced a link to, not a rejected form.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const unit = await getUnit(database(), locals.user.id, params.id);
		return { unit };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	deactivate: async ({ locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		try {
			await deactivateUnit(database(), systemClock, { actorId: locals.user.id, unitId: params.id });
		} catch (caught) {
			throwAsRouteError(caught);
		}
		return { message: m.adminUnits_deactivateSuccess() };
	},

	reactivate: async ({ locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		try {
			await reactivateUnit(database(), systemClock, { actorId: locals.user.id, unitId: params.id });
		} catch (caught) {
			throwAsRouteError(caught);
		}
		return { message: m.adminUnits_reactivateSuccess() };
	}
};

/**
 * Turns a caught permission refusal into a 403, or a caught missing unit into a 404, and throws it —
 * or rethrows whatever else it was. Always throws — the return type is `never` for the same reason
 * the roles and unit-list screens' copies of this helper are: a `catch` block that sometimes
 * *returned* an error instead of throwing it is what breaks SvelteKit's inference of `ActionData`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminUnits_forbidden());
	}
	if (caught instanceof UnitNotFoundError) {
		throw error(404, m.adminUnits_notFound());
	}
	throw caught;
}
