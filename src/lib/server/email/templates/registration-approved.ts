import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that tells a self-registrant a superuser let them in: which house they were attached to,
 * and where to sign in.
 *
 * The same two decisions as `./invitation.ts` apply — the body is plain text because it renders a
 * block and a number a person typed, and the template refuses a payload that is not shaped the way
 * it expects, so the worker fails that one queue row permanently rather than retrying a payload that
 * will never render.
 *
 * Two decisions of its own:
 *
 * - **It carries no token and grants nothing.** The account already exists and already has its own
 *   password: the registrant created it at `/register` and proved the address before they could sign
 *   in at all. This email announces a decision, so the link in it is the ordinary sign-in page.
 * - **It is transactional, not a Langganan.** A resident cannot turn this one off, because it is the
 *   answer to something they asked for; `src/lib/server/services/subscription/kinds.ts` is
 *   deliberately not touched.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const REGISTRATION_APPROVED_KIND = 'registration-approved';

/** What this email needs in order to be written. */
export interface RegistrationApprovedEmailValues {
	/** The full address of the sign-in page. */
	readonly url: string;
	/** The block of the house the registration was approved onto. */
	readonly block: string;
	/** The house number inside that block. */
	readonly number: string;
}

/** Builds the payload for a queue row of kind `registration-approved`. */
export function registrationApprovedPayload(values: RegistrationApprovedEmailValues): EmailPayload {
	return { url: values.url, block: values.block, number: values.number };
}

/** Writes the approval email. Indonesian, because a resident reads it. */
export const registrationApprovedTemplate: EmailTemplate = (payload) => {
	const { url, block, number } = payload;
	if (typeof url !== 'string' || typeof block !== 'string' || typeof number !== 'string') {
		throw new TypeError(
			`An email of kind "${REGISTRATION_APPROVED_KIND}" needs a url, a block and a number, all strings.`
		);
	}

	return {
		subject: 'Pendaftaran Anda disetujui',
		text: [
			'Halo,',
			'',
			'Pendaftaran Anda di Sistem Informasi dan Manajemen Keuangan Komplek sudah disetujui',
			`pengurus. Anda tercatat sebagai warga rumah blok ${block} nomor ${number}.`,
			'',
			'Masuk dengan alamat email dan kata sandi yang Anda pakai waktu mendaftar:',
			'',
			url,
			'',
			'Kalau rumah yang tercatat di atas tidak sesuai, hubungi pengurus supaya datanya dibetulkan.'
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const registrationApprovedTemplates: EmailTemplates = {
	[REGISTRATION_APPROVED_KIND]: registrationApprovedTemplate
};
