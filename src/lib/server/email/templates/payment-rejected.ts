import * as m from '$lib/paraglide/messages';
import { baseLocale, locales, type Locale } from '$lib/paraglide/runtime';
import { formatRupiah, rupiah } from '$lib/money';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that tells a Pembayaran's recorder that it was turned down, and why.
 *
 * **Transactional, not a Langganan** — the same shape `./registration-approved.ts` takes, and for
 * the same reason: it answers something the recorder themselves did (recording a payment), so it is
 * not one a resident may switch off. `src/lib/server/services/subscription/kinds.ts` is deliberately
 * not touched by this kind.
 *
 * The same Paraglide-with-explicit-locale shape as `./invoice-issued.ts` — see that file's doc
 * comment for why.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const PAYMENT_REJECTED_KIND = 'payment-rejected';

/** What this email needs in order to be written. */
export interface PaymentRejectedEmailValues {
	/** The amount of the rejected payment, in whole rupiah. */
	readonly amount: number;
	/** Why it was turned down — the same text `payments.rejectionReason` carries. */
	readonly reason: string;
	/** Which catalog to render the text from. Defaults to the base locale, `id`. */
	readonly locale?: Locale;
}

/** Builds the payload for a queue row of kind `payment-rejected`. */
export function paymentRejectedPayload(values: PaymentRejectedEmailValues): EmailPayload {
	return {
		amount: values.amount,
		reason: values.reason,
		locale: values.locale ?? baseLocale
	};
}

/** Writes the payment-rejected email, in the locale its payload names. */
export const paymentRejectedTemplate: EmailTemplate = (payload) => {
	const { amount, reason, locale } = payload;
	if (
		typeof amount !== 'number' ||
		typeof reason !== 'string' ||
		typeof locale !== 'string' ||
		!(locales as readonly string[]).includes(locale)
	) {
		throw new TypeError(
			`An email of kind "${PAYMENT_REJECTED_KIND}" needs an amount that is a number, a reason that is a string, and a locale that is one of ${locales.join(', ')}.`
		);
	}
	const resolvedLocale = locale as Locale;
	const formattedAmount = formatRupiah(rupiah(amount));

	return {
		subject: m.emailPaymentRejected_subject(
			{ amount: formattedAmount },
			{ locale: resolvedLocale }
		),
		text: [
			m.emailPaymentRejected_greeting({}, { locale: resolvedLocale }),
			'',
			m.emailPaymentRejected_intro({ amount: formattedAmount }, { locale: resolvedLocale }),
			m.emailPaymentRejected_reasonLine({ reason }, { locale: resolvedLocale }),
			'',
			m.emailPaymentRejected_closing({}, { locale: resolvedLocale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const paymentRejectedTemplates: EmailTemplates = {
	[PAYMENT_REJECTED_KIND]: paymentRejectedTemplate
};
