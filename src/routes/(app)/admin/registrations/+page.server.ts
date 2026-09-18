import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS, readOrigin } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	approveRegistration,
	RegistrationAccountMissingError,
	RegistrationAlreadyDecidedError,
	RegistrationNotFoundError,
	listPendingRegistrations,
	rejectRegistration
} from '$lib/server/services/registration';
import { listUnits, UnitNotFoundError } from '$lib/server/services/unit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Pendaftaran: everything still waiting, what each claim turned out to
 * match, a unit picker that starts on the match and may be moved anywhere else, and a rejection that
 * has to carry a reason. Follows the guard shape `../invitations/+page.server.ts` settled — nobody
 * who is not signed in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)`
 * here, and every rule violation comes back as a rejected form.
 *
 * The approval email's link is built on `readOrigin()`, never on a request header a client could
 * bend.
 */

/**
 * How many units the picker asks for. The unit service reads one page at a time and this screen
 * needs the whole register at once; a komplek is a few hundred houses, so one oversized page is
 * honest and cheap — the same number and the same reasoning as the invitations screen.
 */
const UNIT_PICKER_PAGE_SIZE = 500;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const db = database();
		const [pending, unitPage] = await Promise.all([
			listPendingRegistrations(db, locals.user.id),
			listUnits(db, systemClock, {
				actorId: locals.user.id,
				pageSize: UNIT_PICKER_PAGE_SIZE
			})
		]);
		return {
			registrations: pending,
			units: unitPage.units.map((unit) => ({
				id: unit.id,
				block: unit.block,
				number: unit.number
			}))
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const registrationId = String(form.get('registrationId') ?? '').trim();
		const unitId = String(form.get('unitId') ?? '').trim();
		if (registrationId === '' || unitId === '') {
			return fail(400, { message: m.adminRegistrations_invalidForm() });
		}

		try {
			const approved = await approveRegistration(database(), systemClock, {
				actorId: locals.user.id,
				registrationId,
				unitId,
				origin: readOrigin()
			});
			return { message: m.adminRegistrations_approveSuccess({ email: approved.email }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	reject: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const registrationId = String(form.get('registrationId') ?? '').trim();
		const reason = String(form.get('reason') ?? '').trim();
		if (registrationId === '') {
			return fail(400, { message: m.adminRegistrations_invalidForm() });
		}
		if (reason === '') {
			return fail(400, { message: m.adminRegistrations_reasonRequired() });
		}

		try {
			const rejected = await rejectRegistration(database(), systemClock, {
				actorId: locals.user.id,
				registrationId,
				reason
			});
			return { message: m.adminRegistrations_rejectSuccess({ email: rejected.email }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	}
};

/**
 * Turns the refusals the registration service names into rejected forms, and everything else into a
 * route error. Shared by both actions because they can be refused for the same reasons.
 */
function failAsRejectedForm(caught: unknown) {
	if (caught instanceof RegistrationNotFoundError) {
		return fail(400, { message: m.adminRegistrations_notFound() });
	}
	if (caught instanceof RegistrationAlreadyDecidedError) {
		return fail(400, { message: m.adminRegistrations_alreadyDecided() });
	}
	if (caught instanceof RegistrationAccountMissingError) {
		return fail(400, { message: m.adminRegistrations_accountMissing({ email: caught.email }) });
	}
	if (caught instanceof UnitNotFoundError) {
		return fail(400, { message: m.adminRegistrations_unitNotFound() });
	}
	if (caught instanceof TypeError) {
		return fail(400, { message: m.adminRegistrations_invalidForm() });
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * `never`, so it can end a `catch` block without widening what SvelteKit infers — the same helper
 * the invitations screen carries, for the same reason.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminRegistrations_forbidden());
	}
	throw caught;
}
