import * as m from '$lib/paraglide/messages';
import { baseLocale, locales, type Locale } from '$lib/paraglide/runtime';
import { formatRupiah, rupiah } from '$lib/money';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The email that tells a Pembayaran's recorder that it has been verified: how much, and which
 * Tagihan it settled. The same Paraglide-with-explicit-locale shape as `./invoice-issued.ts` — see
 * that file's doc comment for why.
 *
 * `settlements` is a list because one payment can settle several Tagihan, or none at all (the whole
 * amount becomes saldo titipan). A variable-length list cannot be one ICU message, so this template
 * renders one line per settlement and a different closing line when the list is empty, rather than
 * asking a single message key to loop.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const PAYMENT_VERIFIED_KIND = SUBSCRIPTION_KIND.paymentVerified;

/** One Tagihan a verified payment settled, as far as this email needs to say. */
export interface PaymentVerifiedSettlement {
	/** The calendar month the Tagihan is for, as `YYYY-MM`. */
	readonly period: string;
	/** How much of the payment this settlement applied, in whole rupiah. */
	readonly amount: number;
}

/** What this email needs in order to be written. */
export interface PaymentVerifiedEmailValues {
	/** The total amount of the payment, in whole rupiah. */
	readonly amount: number;
	/** Every Tagihan the payment settled, in the order to list them. Empty when none was. */
	readonly settlements: readonly PaymentVerifiedSettlement[];
	/** Which catalog to render the text from. Defaults to the base locale, `id`. */
	readonly locale?: Locale;
}

/** Builds the payload for a queue row of kind `payment-verified`. */
export function paymentVerifiedPayload(values: PaymentVerifiedEmailValues): EmailPayload {
	return {
		amount: values.amount,
		settlements: values.settlements.map((settlement) => ({
			period: settlement.period,
			amount: settlement.amount
		})),
		locale: values.locale ?? baseLocale
	};
}

/** Whether `value` is a settlement shape this template can render. */
function isSettlementShape(value: unknown): value is PaymentVerifiedSettlement {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { period: unknown }).period === 'string' &&
		typeof (value as { amount: unknown }).amount === 'number'
	);
}

/** Writes the payment-verified email, in the locale its payload names. */
export const paymentVerifiedTemplate: EmailTemplate = (payload) => {
	const { amount, settlements, locale } = payload;
	if (
		typeof amount !== 'number' ||
		!Array.isArray(settlements) ||
		!settlements.every(isSettlementShape) ||
		typeof locale !== 'string' ||
		!(locales as readonly string[]).includes(locale)
	) {
		throw new TypeError(
			`An email of kind "${PAYMENT_VERIFIED_KIND}" needs an amount that is a number, a settlements array of { period, amount }, and a locale that is one of ${locales.join(', ')}.`
		);
	}
	const resolvedLocale = locale as Locale;
	const formattedAmount = formatRupiah(rupiah(amount));

	const settlementLines =
		settlements.length === 0
			? [m.emailPaymentVerified_noSettlements({}, { locale: resolvedLocale })]
			: [
					m.emailPaymentVerified_settlementsHeading({}, { locale: resolvedLocale }),
					...settlements.map((settlement) =>
						m.emailPaymentVerified_settlementLine(
							{ period: settlement.period, amount: formatRupiah(rupiah(settlement.amount)) },
							{ locale: resolvedLocale }
						)
					)
				];

	return {
		subject: m.emailPaymentVerified_subject(
			{ amount: formattedAmount },
			{ locale: resolvedLocale }
		),
		text: [
			m.emailPaymentVerified_greeting({}, { locale: resolvedLocale }),
			'',
			m.emailPaymentVerified_intro({ amount: formattedAmount }, { locale: resolvedLocale }),
			...settlementLines,
			'',
			m.emailPaymentVerified_closing({}, { locale: resolvedLocale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const paymentVerifiedTemplates: EmailTemplates = {
	[PAYMENT_VERIFIED_KIND]: paymentVerifiedTemplate
};
