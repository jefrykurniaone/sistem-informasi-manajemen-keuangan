import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { OCCUPANCY_ROLES, type OccupancyRole } from '#lib/server/db/schema/occupancy.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	requireUuidParam,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	endOccupancy,
	listAssignableResidents,
	listUnitOccupanciesGrouped,
	OccupancyDateOrderError,
	OccupancyEndOverlapError,
	OccupancyOverlapError,
	PrimaryOccupantAlreadyEndedError,
	PrimaryOccupantNotStartedError,
	recordOccupancy,
	ResidentNotFoundError,
	setPrimaryOccupant
} from '#lib/server/services/occupancy/index.ts';
import { getUnit } from '#lib/server/services/unit/index.ts';
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
 * resident who has since been removed, a second Masa Huni that would overlap one the resident already
 * has in this unit, or a last day moved to where it would reach a later Masa Huni of theirs in the same
 * unit — is `fail(400, …)`, because the superuser did nothing outside their rights and only this
 * particular change is refused. All of it goes through `#lib/server/route-action.ts` (#318), and
 * the two 404 sentences are split by what the request names: the page and `record` act on the unit
 * in the URL (`adminUnits_notFound`), while `end` and `setPrimary` act on the Masa Huni in a hidden
 * field (`adminOccupancies_notFound`).
 *
 * The load hands the screen the unit's `primaryOccupantNeed` as the Unit service decided it, so the
 * red and yellow warnings are never a date comparison made in the template. `occupancies` is likewise
 * handed over already split into `current`, `upcoming` and `history` by `listUnitOccupanciesGrouped` —
 * `docs/spec-penghuni-v1.md` decision 3 — so the page renders those three groups rather than
 * classifying Masa Huni by date itself.
 */

/** A calendar day as an `<input type="date">` posts it. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The 403 for anyone without the right, and the 404 for a unit id that names no unit. */
const PAGE = {
	forbidden: m.adminOccupancies_forbidden,
	notFound: m.adminUnits_notFound
} satisfies PageMessages;

/**
 * The changes the complex refuses, each `fail(400, …)`, shared by all three actions.
 *
 * The errors below are all "you may do this, but not this particular one", which is what separates
 * them from a permission refusal — see `src/lib/errors.ts` on `LastSuperuserError` for the same
 * distinction drawn the first time. `PrimaryOccupantNotStartedError` answers both "Jadikan
 * penanggung jawab" on a stay that starts later and "Catat masa huni" with the box ticked for a start
 * day after today, and its message names that start day. `OccupancyOverlapError` carries one of two
 * things — `mustEndFirst` picks which message names it — never both: the earliest day a new stay may
 * start, or nothing at all when the conflicting stay has no last day yet to count from.
 */
const REFUSALS = [
	refusal(PrimaryOccupantNotStartedError, ({ error }) =>
		m.adminOccupancies_primaryNotStarted({ startedOn: error.startedOn })
	),
	refusal(PrimaryOccupantAlreadyEndedError, ({ error }) =>
		m.adminOccupancies_primaryAlreadyEnded({ endedOn: error.endedOn })
	),
	refusal(OccupancyDateOrderError, ({ error }) =>
		m.adminOccupancies_dateOrder({ startedOn: error.startedOn, endedOn: error.endedOn })
	),
	refusal(ResidentNotFoundError, m.adminOccupancies_residentNotFound),
	refusal(OccupancyOverlapError, ({ error }) =>
		error.mustEndFirst
			? m.adminOccupancies_overlapMustEnd()
			: m.adminOccupancies_overlap({ earliestStartedOn: error.earliestStartedOn ?? '' })
	),
	refusal(OccupancyEndOverlapError, ({ error }) =>
		m.adminOccupancies_endOverlap({
			latestEndedOn: error.latestEndedOn,
			nextStartedOn: error.nextStartedOn
		})
	)
];

/** `record`: it acts on the unit in the URL, so a missing row reads as the missing unit. */
const RECORD_FORM = {
	...PAGE,
	fallback: m.adminOccupancies_invalidForm,
	refusals: REFUSALS
} satisfies FormMessages;

/** `end` and `setPrimary`: they act on one Masa Huni, so a missing row reads as that Masa Huni. */
const OCCUPANCY_FORM = {
	...PAGE,
	notFound: m.adminOccupancies_notFound,
	fallback: m.adminOccupancies_invalidEndForm,
	refusals: REFUSALS
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	// `units.id` is a `uuid` column — see #111 and `#lib/server/services/identifier.ts`.
	const unitId = requireUuidParam(params.id, PAGE);

	const { db, clock } = productionDependencies();
	try {
		const [unit, occupancies, residents] = await Promise.all([
			getUnit(db, user.id, unitId, clock),
			listUnitOccupanciesGrouped(db, clock, user.id, unitId),
			listAssignableResidents(db, user.id)
		]);
		return { unit, occupancies, residents, roles: OCCUPANCY_ROLES };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	record: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const unitId = requireUuidParam(params.id, PAGE);

		const form = await request.formData();
		const residentId = readText(form, 'residentId');
		const role = readText(form, 'role');
		const startedOn = readText(form, 'startedOn');
		if (residentId === '' || !isOccupancyRole(role) || !CALENDAR_DAY.test(startedOn)) {
			return fail(400, { message: m.adminOccupancies_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			await recordOccupancy(db, clock, {
				actorId: user.id,
				unitId,
				residentId,
				role,
				startedOn,
				isPrimaryOccupant: form.get('isPrimaryOccupant') === 'true'
			});
		} catch (caught) {
			return failOrThrow(caught, RECORD_FORM);
		}
		return { message: m.adminOccupancies_addSuccess() };
	},

	end: async ({ locals, request }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const occupancyId = readText(form, 'occupancyId');
		const endedOn = readText(form, 'endedOn');
		if (occupancyId === '' || !CALENDAR_DAY.test(endedOn)) {
			return fail(400, { message: m.adminOccupancies_invalidEndForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			await endOccupancy(db, clock, {
				actorId: user.id,
				occupancyId,
				endedOn
			});
		} catch (caught) {
			return failOrThrow(caught, OCCUPANCY_FORM);
		}
		return { message: m.adminOccupancies_endSuccess() };
	},

	setPrimary: async ({ locals, request }) => {
		const user = requireUser(locals);

		const occupancyId = readText(await request.formData(), 'occupancyId');
		if (occupancyId === '') {
			return fail(400, { message: m.adminOccupancies_invalidEndForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			await setPrimaryOccupant(db, clock, {
				actorId: user.id,
				occupancyId
			});
		} catch (caught) {
			return failOrThrow(caught, OCCUPANCY_FORM);
		}
		return { message: m.adminOccupancies_setPrimarySuccess() };
	}
};

/** Whether `value` is one of the roles the schema's check constraint allows. */
function isOccupancyRole(value: string): value is OccupancyRole {
	return (OCCUPANCY_ROLES as readonly string[]).includes(value);
}
