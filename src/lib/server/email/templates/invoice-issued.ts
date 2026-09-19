import * as m from '$lib/paraglide/messages';
import { baseLocale, locales, type Locale } from '$lib/paraglide/runtime';
import { formatRupiah, rupiah } from '$lib/money';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The email that tells a Unit's active primary occupant that its Tagihan for a Periode has been
 * issued: how much it is, and when it falls due. Ticket #31's own — this is the first template in
 * this directory whose text goes through Paraglide rather than being written by hand, per that
 * ticket's decision: the schema stores no per-resident language, so every call carries an explicit
 * `locale` in its payload, defaulting to the base locale `id`.
 *
 * The same two decisions as `./registration-approved.ts` apply: the body refuses a payload that is
 * not shaped the way it expects, and the kind is a mandatory subscription kind —
 * `SUBSCRIPTION_KIND.invoiceIssued`, the same string `email_queue.kind` and `subscriptions.kind` both
 * use, so `setSubscriptionPreference` in `src/lib/server/services/subscription/index.ts` already
 * refuses turning it off.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const INVOICE_ISSUED_KIND = SUBSCRIPTION_KIND.invoiceIssued;

/** What this email needs in order to be written. */
export interface InvoiceIssuedEmailValues {
	/** The block of the house the Tagihan is for. */
	readonly block: string;
	/** The house number inside that block. */
	readonly number: string;
	/** The calendar month the Tagihan is for, as `YYYY-MM`. */
	readonly period: string;
	/** The amount owed, in whole rupiah. */
	readonly amount: number;
	/** The day payment is due, as `YYYY-MM-DD`. */
	readonly dueDate: string;
	/** Which catalog to render the text from. Defaults to the base locale, `id`. */
	readonly locale?: Locale;
}

/** Builds the payload for a queue row of kind `invoice-issued`. */
export function invoiceIssuedPayload(values: InvoiceIssuedEmailValues): EmailPayload {
	return {
		block: values.block,
		number: values.number,
		period: values.period,
		amount: values.amount,
		dueDate: values.dueDate,
		locale: values.locale ?? baseLocale
	};
}

/** Writes the invoice-issued email, in the locale its payload names. */
export const invoiceIssuedTemplate: EmailTemplate = (payload) => {
	const { block, number, period, amount, dueDate, locale } = payload;
	if (
		typeof block !== 'string' ||
		typeof number !== 'string' ||
		typeof period !== 'string' ||
		typeof amount !== 'number' ||
		typeof dueDate !== 'string' ||
		typeof locale !== 'string' ||
		!(locales as readonly string[]).includes(locale)
	) {
		throw new TypeError(
			`An email of kind "${INVOICE_ISSUED_KIND}" needs a block, a number, a period and a dueDate, all strings, an amount that is a number, and a locale that is one of ${locales.join(', ')}.`
		);
	}
	const resolvedLocale = locale as Locale;
	const formattedAmount = formatRupiah(rupiah(amount));

	return {
		subject: m.emailInvoiceIssued_subject({ period }, { locale: resolvedLocale }),
		text: [
			m.emailInvoiceIssued_greeting({}, { locale: resolvedLocale }),
			'',
			m.emailInvoiceIssued_intro({ period, block, number }, { locale: resolvedLocale }),
			m.emailInvoiceIssued_amountLine({ amount: formattedAmount }, { locale: resolvedLocale }),
			m.emailInvoiceIssued_dueDateLine({ dueDate }, { locale: resolvedLocale }),
			'',
			m.emailInvoiceIssued_closing({}, { locale: resolvedLocale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const invoiceIssuedTemplates: EmailTemplates = {
	[INVOICE_ISSUED_KIND]: invoiceIssuedTemplate
};
