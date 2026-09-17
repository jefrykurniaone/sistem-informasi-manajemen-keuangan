import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { AUTH_PATHS, MINIMUM_PASSWORD_LENGTH, auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * Choosing a new password with the token from a reset email.
 *
 * The token arrives in the address bar and is carried into the form as a hidden field, so the
 * password and the token reach the server in one POST. It is never put back into a link and never
 * appears in a redirect, so it does not travel any further than it already has.
 *
 * Whether the token is any good is decided once, by better-auth, at the moment the new password
 * is submitted: it looks the row up and deletes it in the same transaction, which is what makes a
 * reset link work exactly once. A link that has been used and a link that has expired are both
 * simply not there any more, and the page says so the same way for both — there is nothing useful
 * to tell apart, and guessing at the difference would mean holding on to spent tokens to check
 * against.
 *
 * Every other session belonging to this person is revoked as part of the reset; see
 * `$lib/server/auth`.
 */

/** Where a finished reset lands, with a note for the sign-in page to show. */
const SIGN_IN_AGAIN = `${AUTH_PATHS.login}?reset=1`;

/** Said for a token that is spent, expired, or was never real. */
const LINK_NO_LONGER_WORKS =
	'Tautan ini sudah tidak berlaku. Tautan pemulihan hanya bisa dipakai sekali dan kedaluwarsa satu jam setelah diminta. Minta tautan baru di halaman lupa kata sandi.';

export const load: PageServerLoad = ({ url }) => {
	return {
		token: url.searchParams.get('token') ?? '',
		minimumPasswordLength: MINIMUM_PASSWORD_LENGTH
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const token = String(form.get('token') ?? '');
		const password = String(form.get('password') ?? '');
		const passwordAgain = String(form.get('passwordAgain') ?? '');

		if (token === '') {
			return fail(400, { message: LINK_NO_LONGER_WORKS });
		}
		if (password.length < MINIMUM_PASSWORD_LENGTH) {
			return fail(400, {
				message: `Kata sandi harus terdiri dari sedikitnya ${MINIMUM_PASSWORD_LENGTH} karakter.`
			});
		}
		if (password !== passwordAgain) {
			return fail(400, { message: 'Kedua kata sandi yang Anda isi tidak sama.' });
		}

		try {
			await auth().api.resetPassword({ body: { token, newPassword: password } });
		} catch (error) {
			if (!(error instanceof APIError)) {
				throw error;
			}
			return fail(400, { message: LINK_NO_LONGER_WORKS });
		}

		redirect(303, SIGN_IN_AGAIN);
	}
};
