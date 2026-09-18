import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import * as m from '$lib/paraglide/messages';
import { auth, MINIMUM_PASSWORD_LENGTH } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	acceptInvitation,
	inspectInvitation,
	InvitationEmailAlreadyRegisteredError,
	InvitationExpiredError,
	InvitationTokenUnknownError,
	InvitationUsedError,
	passwordHasherOf
} from '$lib/server/services/invitation';
import type { Actions, PageServerLoad } from './$types';

/**
 * Redeeming an invitation: the one page a person can open without an account, because the token in
 * the address is itself the authorization — no session check, exactly like `../../set-password`.
 *
 * The token arrives as the path segment and is carried into the form as a hidden field, so the
 * name, the password and the token reach the server in one POST. It is never rendered into the
 * page's text and never put into a link, so it travels no further than it already has.
 *
 * The GET only chooses what to show — the form, or one of three distinct refusals
 * (`spec-warga-unit-v1.md` asks for "alasan berbeda yang bisa dibedakan"). Every decision is made
 * again by `acceptInvitation` at the moment of the POST, inside one transaction.
 *
 * A successful acceptance ends with an ordinary password sign-in through `auth().api.signInEmail`
 * and a redirect to the resident's own house. That is deliberately not a session minted from the
 * link: the person just typed the very password being checked, so this is the same act as signing
 * in on the login page — decision 6 in `$lib/server/auth` (a link must not mint a session) is not
 * bent here.
 */

/** Where a freshly accepted invitation lands: the house the invitation was about. */
const MY_UNIT = '/my-unit';

export const load: PageServerLoad = async ({ params }) => {
	return {
		token: params.token,
		inspection: await inspectInvitation(database(), systemClock, params.token),
		minimumPasswordLength: MINIMUM_PASSWORD_LENGTH
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const token = String(form.get('token') ?? '');
		const name = String(form.get('name') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const passwordAgain = String(form.get('passwordAgain') ?? '');

		if (token === '') {
			return fail(400, { message: m.invitationAccept_unknown() });
		}
		if (name === '') {
			return fail(400, { message: m.invitationAccept_invalidName() });
		}
		if (password.length < MINIMUM_PASSWORD_LENGTH) {
			return fail(400, {
				message: m.invitationAccept_passwordTooShort({ min: MINIMUM_PASSWORD_LENGTH })
			});
		}
		if (password !== passwordAgain) {
			return fail(400, { message: m.invitationAccept_passwordMismatch() });
		}

		let email: string;
		try {
			const accepted = await acceptInvitation(database(), systemClock, {
				token,
				name,
				password,
				hashPassword: passwordHasherOf(auth())
			});
			email = accepted.email;
		} catch (caught) {
			return failAsRejectedForm(caught);
		}

		try {
			await auth().api.signInEmail({ body: { email, password } });
		} catch (caught) {
			if (!(caught instanceof APIError)) {
				throw caught;
			}
			// The account exists and the password is set; only the sign-in hiccuped. The login page
			// is the honest place to try again.
			redirect(303, '/login');
		}

		redirect(303, MY_UNIT);
	}
};

/** The three token refusals and the taken-address one, each as its own Indonesian sentence. */
function failAsRejectedForm(caught: unknown) {
	if (caught instanceof InvitationTokenUnknownError) {
		return fail(400, { message: m.invitationAccept_unknown() });
	}
	if (caught instanceof InvitationUsedError) {
		return fail(400, { message: m.invitationAccept_used() });
	}
	if (caught instanceof InvitationExpiredError) {
		return fail(400, { message: m.invitationAccept_expired() });
	}
	if (caught instanceof InvitationEmailAlreadyRegisteredError) {
		return fail(400, { message: m.invitationAccept_registered() });
	}
	throw caught;
}
