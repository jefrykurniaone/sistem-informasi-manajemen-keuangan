import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that lets someone who has forgotten their password choose a new one.
 *
 * The same three decisions as `./verify-email.ts` apply: the lifetime is declared here because the
 * body states it, the body is plain text because it renders a name a person typed, and the
 * template refuses a payload that is not shaped the way it expects.
 *
 * One decision of its own: **the email says the link is single use, and that is a fact about the
 * database, not a promise.** better-auth stores the token as a row in `verification` and consumes
 * that row when the link is used, so a second use finds nothing and is refused. See
 * `src/lib/server/db/schema/auth.ts`.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const PASSWORD_RESET_KIND = 'password-reset';

/** How many seconds a reset link stays valid: one hour. */
export const PASSWORD_RESET_LIFETIME_SECONDS = 60 * 60;

/** Seconds in an hour, for turning the lifetime above into the number the email says. */
const SECONDS_PER_HOUR = 60 * 60;

/** What this email needs in order to be written. */
export interface PasswordResetValues {
	/** The recipient's name, as it stands on their account. */
	readonly name: string;
	/** The full address of the page that accepts the token. */
	readonly url: string;
}

/** Builds the payload for a queue row of kind `password-reset`. */
export function passwordResetPayload(values: PasswordResetValues): EmailPayload {
	return { name: values.name, url: values.url };
}

/** Writes the password reset email. Indonesian, because a resident reads it. */
export const passwordResetTemplate: EmailTemplate = (payload) => {
	const { name, url } = payload;
	if (typeof name !== 'string' || typeof url !== 'string') {
		throw new TypeError(
			`An email of kind "${PASSWORD_RESET_KIND}" needs a name and a url, both strings.`
		);
	}

	const hours = PASSWORD_RESET_LIFETIME_SECONDS / SECONDS_PER_HOUR;
	return {
		subject: 'Atur ulang kata sandi Anda',
		text: [
			`Halo ${name},`,
			'',
			'Ada permintaan untuk mengatur ulang kata sandi akun Anda di Sistem Informasi dan',
			'Manajemen Keuangan Komplek. Buka tautan di bawah ini untuk memilih kata sandi baru:',
			'',
			url,
			'',
			`Tautan ini berlaku ${hours} jam dan hanya bisa dipakai sekali. Setelah kata sandi Anda`,
			'diganti, semua perangkat yang masih masuk ke akun ini akan dikeluarkan.',
			'',
			'Kalau bukan Anda yang meminta, abaikan saja email ini. Kata sandi Anda tidak berubah',
			'selama tautan itu tidak dibuka.'
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const passwordResetTemplates: EmailTemplates = {
	[PASSWORD_RESET_KIND]: passwordResetTemplate
};
