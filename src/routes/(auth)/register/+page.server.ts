import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { AUTH_PATHS, MINIMUM_PASSWORD_LENGTH, auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * Registering.
 *
 * **The answer is the same whether or not the address was already registered.** better-auth does
 * that part: with `requireEmailVerification` on, a sign-up for an address that already exists
 * returns the same shape as a sign-up for a new one and sends no second email, so this form
 * cannot be used to find out who has an account here. That is also why the page it lands on says
 * "kalau alamat itu belum terdaftar" rather than "akun Anda sudah dibuat".
 *
 * The password is checked for length here as well as by better-auth, so that the person reads an
 * Indonesian sentence rather than an English error code. better-auth remains the authority: it
 * refuses a short password whatever this file forgets. The address is *not* checked here — one
 * definition of a valid email address is enough, and better-auth's is the one that decides.
 */

/** Where an accepted registration lands: the page that says to go and read the email. */
const CHECK_YOUR_EMAIL = `${AUTH_PATHS.verify}?sent=1`;

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) {
		redirect(303, '/');
	}
	return { minimumPasswordLength: MINIMUM_PASSWORD_LENGTH };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const passwordAgain = String(form.get('passwordAgain') ?? '');

		const complaint = whatIsWrong({ name, email, password, passwordAgain });
		if (complaint) {
			return fail(400, { name, email, message: complaint });
		}

		try {
			await auth().api.signUpEmail({
				body: { name, email, password },
				headers: request.headers
			});
		} catch (error) {
			if (!(error instanceof APIError)) {
				throw error;
			}
			return fail(400, {
				name,
				email,
				message:
					'Pendaftaran tidak bisa diproses. Periksa lagi alamat email dan kata sandi yang Anda isi.'
			});
		}

		redirect(303, CHECK_YOUR_EMAIL);
	}
};

/** What the person filled in, before anything has been checked. */
interface RegistrationForm {
	readonly name: string;
	readonly email: string;
	readonly password: string;
	readonly passwordAgain: string;
}

/**
 * The first thing wrong with a registration, in Indonesian, or `undefined` when nothing is.
 *
 * Split out so that the action stays one straight line of work: read the form, check it, hand it
 * over, redirect.
 */
function whatIsWrong(form: RegistrationForm): string | undefined {
	if (form.name === '' || form.email === '' || form.password === '') {
		return 'Nama, alamat email, dan kata sandi harus diisi.';
	}
	if (form.password.length < MINIMUM_PASSWORD_LENGTH) {
		return `Kata sandi harus terdiri dari sedikitnya ${MINIMUM_PASSWORD_LENGTH} karakter.`;
	}
	if (form.password !== form.passwordAgain) {
		return 'Kedua kata sandi yang Anda isi tidak sama.';
	}
	return undefined;
}
