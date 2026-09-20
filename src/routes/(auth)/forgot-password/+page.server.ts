import { fail } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { auth } from '$lib/server/auth';
import { limitFormAction, RATE_LIMIT_POLICY } from '$lib/server/rate-limit';
import type { Actions } from './$types';

/**
 * Asking for a password reset link.
 *
 * **The answer never depends on whether the address is registered.** One sentence covers both
 * cases, and better-auth does the rest: for an address it does not know it still generates a
 * token and still reads the verification table, so the two answers take about the same time as
 * well as saying the same words. Nothing is returned that a script could tell apart.
 *
 * **Too many requests is refused before better-auth is asked anything**, by `limitFormAction` in
 * `$lib/server/rate-limit`, which counts the caller's address and the email typed without looking
 * either up. Every post past the limit gets `TOO_MANY_REQUESTS` and a 429, registered address or
 * not, and queues nothing: without that, this form is a way to send mail in the complex's name to
 * any resident, as often as one likes, and to grow `email_queue` without ever signing in.
 *
 * The link itself is what carries the security of this flow, and three properties of it are
 * settled elsewhere: it is 24 random characters from a cryptographic generator, it is stored as a
 * row that is deleted when it is used, and it expires an hour after it is asked for. See
 * `src/lib/server/email/templates/password-reset.ts` and `src/lib/server/db/schema/auth.ts`.
 */

/** Said whether or not the address is registered. */
const SAME_ANSWER_EITHER_WAY =
	'Kalau alamat itu terdaftar, kami sudah mengirim tautan untuk mengatur ulang kata sandi ke sana. Tautannya berlaku satu jam dan hanya bisa dipakai sekali.';

/** Shown when the limiter refuses, whoever the address belongs to. */
const TOO_MANY_REQUESTS =
	'Terlalu banyak permintaan tautan. Tunggu beberapa menit, lalu coba lagi.';

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '').trim();

		if (email === '') {
			return fail(400, { sent: false, message: 'Isi dulu alamat email Anda.' });
		}

		const decision = await limitFormAction(event, RATE_LIMIT_POLICY.forgotPassword, email);
		if (!decision.allowed) {
			return fail(429, { sent: false, message: TOO_MANY_REQUESTS });
		}

		try {
			await auth().api.requestPasswordReset({
				body: { email },
				headers: event.request.headers
			});
		} catch (error) {
			// Anything better-auth has to say about this address is deliberately swallowed; only a
			// failure that is not about the address becomes an error page.
			if (!(error instanceof APIError)) {
				throw error;
			}
		}

		return { sent: true, message: SAME_ANSWER_EITHER_WAY };
	}
};
