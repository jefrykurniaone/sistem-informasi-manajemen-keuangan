import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import * as m from '#lib/paraglide/messages.js';
import {
	auth,
	checkPassword,
	MAXIMUM_PASSWORD_LENGTH,
	MINIMUM_PASSWORD_LENGTH
} from '#lib/server/auth.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	type FormMessages
} from '#lib/server/route-action.ts';
import {
	acceptInvitation,
	inspectInvitation,
	InvitationEmailAlreadyRegisteredError,
	InvitationExpiredError,
	InvitationTokenUnknownError,
	InvitationUsedError,
	passwordHasherOf
} from '#lib/server/services/invitation/index.ts';
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
 * in on the login page — decision 6 in `#lib/server/auth.ts` (a link must not mint a session) is not
 * bent here.
 *
 * A refused acceptance goes through `#lib/server/route-action.ts` (#318), but without its session
 * guard: there is no session here to require.
 */

/** Where a freshly accepted invitation lands: the house the invitation was about. */
const MY_UNIT = '/my-unit';

/**
 * The three token refusals and the taken-address one, each as its own Indonesian sentence.
 *
 * `forbidden` and `fallback` have to name a sentence, and this page has none of its own for either:
 * nothing here calls `requirePermission`, and every refusal `acceptInvitation` makes is named below.
 * Both say the link was not recognised, the safe answer to a token this page cannot redeem.
 */
const FORM = {
	forbidden: m.invitationAccept_unknown,
	fallback: m.invitationAccept_unknown,
	refusals: [
		refusal(InvitationTokenUnknownError, m.invitationAccept_unknown),
		refusal(InvitationUsedError, m.invitationAccept_used),
		refusal(InvitationExpiredError, m.invitationAccept_expired),
		refusal(InvitationEmailAlreadyRegisteredError, m.invitationAccept_registered)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ params }) => {
	const { db, clock } = productionDependencies();
	return {
		token: params.token,
		inspection: await inspectInvitation(db, clock, params.token),
		minimumPasswordLength: MINIMUM_PASSWORD_LENGTH
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const token = String(form.get('token') ?? '');
		const name = readText(form, 'name');
		const password = String(form.get('password') ?? '');
		const passwordAgain = String(form.get('passwordAgain') ?? '');

		if (token === '') {
			return fail(400, { message: m.invitationAccept_unknown() });
		}
		if (name === '') {
			return fail(400, { message: m.invitationAccept_invalidName() });
		}
		const verdict = checkPassword(password);
		if (verdict === 'tooShort') {
			return fail(400, {
				message: m.invitationAccept_passwordTooShort({ min: MINIMUM_PASSWORD_LENGTH })
			});
		}
		if (verdict === 'tooLong') {
			return fail(400, {
				message: m.invitationAccept_passwordTooLong({ max: MAXIMUM_PASSWORD_LENGTH })
			});
		}
		if (verdict === 'tooCommon') {
			return fail(400, { message: m.invitationAccept_passwordTooCommon() });
		}
		if (password !== passwordAgain) {
			return fail(400, { message: m.invitationAccept_passwordMismatch() });
		}

		let email: string;
		const { db, clock } = productionDependencies();
		try {
			const accepted = await acceptInvitation(db, clock, {
				token,
				name,
				password,
				hashPassword: passwordHasherOf(auth())
			});
			email = accepted.email;
		} catch (caught) {
			return failOrThrow(caught, FORM);
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
