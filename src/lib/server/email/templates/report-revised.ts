import * as m from '$lib/paraglide/messages';
import { isLocale } from '$lib/paraglide/runtime';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that tells the same subscribers a Laporan Bulanan they have already read was replaced:
 * which revision this is, why it exists, and where to read it.
 * `src/lib/server/services/report/notification.ts` is the only caller, from `publishReport` once its
 * transaction has committed.
 *
 * **The kind is `monthly-report-revised`, and it is not a `SUBSCRIPTION_KIND`.** A revision is not a
 * separate thing to opt into: it goes to whoever asked for the monthly report, because the figures
 * being corrected are the ones they were sent. Adding it to `../../services/subscription/kinds.ts`
 * would put a second switch on the preferences screen that nobody could answer sensibly — off would
 * mean "send me figures and never tell me they were wrong". The unsubscribe link this email carries
 * is therefore the *monthly report* link: pressing it stops both.
 *
 * It carries no figures on purpose. A revision's numbers belong on the report page, which is the one
 * place they are frozen and where every earlier revision is still readable beside them; repeating
 * four of them in an email whose whole message is "the numbers changed" is how a reader ends up
 * comparing two mails instead of opening the report.
 *
 * Paraglide, an explicit `locale`, and a `TypeError` on a malformed payload — the same three rules
 * as `./monthly-report.ts` and `./new-post.ts`.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const MONTHLY_REPORT_REVISED_KIND = 'monthly-report-revised';

/** What this email needs in order to be written. */
export interface ReportRevisedEmailValues {
	/** The Periode the revised report covers, as `YYYY-MM`. */
	readonly period: string;
	/** Which revision this is. Always 2 or more: revision 1 revises nothing. */
	readonly revision: number;
	/** Why the revision exists, exactly as the admin wrote it. Never empty above revision 1. */
	readonly reason: string;
	/** The absolute address of the report page, `${ORIGIN}/reports/${period}`. */
	readonly reportUrl: string;
	/** The absolute address of this recipient's own unsubscribe page. */
	readonly unsubscribeUrl: string;
	/** Which catalog renders the fixed text. `'id'` until a resident's own language is stored. */
	readonly locale: string;
}

/** Builds the payload for a queue row of kind `monthly-report-revised`. */
export function reportRevisedPayload(values: ReportRevisedEmailValues): EmailPayload {
	return {
		period: values.period,
		revision: values.revision,
		reason: values.reason,
		reportUrl: values.reportUrl,
		unsubscribeUrl: values.unsubscribeUrl,
		locale: values.locale
	};
}

/** Writes the revision notification, in the locale its payload names. */
export const reportRevisedTemplate: EmailTemplate = (payload) => {
	const { period, revision, reason, reportUrl, unsubscribeUrl, locale } = payload;
	if (
		typeof period !== 'string' ||
		typeof revision !== 'number' ||
		typeof reason !== 'string' ||
		typeof reportUrl !== 'string' ||
		typeof unsubscribeUrl !== 'string' ||
		!isLocale(locale)
	) {
		throw new TypeError(
			`An email of kind "${MONTHLY_REPORT_REVISED_KIND}" needs a period, a reason, a reportUrl and an unsubscribeUrl, all strings, a revision that is a number, and a locale that is one of the application's locales.`
		);
	}

	return {
		subject: m.emailReportRevised_subject({ period, revision }, { locale }),
		text: [
			m.emailReportRevised_greeting({}, { locale }),
			'',
			m.emailReportRevised_intro({ period, revision }, { locale }),
			'',
			m.emailReportRevised_reasonLabel({}, { locale }),
			reason,
			'',
			m.emailReportRevised_linkLabel({}, { locale }),
			reportUrl,
			'',
			m.emailReportRevised_unsubscribeLabel({}, { locale }),
			unsubscribeUrl,
			'',
			m.emailReportRevised_closing({}, { locale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const reportRevisedTemplates: EmailTemplates = {
	[MONTHLY_REPORT_REVISED_KIND]: reportRevisedTemplate
};
