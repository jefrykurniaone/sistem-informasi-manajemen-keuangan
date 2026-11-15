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
	InvitationEmailAlreadyRegisteredError,
	InvitationNotFoundError,
	InvitationUsedError,
	listInvitations,
	resendInvitation,
	sendInvitations
} from '#lib/server/services/invitation/index.ts';
import { listUnits, UnitNotFoundError } from '#lib/server/services/unit/index.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Undangan: one form to invite one address to one unit, one form that
 * walks the whole unit list, and the history of every link ever sent with a resend button on the
 * ones that are still unused. Nobody who is not signed in reaches the service layer,
 * `PermissionDeniedError` becomes `error(403, …)` here, and every rule violation comes back as a
 * rejected form. All three go through `#lib/server/route-action.ts` (#318).
 *
 * The links are built on `readOrigin()`, never on a request header a client could bend.
 */

/**
 * How many units the pickers ask for. The unit service reads one page at a time and this screen
 * needs the whole register at once; a komplek is a few hundred houses, so one oversized page is
 * honest and cheap. A register that outgrows this needs a searchable picker, not a bigger number.
 */
const UNIT_PICKER_PAGE_SIZE = 500;

/** The page's own refusal: the 403 for anyone without the right. There is no 404 page. */
const PAGE = { forbidden: m.adminInvitations_forbidden } satisfies PageMessages;

/**
 * The refusals the invitation service names, answered as rejected forms. Shared by the three actions
 * because they can all be refused for the same reasons. A `TypeError` is the service refusing an
 * address it cannot use, which this screen has always answered with its invalid-form sentence.
 */
const REFUSALS = [
	refusal(InvitationEmailAlreadyRegisteredError, ({ error }) =>
		m.adminInvitations_alreadyRegistered({ email: error.email })
	),
	refusal(UnitNotFoundError, m.adminInvitations_unitNotFound),
	refusal(TypeError, m.adminInvitations_invalidForm)
];

/** `send` and `sendMany`. */
const FORM = {
	...PAGE,
	fallback: m.adminInvitations_invalidForm,
	refusals: REFUSALS
} satisfies FormMessages;

/** `resend`, which answers a missing or already used invitation with its own sentences first. */
const RESEND_FORM = {
	...FORM,
	refusals: [
		refusal(InvitationNotFoundError, m.adminInvitations_resendNotFound),
		refusal(InvitationUsedError, m.adminInvitations_resendUsed),
		...REFUSALS
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	try {
		const { db, clock } = productionDependencies();
		const [invitationEntries, unitPage] = await Promise.all([
			listInvitations(db, clock, user.id),
			listUnits(db, clock, {
				actorId: user.id,
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
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	send: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const email = readText(form, 'email');
		const unitId = readText(form, 'unitId');
		if (email === '' || unitId === '') {
			return fail(400, { message: m.adminInvitations_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			await sendInvitations(db, clock, {
				actorId: user.id,
				origin: readOrigin(),
				recipients: [{ email, unitId }]
			});
			return { message: m.adminInvitations_sendSuccess({ email }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	},

	sendMany: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const recipients = pairedRecipients(form.getAll('unitId'), form.getAll('email'));
		if (recipients.length === 0) {
			return fail(400, { message: m.adminInvitations_bulkEmpty() });
		}

		const { db, clock } = productionDependencies();
		try {
			const sent = await sendInvitations(db, clock, {
				actorId: user.id,
				origin: readOrigin(),
				recipients
			});
			return { message: m.adminInvitations_bulkSuccess({ count: sent.length }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	},

	resend: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const invitationId = readText(form, 'invitationId');
		if (invitationId === '') {
			return fail(400, { message: m.adminInvitations_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const sent = await resendInvitation(db, clock, {
				actorId: user.id,
				invitationId,
				origin: readOrigin()
			});
			return { message: m.adminInvitations_resendSuccess({ email: sent.email }) };
		} catch (caught) {
			return failOrThrow(caught, RESEND_FORM);
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
