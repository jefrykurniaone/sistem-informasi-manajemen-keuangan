import * as m from '$lib/paraglide/messages';
import { baseLocale, locales, type Locale } from '$lib/paraglide/runtime';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The email that tells a subscribed admin a new Keluhan needs review: its title, its category, and
 * a link to the admin detail screen — never its description, which can name a neighbour or a
 * private matter the reporter never chose to make public. `src/lib/server/services/complaint/notification.ts`
 * is the only caller, from `createComplaint`, after that function's own transaction has committed.
 *
 * The same Paraglide-with-explicit-locale shape as `./new-post.ts` — see that file's doc comment
 * for why: the schema stores no per-resident language, so every call carries an explicit `locale`
 * in its payload, defaulting to the base locale `id`.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const NEW_COMPLAINT_KIND = SUBSCRIPTION_KIND.newComplaint;

/** What this email needs in order to be written. */
export interface NewComplaintEmailValues {
	/** The Keluhan's title, exactly as the reporter wrote it. */
	readonly title: string;
	/** The Keluhan's category. */
	readonly category: string;
	/** The absolute address of the admin detail page, `${ORIGIN}/admin/complaints/${complaint.id}`. */
	readonly url: string;
	/** Which Paraglide locale renders the fixed text. Defaults to the base locale, `id`. */
	readonly locale?: Locale;
}

/** Builds the payload for a queue row of kind `new-complaint`. */
export function newComplaintPayload(values: NewComplaintEmailValues): EmailPayload {
	return {
		title: values.title,
		category: values.category,
		url: values.url,
		locale: values.locale ?? baseLocale
	};
}

/** Writes the new-complaint notification email, in the payload's own `locale`. */
export const newComplaintTemplate: EmailTemplate = (payload) => {
	const { title, category, url, locale } = payload;
	if (
		typeof title !== 'string' ||
		typeof category !== 'string' ||
		typeof url !== 'string' ||
		typeof locale !== 'string' ||
		!(locales as readonly string[]).includes(locale)
	) {
		throw new TypeError(
			`An email of kind "${NEW_COMPLAINT_KIND}" needs a title, a category and a url, all strings, and a locale that is one of ${locales.join(', ')}.`
		);
	}
	const resolvedLocale = locale as Locale;

	return {
		subject: m.emailNewComplaint_subject({ title }, { locale: resolvedLocale }),
		text: [
			m.emailNewComplaint_greeting({}, { locale: resolvedLocale }),
			'',
			m.emailNewComplaint_intro({ title, category }, { locale: resolvedLocale }),
			'',
			m.emailNewComplaint_linkLabel({}, { locale: resolvedLocale }),
			url,
			'',
			m.emailNewComplaint_footer({}, { locale: resolvedLocale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const newComplaintTemplates: EmailTemplates = {
	[NEW_COMPLAINT_KIND]: newComplaintTemplate
};
