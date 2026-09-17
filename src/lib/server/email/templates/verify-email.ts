import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that proves an address belongs to the person who typed it.
 *
 * Decisions settled here:
 *
 * - **The lifetime of the link is declared here, not in `../../auth.ts`.** The body of the email
 *   says out loud how long the link lasts, so the wording and the number have to be one thing;
 *   `createAuth` imports the constant below and hands it to better-auth. If the number lived at
 *   the call site, a change there would leave this text quietly lying to the reader.
 * - **Plain text, no HTML body.** The recipient's own name is rendered into the message, and a
 *   name is free text a person typed. A text-only email cannot carry markup out of it, so there
 *   is no escaping step to forget. Mailpit and every mail client show it fine.
 * - **The template checks what it was given.** The payload is read back out of a `jsonb` column,
 *   so it is `unknown` shaped data whatever the type said where it was queued. Throwing here is
 *   the right answer: the worker turns it into a `PermanentEmailError` and fails that one row
 *   rather than retrying a payload that will never render.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const VERIFY_EMAIL_KIND = 'verify-email';

/** How many seconds a verification link stays valid: one day. */
export const VERIFY_EMAIL_LIFETIME_SECONDS = 24 * 60 * 60;

/** Seconds in an hour, for turning the lifetime above into the number the email says. */
const SECONDS_PER_HOUR = 60 * 60;

/** What this email needs in order to be written. */
export interface VerifyEmailValues {
	/** The recipient's name, as they gave it when registering. */
	readonly name: string;
	/** The full address of the page that accepts the token. */
	readonly url: string;
}

/** Builds the payload for a queue row of kind `verify-email`. */
export function verifyEmailPayload(values: VerifyEmailValues): EmailPayload {
	return { name: values.name, url: values.url };
}

/** Writes the verification email. Indonesian, because a resident reads it. */
export const verifyEmailTemplate: EmailTemplate = (payload) => {
	const { name, url } = payload;
	if (typeof name !== 'string' || typeof url !== 'string') {
		throw new TypeError(
			`An email of kind "${VERIFY_EMAIL_KIND}" needs a name and a url, both strings.`
		);
	}

	const hours = VERIFY_EMAIL_LIFETIME_SECONDS / SECONDS_PER_HOUR;
	return {
		subject: 'Verifikasi alamat email Anda',
		text: [
			`Halo ${name},`,
			'',
			'Akun Anda di Sistem Informasi dan Manajemen Keuangan Komplek sudah dibuat. Buka tautan',
			'di bawah ini untuk memastikan alamat email ini benar milik Anda:',
			'',
			url,
			'',
			`Tautan ini berlaku ${hours} jam. Setelah alamat Anda terverifikasi, Anda bisa masuk`,
			'dengan email dan kata sandi yang tadi Anda pilih.',
			'',
			'Kalau Anda tidak merasa mendaftar, abaikan saja email ini; tanpa tautan itu diklik,',
			'akunnya tidak bisa dipakai.'
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const verifyEmailTemplates: EmailTemplates = {
	[VERIFY_EMAIL_KIND]: verifyEmailTemplate
};
