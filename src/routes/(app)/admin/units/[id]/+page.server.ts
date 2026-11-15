import * as m from '#lib/paraglide/messages.js';
import {
	productionDependencies,
	requireUser,
	requireUuidParam,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import { deactivateUnit, getUnit, reactivateUnit } from '#lib/server/services/unit/index.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser detail screen for one unit: what it is, who is living in it today and how many of
 * them there are, and the one button that switches it off or back on. Nobody who is not signed in
 * reaches the service layer, and a permission refusal becomes `error(403, …)` here, never in the
 * service. Both go through `#lib/server/route-action.ts` (#318).
 *
 * `UnitNotFoundError` becomes a 404: `params.id` is read straight from the URL, so an id that names
 * no unit is a request the admin screen never produced a link to, not a rejected form. That is why
 * the two actions only ever throw: they have no form sentence to answer with.
 */

/** The 403 for anyone without `ACTION.manageUnits`, and the 404 for an id that names no unit. */
const PAGE = {
	forbidden: m.adminUnits_forbidden,
	notFound: m.adminUnits_notFound
} satisfies PageMessages;

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	// `units.id` is a `uuid` column — see #111 and `#lib/server/services/identifier.ts`.
	const unitId = requireUuidParam(params.id, PAGE);

	const { db, clock } = productionDependencies();
	try {
		const unit = await getUnit(db, user.id, unitId, clock);
		return { unit };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	deactivate: async ({ locals, params }) => {
		const user = requireUser(locals);
		const unitId = requireUuidParam(params.id, PAGE);

		const { db, clock } = productionDependencies();
		try {
			await deactivateUnit(db, clock, { actorId: user.id, unitId });
		} catch (caught) {
			throwRouteError(caught, PAGE);
		}
		return { message: m.adminUnits_deactivateSuccess() };
	},

	reactivate: async ({ locals, params }) => {
		const user = requireUser(locals);
		const unitId = requireUuidParam(params.id, PAGE);

		const { db, clock } = productionDependencies();
		try {
			await reactivateUnit(db, clock, { actorId: user.id, unitId });
		} catch (caught) {
			throwRouteError(caught, PAGE);
		}
		return { message: m.adminUnits_reactivateSuccess() };
	}
};
