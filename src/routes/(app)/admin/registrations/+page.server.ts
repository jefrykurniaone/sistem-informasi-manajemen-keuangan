import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { readOrigin } from '#lib/server/auth.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	approveRegistration,
	RegistrationAccountMissingError,
	RegistrationAlreadyDecidedError,
	RegistrationNotFoundError,
	listPendingRegistrations,
	rejectRegistration
} from '#lib/server/services/registration/index.ts';
import { listUnits, UnitNotFoundError } from '#lib/server/services/unit/index.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Pendaftaran: everything still waiting, what each claim turned out to
 * match, a unit picker that starts on the match and may be moved anywhere else, and a rejection that
 * has to carry a reason. Nobody who is not signed in reaches the service layer,
 * `PermissionDeniedError` becomes `error(403, …)` here, and every rule violation comes back as a
 * rejected form. All three go through `#lib/server/route-action.ts` (#318).
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

/** The page's own refusal: the 403 for anyone without the right. There is no 404 page. */
const PAGE = { forbidden: m.adminRegistrations_forbidden } satisfies PageMessages;

/**
 * The refusals the registration service names, answered as rejected forms. Shared by both actions
 * because they can be refused for the same reasons. A `TypeError` is the service refusing what was
 * posted, which this screen has always answered with its invalid-form sentence.
 */
const FORM = {
	...PAGE,
	fallback: m.adminRegistrations_invalidForm,
	refusals: [
		refusal(RegistrationNotFoundError, m.adminRegistrations_notFound),
		refusal(RegistrationAlreadyDecidedError, m.adminRegistrations_alreadyDecided),
		refusal(RegistrationAccountMissingError, ({ error }) =>
			m.adminRegistrations_accountMissing({ email: error.email })
		),
		refusal(UnitNotFoundError, m.adminRegistrations_unitNotFound),
		refusal(TypeError, m.adminRegistrations_invalidForm)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	try {
		const { db, clock } = productionDependencies();
		const [pending, unitPage] = await Promise.all([
			listPendingRegistrations(db, user.id),
			listUnits(db, clock, {
				actorId: user.id,
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
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const registrationId = readText(form, 'registrationId');
		const unitId = readText(form, 'unitId');
		if (registrationId === '' || unitId === '') {
			return fail(400, { message: m.adminRegistrations_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const approved = await approveRegistration(db, clock, {
				actorId: user.id,
				registrationId,
				unitId,
				origin: readOrigin()
			});
			return { message: m.adminRegistrations_approveSuccess({ email: approved.email }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	},

	reject: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const registrationId = readText(form, 'registrationId');
		const reason = readText(form, 'reason');
		if (registrationId === '') {
			return fail(400, { message: m.adminRegistrations_invalidForm() });
		}
		if (reason === '') {
			return fail(400, { message: m.adminRegistrations_reasonRequired() });
		}

		const { db, clock } = productionDependencies();
		try {
			const rejected = await rejectRegistration(db, clock, {
				actorId: user.id,
				registrationId,
				reason
			});
			return { message: m.adminRegistrations_rejectSuccess({ email: rejected.email }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	}
};
