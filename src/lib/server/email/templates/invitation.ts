import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that invites someone to become a resident: it carries the one link that lets them set
 * their own password and be attached to their house.
 *
 * The same three decisions as `./verify-email.ts` apply: the lifetime is declared here because the
 * body states it and the service that stamps `expiresAt` imports the same constant — the wording
 * and the number are one thing; the body is plain text because it renders a block and number a
 * person typed; and the template refuses a payload that is not shaped the way it expects, so the
 * worker fails that one row permanently rather than retrying a payload that will never render.
 *
 * One decision of its own: **the recipient is not addressed by name.** An invitation may be sent to
 * an address the application knows nothing else about — no account, no name — so the greeting is
 * generic rather than rendered from a value that often does not exist.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const INVITATION_KIND = 'invitation';

/** How many days an invitation link stays valid: seven, as `spec-warga-unit-v1.md` fixes it. */
export const INVITATION_LIFETIME_DAYS = 7;

/** What this email needs in order to be written. */
export interface InvitationEmailValues {
	/** The full address of the page that accepts the token. */
	readonly url: string;
	/** The block of the house the invitation is about. */
	readonly block: string;
	/** The house number inside that block. */
	readonly number: string;
}

/** Builds the payload for a queue row of kind `invitation`. */
export function invitationPayload(values: InvitationEmailValues): EmailPayload {
	return { url: values.url, block: values.block, number: values.number };
}

/** Writes the invitation email. Indonesian, because a resident reads it. */
export const invitationTemplate: EmailTemplate = (payload) => {
	const { url, block, number } = payload;
	if (typeof url !== 'string' || typeof block !== 'string' || typeof number !== 'string') {
		throw new TypeError(
			`An email of kind "${INVITATION_KIND}" needs a url, a block and a number, all strings.`
		);
	}

	return {
		subject: 'Undangan menjadi warga terdaftar',
		text: [
			'Halo,',
			'',
			'Pengurus Sistem Informasi dan Manajemen Keuangan Komplek mengundang Anda sebagai warga',
			`rumah blok ${block} nomor ${number}. Buka tautan di bawah ini untuk menetapkan kata sandi`,
			'Anda sendiri — pengurus tidak pernah tahu kata sandi Anda:',
			'',
			url,
			'',
			`Tautan ini berlaku ${INVITATION_LIFETIME_DAYS} hari dan hanya bisa dipakai sekali. Kalau`,
			'masa berlakunya lewat, minta pengurus mengirim ulang undangannya.',
			'',
			'Kalau Anda merasa tidak mengenal komplek ini, abaikan saja email ini; tanpa tautan itu',
			'dibuka, tidak ada akun yang dibuat atas nama Anda.'
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const invitationTemplates: EmailTemplates = {
	[INVITATION_KIND]: invitationTemplate
};
