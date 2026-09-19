import * as m from '$lib/paraglide/messages';
import { isLocale } from '$lib/paraglide/runtime';
import { formatRupiah, rupiah } from '$lib/money';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The email that tells a subscribed resident a Laporan Bulanan has been published: the four figures
 * `docs/spec-kas-laporan-v1.md` puts at the top of a report, a link to the report page, and the
 * one-click unsubscribe link. `src/lib/server/services/report/notification.ts` is the only caller.
 *
 * Two things this email deliberately does not carry:
 *
 * - **No attachment.** #37 asks for "ringkasan angka dan tautan, bukan lampiran". A PDF would be a
 *   second, frozen copy of figures that already exist frozen in `monthly_reports`, and it would go
 *   stale the moment a revision is published — the link never does.
 * - **No unit, no name, no identifier.** The report a warga reads names no house and no person
 *   either; see `../../services/report/resident-payload.ts`. An email is read in more places than a
 *   page is, so the same rule is applied here rather than relaxed.
 *
 * Rendered through Paraglide with an explicit `locale` in the payload, defaulting to the base
 * locale, exactly as `./new-post.ts` and `./invoice-issued.ts` do — the kind is a Langganan a
 * resident opted into, so the wording lives in `messages/id.json` and `messages/en.json`. A payload
 * that is not shaped the way this template expects throws `TypeError`, so the worker fails that one
 * row permanently rather than retrying text that will never render.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const MONTHLY_REPORT_KIND = SUBSCRIPTION_KIND.monthlyReport;

/** What this email needs in order to be written. */
export interface MonthlyReportEmailValues {
	/** The Periode the report covers, as `YYYY-MM`. */
	readonly period: string;
	/** The cash balance the month started with, in whole rupiah. */
	readonly openingBalance: number;
	/** Everything that came in during the month, in whole rupiah. */
	readonly totalIncome: number;
	/** Everything that went out during the month, in whole rupiah. */
	readonly totalExpense: number;
	/** The cash balance the month ended with, in whole rupiah. */
	readonly closingBalance: number;
	/** The absolute address of the report page, `${ORIGIN}/reports/${period}`. */
	readonly reportUrl: string;
	/** The absolute address of this recipient's own unsubscribe page. */
	readonly unsubscribeUrl: string;
	/** Which catalog renders the fixed text. `'id'` until a resident's own language is stored. */
	readonly locale: string;
}

/** Builds the payload for a queue row of kind `monthly-report`. */
export function monthlyReportPayload(values: MonthlyReportEmailValues): EmailPayload {
	return {
		period: values.period,
		openingBalance: values.openingBalance,
		totalIncome: values.totalIncome,
		totalExpense: values.totalExpense,
		closingBalance: values.closingBalance,
		reportUrl: values.reportUrl,
		unsubscribeUrl: values.unsubscribeUrl,
		locale: values.locale
	};
}

/** Writes the monthly-report email, in the locale its payload names. */
export const monthlyReportTemplate: EmailTemplate = (payload) => {
	const { period, reportUrl, unsubscribeUrl, locale } = payload;
	if (
		typeof period !== 'string' ||
		typeof reportUrl !== 'string' ||
		typeof unsubscribeUrl !== 'string' ||
		!isLocale(locale)
	) {
		throw new TypeError(
			`An email of kind "${MONTHLY_REPORT_KIND}" needs a period, a reportUrl and an unsubscribeUrl, all strings, and a locale that is one of the application's locales.`
		);
	}
	const openingBalance = money(payload.openingBalance, 'openingBalance');
	const totalIncome = money(payload.totalIncome, 'totalIncome');
	const totalExpense = money(payload.totalExpense, 'totalExpense');
	const closingBalance = money(payload.closingBalance, 'closingBalance');

	return {
		subject: m.emailMonthlyReport_subject({ period }, { locale }),
		text: [
			m.emailMonthlyReport_greeting({}, { locale }),
			'',
			m.emailMonthlyReport_intro({ period }, { locale }),
			'',
			m.emailMonthlyReport_openingBalanceLine({ amount: openingBalance }, { locale }),
			m.emailMonthlyReport_totalIncomeLine({ amount: totalIncome }, { locale }),
			m.emailMonthlyReport_totalExpenseLine({ amount: totalExpense }, { locale }),
			m.emailMonthlyReport_closingBalanceLine({ amount: closingBalance }, { locale }),
			'',
			m.emailMonthlyReport_linkLabel({}, { locale }),
			reportUrl,
			'',
			m.emailMonthlyReport_unsubscribeLabel({}, { locale }),
			unsubscribeUrl,
			'',
			m.emailMonthlyReport_closing({}, { locale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const monthlyReportTemplates: EmailTemplates = {
	[MONTHLY_REPORT_KIND]: monthlyReportTemplate
};

/**
 * One figure off the payload, formatted as Indonesian rupiah.
 *
 * @throws {TypeError} when the value is not a whole number of rupiah. `rupiah()` refuses a fraction
 *   on its own; the check here is what turns a missing or non-numeric field into the same refusal
 *   rather than a `NaN` in somebody's inbox.
 */
function money(value: unknown, name: string): string {
	if (typeof value !== 'number') {
		throw new TypeError(
			`An email of kind "${MONTHLY_REPORT_KIND}" needs ${name} as a number of whole rupiah, not ${typeof value}.`
		);
	}
	return formatRupiah(rupiah(value));
}
