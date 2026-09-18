import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS, readOrigin } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	InvitationEmailAlreadyRegisteredError,
	InvitationNotFoundError,
	InvitationUsedError,
	listInvitations,
	resendInvitation,
	sendInvitations
} from '$lib/server/services/invitation';
import { listUnits, UnitNotFoundError } from '$lib/server/services/unit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Undangan: one form to invite one address to one unit, one form that
 * walks the whole unit list, and the history of every link ever sent with a resend button on the
 * ones that are still unused. Follows the guard shape `../units/+page.server.ts` settled — nobody
 * who is not signed in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)`
 * here, and every rule violation comes back as a rejected form.
 *
 * The links are built on `readOrigin()`, never on a request header a client could bend.
 */

/**
 * How many units the pickers ask for. The unit service reads one page at a time and this screen
 * needs the whole register at once; a komplek is a few hundred houses, so one oversized page is
 * honest and cheap. A register that outgrows this needs a searchable picker, not a bigger number.
 */
const UNIT_PICKER_PAGE_SIZE = 500;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const db = database();
		const [invitationEntries, unitPage] = await Promise.all([
			listInvitations(db, systemClock, locals.user.id),
			listUnits(db, systemClock, {
				actorId: locals.user.id,
				pageSize: UNIT_PICKER_PAGE_SIZE
			})
		]);
		return {
			invitations: invitationEntries,
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
	send: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const unitId = String(form.get('unitId') ?? '').trim();
		if (email === '' || unitId === '') {
			return fail(400, { message: m.adminInvitations_invalidForm() });
		}

		try {
			await sendInvitations(database(), systemClock, {
				actorId: locals.user.id,
				origin: readOrigin(),
				recipients: [{ email, unitId }]
			});
			return { message: m.adminInvitations_sendSuccess({ email }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	sendMany: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const recipients = pairedRecipients(form.getAll('unitId'), form.getAll('email'));
		if (recipients.length === 0) {
			return fail(400, { message: m.adminInvitations_bulkEmpty() });
		}

		try {
			const sent = await sendInvitations(database(), systemClock, {
				actorId: locals.user.id,
				origin: readOrigin(),
				recipients
			});
			return { message: m.adminInvitations_bulkSuccess({ count: sent.length }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	resend: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const invitationId = String(form.get('invitationId') ?? '').trim();
		if (invitationId === '') {
			return fail(400, { message: m.adminInvitations_invalidForm() });
		}

		try {
			const sent = await resendInvitation(database(), systemClock, {
				actorId: locals.user.id,
				invitationId,
				origin: readOrigin()
			});
			return { message: m.adminInvitations_resendSuccess({ email: sent.email }) };
		} catch (caught) {
			if (caught instanceof InvitationNotFoundError) {
				return fail(400, { message: m.adminInvitations_resendNotFound() });
			}
			if (caught instanceof InvitationUsedError) {
				return fail(400, { message: m.adminInvitations_resendUsed() });
			}
			return failAsRejectedForm(caught);
		}
	}
};

/**
 * The (unit, email) pairs of the bulk form, matched by index — every unit row submits its hidden
 * `unitId`, so the two lists are always the same length — keeping only the rows whose email was
 * filled in.
 */
function pairedRecipients(
	unitIds: FormDataEntryValue[],
	emails: FormDataEntryValue[]
): { email: string; unitId: string }[] {
	const recipients: { email: string; unitId: string }[] = [];
	for (const [index, unitId] of unitIds.entries()) {
		const email = String(emails[index] ?? '').trim();
		if (email !== '' && String(unitId).trim() !== '') {
			recipients.push({ email, unitId: String(unitId).trim() });
		}
	}
	return recipients;
}

/**
 * Turns the refusals the invitation service names into rejected forms, and everything else into a
 * route error. Shared by the three actions because they can all be refused for the same reasons.
 */
function failAsRejectedForm(caught: unknown) {
	if (caught instanceof InvitationEmailAlreadyRegisteredError) {
		return fail(400, { message: m.adminInvitations_alreadyRegistered({ email: caught.email }) });
	}
	if (caught instanceof UnitNotFoundError) {
		return fail(400, { message: m.adminInvitations_unitNotFound() });
	}
	if (caught instanceof TypeError) {
		return fail(400, { message: m.adminInvitations_invalidForm() });
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * `never`, so it can end a `catch` block without widening what SvelteKit infers — the same helper
 * the units screen carries, for the same reason.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminInvitations_forbidden());
	}
	throw caught;
}
