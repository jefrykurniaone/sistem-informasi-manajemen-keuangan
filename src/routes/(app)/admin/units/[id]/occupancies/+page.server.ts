import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { OCCUPANCY_ROLES, type OccupancyRole } from '$lib/server/db/schema/occupancy';
import { assertUuidParam } from '$lib/server/services/identifier';
import { systemClock } from '$lib/server/ports/clock';
import {
	endOccupancy,
	listAssignableResidents,
	listUnitOccupanciesGrouped,
	OccupancyDateOrderError,
	OccupancyNotFoundError,
	OccupancyOverlapError,
	PrimaryOccupantAlreadyEndedError,
	PrimaryOccupantNotStartedError,
	recordOccupancy,
	ResidentNotFoundError,
	setPrimaryOccupant
} from '$lib/server/services/occupancy';
import { getUnit, UnitNotFoundError } from '$lib/server/services/unit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for one unit's Masa Huni: the whole history of who lived there, the form that
 * records a new stay, and the two buttons that end one or move the Penanggung Jawab flag onto it.
 *
 * It follows the translation rule the rest of the admin screens follow, and that
 * `spec-fondasi-v1.md` asks for: the service refuses, and this file — never the service — decides
 * what that refusal is over HTTP. A caller who may not be here at all gets `error(403, …)`; a request
 * for a unit or an occupancy that does not exist gets a 404, because both ids come straight from the
 * URL or from a hidden field this screen rendered; and a rule the complex refuses — a Penanggung
 * Jawab on a stay that has not started or is already over, an end date before the start date, a
 * resident who has since been removed, or a second Masa Huni that would overlap one the resident
 * already has in this unit — is `fail(400, …)`, because the superuser did nothing outside their rights
 * and only this particular change is refused.
 *
 * The load hands the screen the unit's `primaryOccupantNeed` as the Unit service decided it, so the
 * red and yellow warnings are never a date comparison made in the template. `occupancies` is likewise
 * handed over already split into `current`, `upcoming` and `history` by `listUnitOccupanciesGrouped` —
 * `docs/spec-penghuni-v1.md` decision 3 — so the page renders those three groups rather than
 * classifying Masa Huni by date itself.
 */

/** A calendar day as an `<input type="date">` posts it. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}
	// `units.id` is a `uuid` column — see #111 and `$lib/server/services/identifier.ts`.
	assertUuidParam(params.id, m.adminUnits_notFound());

	const db = database();
	try {
		const [unit, occupancies, residents] = await Promise.all([
			getUnit(db, locals.user.id, params.id, systemClock),
			listUnitOccupanciesGrouped(db, systemClock, locals.user.id, params.id),
			listAssignableResidents(db, locals.user.id)
		]);
		return { unit, occupancies, residents, roles: OCCUPANCY_ROLES };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	record: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}
		assertUuidParam(params.id, m.adminUnits_notFound());

		const form = await request.formData();
		const residentId = String(form.get('residentId') ?? '').trim();
		const role = String(form.get('role') ?? '').trim();
		const startedOn = String(form.get('startedOn') ?? '').trim();
		if (residentId === '' || !isOccupancyRole(role) || !CALENDAR_DAY.test(startedOn)) {
			return fail(400, { message: m.adminOccupancies_invalidForm() });
		}

		try {
			await recordOccupancy(database(), systemClock, {
				actorId: locals.user.id,
				unitId: params.id,
				residentId,
				role,
				startedOn,
				isPrimaryOccupant: form.get('isPrimaryOccupant') === 'true'
			});
		} catch (caught) {
			return refusalOrThrow(caught);
		}
		return { message: m.adminOccupancies_addSuccess() };
	},

	end: async ({ locals, request }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const occupancyId = String(form.get('occupancyId') ?? '').trim();
		const endedOn = String(form.get('endedOn') ?? '').trim();
		if (occupancyId === '' || !CALENDAR_DAY.test(endedOn)) {
			return fail(400, { message: m.adminOccupancies_invalidEndForm() });
		}

		try {
			await endOccupancy(database(), systemClock, {
				actorId: locals.user.id,
				occupancyId,
				endedOn
			});
		} catch (caught) {
			return refusalOrThrow(caught);
		}
		return { message: m.adminOccupancies_endSuccess() };
	},

	setPrimary: async ({ locals, request }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const occupancyId = String(form.get('occupancyId') ?? '').trim();
		if (occupancyId === '') {
			return fail(400, { message: m.adminOccupancies_invalidEndForm() });
		}

		try {
			await setPrimaryOccupant(database(), systemClock, {
				actorId: locals.user.id,
				occupancyId
			});
		} catch (caught) {
			return refusalOrThrow(caught);
		}
		return { message: m.adminOccupancies_setPrimarySuccess() };
	}
};

/** Whether `value` is one of the roles the schema's check constraint allows. */
function isOccupancyRole(value: string): value is OccupancyRole {
	return (OCCUPANCY_ROLES as readonly string[]).includes(value);
}

/**
 * Turns a refused change into `fail(400, …)`, or hands anything else to `throwAsRouteError`.
 *
 * The errors below are all "you may do this, but not this particular one", which is what separates
 * them from a permission refusal — see `src/lib/errors.ts` on `LastSuperuserError` for the same
 * distinction drawn the first time. `PrimaryOccupantNotStartedError` answers both "Jadikan
 * penanggung jawab" on a stay that starts later and "Catat masa huni" with the box ticked for a start
 * day after today, and its message names that start day. `OccupancyOverlapError` carries one of two
 * things — `mustEndFirst` picks which message names it — never both: the earliest day a new stay may
 * start, or nothing at all when the conflicting stay has no last day yet to count from.
 */
function refusalOrThrow(caught: unknown) {
	if (caught instanceof PrimaryOccupantNotStartedError) {
		return fail(400, {
			message: m.adminOccupancies_primaryNotStarted({ startedOn: caught.startedOn })
		});
	}
	if (caught instanceof PrimaryOccupantAlreadyEndedError) {
		return fail(400, {
			message: m.adminOccupancies_primaryAlreadyEnded({ endedOn: caught.endedOn })
		});
	}
	if (caught instanceof OccupancyDateOrderError) {
		return fail(400, {
			message: m.adminOccupancies_dateOrder({
				startedOn: caught.startedOn,
				endedOn: caught.endedOn
			})
		});
	}
	if (caught instanceof ResidentNotFoundError) {
		return fail(400, { message: m.adminOccupancies_residentNotFound() });
	}
	if (caught instanceof OccupancyOverlapError) {
		return fail(400, {
			message: caught.mustEndFirst
				? m.adminOccupancies_overlapMustEnd()
				: m.adminOccupancies_overlap({ earliestStartedOn: caught.earliestStartedOn ?? '' })
		});
	}
	throwAsRouteError(caught);
}

/**
 * Turns a permission refusal into a 403 and a missing row into a 404, and throws it — or rethrows
 * whatever else it was. Always throws, for the reason the other admin screens' copies of this helper
 * record: a `catch` block that sometimes *returned* an error is what breaks SvelteKit's inference of
 * `ActionData`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminOccupancies_forbidden());
	}
	if (caught instanceof UnitNotFoundError) {
		throw error(404, m.adminUnits_notFound());
	}
	if (caught instanceof OccupancyNotFoundError) {
		throw error(404, m.adminOccupancies_notFound());
	}
	throw caught;
}
