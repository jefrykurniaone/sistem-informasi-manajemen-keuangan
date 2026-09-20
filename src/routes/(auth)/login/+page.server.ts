import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { auth } from '$lib/server/auth';
import { forgiveEmail, limitFormAction, RATE_LIMIT_POLICY } from '$lib/server/rate-limit';
import type { Actions, PageServerLoad } from './$types';

/**
 * Signing in.
 *
 * The form posts to a SvelteKit action rather than to better-auth over `fetch`, so the flow works
 * with JavaScript turned off and so that the response that sets the session cookie is the same
 * one that redirects. `sveltekitCookies` in `$lib/server/auth` is what copies the cookie onto it.
 *
 * Two failures are told apart on purpose, and only two:
 *
 * - **An unverified address** gets its own answer, because the person has done nothing wrong and
 *   the only way forward is a new verification email. Saying so reveals that the address is
 *   registered — which the person in front of the form already knows, since they just proved they
 *   hold the password for it. better-auth checks the password before it checks verification.
 * - **Anything else** is one message: wrong address and wrong password read the same, so the form
 *   cannot be used to find out which addresses exist. better-auth helps here too — it hashes a
 *   password even when it found no user, so the two answers also take the same time.
 *
 * **Too many attempts is refused before better-auth is asked anything.** `limitFormAction` in
 * `$lib/server/rate-limit` counts the caller's address and the email typed, and a request over
 * either limit gets `TOO_MANY_ATTEMPTS` with a 429 — the same sentence, the same status and the
 * same amount of work whether the address is registered or not, because the limiter never looks
 * it up. That ordering is the point: a refused guess costs no scrypt and reveals nothing. A
 * successful sign-in forgives the email's bucket, so a resident who mistyped a few times is not
 * still penalised after they got it right; the reasoning is in that module's header.
 *
 * There is no session to fixate: better-auth writes a new row with a new token on every sign-in
 * and never reuses whatever token the browser arrived holding.
 */

/** Where signing in lands. */
const HOME_PATH = '/';

/** Shown when the address or the password is wrong, without saying which. */
const WRONG_CREDENTIALS = 'Email atau kata sandi salah.';

/** Shown when the limiter refuses, whoever the address belongs to. */
const TOO_MANY_ATTEMPTS = 'Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) {
		redirect(303, HOME_PATH);
	}
	return {
		/** Set after a password has just been changed, so the page can say so. */
		passwordChanged: url.searchParams.has('reset')
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (email === '' || password === '') {
			return fail(400, {
				email,
				unverified: false,
				message: 'Email dan kata sandi harus diisi.'
			});
		}

		const decision = await limitFormAction(event, RATE_LIMIT_POLICY.login, email);
		if (!decision.allowed) {
			return fail(429, { email, unverified: false, message: TOO_MANY_ATTEMPTS });
		}

		try {
			await auth().api.signInEmail({
				body: { email, password },
				headers: event.request.headers
			});
		} catch (error) {
			if (!(error instanceof APIError)) {
				throw error;
			}
			if (error.body?.code === 'EMAIL_NOT_VERIFIED') {
				return fail(403, {
					email,
					unverified: true,
					message:
						'Alamat email ini belum diverifikasi, jadi akunnya belum bisa dipakai. Kirim ulang email verifikasinya, lalu buka tautan di dalamnya.'
				});
			}
			return fail(400, { email, unverified: false, message: WRONG_CREDENTIALS });
		}

		await forgiveEmail(RATE_LIMIT_POLICY.login, email);
		redirect(303, HOME_PATH);
	}
};
