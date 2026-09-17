import { fail } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * Proving that an address belongs to the person who typed it, and asking for another try.
 *
 * This one page answers four situations, because they are four sentences about the same thing and
 * splitting them across routes would only mean more addresses to get wrong:
 *
 * - arriving from the registration form, with nothing to verify yet (`?sent=1`);
 * - arriving from the email, with a token that works;
 * - arriving from the email too late, or with a token that has been tampered with;
 * - arriving from the sign-in form after being told the address is not verified yet.
 *
 * **Asking for another email says nothing about who is registered.** better-auth answers an
 * address that does not exist, an address that is already verified and an address that is waiting
 * for verification identically, and spends the same amount of time doing it. Whatever it reports,
 * this action shows the same sentence.
 *
 * Verifying does not sign anyone in — see the reasoning in `$lib/server/auth`. The page sends the
 * person to the sign-in form afterwards.
 *
 * **The `load` below changes something, on a GET.** That is what an emailed link is: the token in
 * the address is the whole of the authority, and the only thing the request can do with it is mark
 * one address proven. It is idempotent — a second visit finds the address already verified and
 * says the same thing — so a link scanner, a prefetch or the browser's back button replaying it
 * costs nothing. A verification token is a signed JWT rather than a stored row, so it stays usable
 * until it expires; nothing here can revoke one early, and the page must not claim otherwise.
 */

/** What this page is saying. The wording lives in the component; this is the situation. */
export type VerificationState = 'idle' | 'sent' | 'verified' | 'expired' | 'invalid';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	if (token === null) {
		return { state: (url.searchParams.has('sent') ? 'sent' : 'idle') satisfies VerificationState };
	}

	try {
		await auth().api.verifyEmail({ query: { token } });
	} catch (error) {
		if (!(error instanceof APIError)) {
			throw error;
		}
		const expired = error.body?.code === 'TOKEN_EXPIRED';
		return { state: (expired ? 'expired' : 'invalid') satisfies VerificationState };
	}

	return { state: 'verified' satisfies VerificationState };
};

export const actions: Actions = {
	resend: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();

		if (email === '') {
			return fail(400, { sent: false, message: 'Isi dulu alamat email Anda.' });
		}

		try {
			await auth().api.sendVerificationEmail({ body: { email }, headers: request.headers });
		} catch (error) {
			// Every answer better-auth can give about one address — it is unknown, it is already
			// verified, it has just been sent an email — leads to the same sentence below. Only a
			// failure that is not about the address at all, such as the database being unreachable,
			// is allowed to become an error page.
			if (!(error instanceof APIError)) {
				throw error;
			}
		}

		return {
			sent: true,
			message:
				'Kalau alamat itu terdaftar dan belum terverifikasi, email verifikasinya sudah kami kirim ulang. Periksa kotak masuk Anda.'
		};
	}
};
