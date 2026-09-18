import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import * as m from '$lib/paraglide/messages';
import { AUTH_PATHS, MINIMUM_PASSWORD_LENGTH, auth } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { submitRegistration } from '$lib/server/services/registration';
import type { Actions, PageServerLoad } from './$types';

/**
 * Registering — signing up, and saying which house you live in.
 *
 * **The answer is the same whether or not the address was already registered.** better-auth does
 * that part: with `requireEmailVerification` on, a sign-up for an address that already exists
 * returns the same shape as a sign-up for a new one and sends no second email, so this form
 * cannot be used to find out who has an account here. That is also why the page it lands on says
 * "kalau alamat itu belum terdaftar" rather than "akun Anda sudah dibuat".
 *
 * **The Pendaftaran row must not give that property back**, which is why `submitRegistration`
 * returns nothing and swallows `registrations_pending_email_unique`: a second submission for an
 * address that is already waiting lands on the same page as a first one. See the doc comment on
 * `src/lib/server/services/registration/index.ts`.
 *
 * **The account is created first and the registration row second**, in that order and for the
 * reason that module records: `signUpEmail` runs outside any transaction here and cannot be rolled
 * back, so the failure this order leaves — an account with no registration — is one the person
 * leaves by submitting the form again, while the other order's failure is a waiting row that can
 * never be approved and can never be replaced.
 *
 * **The claimed house grants nothing.** It is stored as typed, checked against no table, and a
 * superuser decides what it is worth — see `spec-warga-unit-v1.md`: "klaim rumah yang tidak
 * diperiksa memberi orang asing akses ke laporan keuangan dan daftar warga".
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
		const claimedBlock = String(form.get('claimedBlock') ?? '').trim();
		const claimedNumber = String(form.get('claimedNumber') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const passwordAgain = String(form.get('passwordAgain') ?? '');

		const submitted = { name, email, claimedBlock, claimedNumber };
		const complaint = whatIsWrong({ ...submitted, password, passwordAgain });
		if (complaint) {
			return fail(400, { ...submitted, message: complaint });
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
				...submitted,
				message:
					'Pendaftaran tidak bisa diproses. Periksa lagi alamat email dan kata sandi yang Anda isi.'
			});
		}

		await submitRegistration(database(), systemClock, submitted);

		redirect(303, CHECK_YOUR_EMAIL);
	}
};

/** What the person filled in, before anything has been checked. */
interface RegistrationForm {
	readonly name: string;
	readonly email: string;
	readonly claimedBlock: string;
	readonly claimedNumber: string;
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
	if (form.claimedBlock === '' || form.claimedNumber === '') {
		return m.register_claimMissing();
	}
	if (form.password.length < MINIMUM_PASSWORD_LENGTH) {
		return `Kata sandi harus terdiri dari sedikitnya ${MINIMUM_PASSWORD_LENGTH} karakter.`;
	}
	if (form.password !== form.passwordAgain) {
		return 'Kedua kata sandi yang Anda isi tidak sama.';
	}
	return undefined;
}
