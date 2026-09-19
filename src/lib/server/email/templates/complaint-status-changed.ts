import * as m from '$lib/paraglide/messages';
import { baseLocale, locales, type Locale } from '$lib/paraglide/runtime';
import {
	COMPLAINT_STATUS,
	COMPLAINT_STATUSES,
	type ComplaintStatus
} from '$lib/server/db/schema/complaint';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The email that tells a Keluhan's reporter that it moved: the new status, and the note or
 * rejection reason the pengurus left, if any — never the description. `src/lib/server/services/complaint/notification.ts`
 * is the only caller, from `changeComplaintStatus`, after that function's own transaction has
 * committed; `withdrawComplaint` never calls it, which is what keeps a reporter's own withdrawal
 * from emailing themselves.
 *
 * `own-complaint-status-changed` is the mandatory subscription kind #22 already registered in
 * `src/lib/server/services/subscription/kinds.ts` — this is the email side of it, which had no
 * template until this ticket.
 *
 * The same Paraglide-with-explicit-locale shape as `./new-post.ts` — see that file's doc comment
 * for why: the schema stores no per-resident language, so every call carries an explicit `locale`
 * in its payload, defaulting to the base locale `id`.
 *
 * The status word rendered here is the exact catalog `(app)/complaints/[id]/+page.svelte` and
 * `(app)/admin/complaints/[id]/+page.svelte` already use for the same six values
 * (`complaints_status_*`), read straight off those message keys rather than a second copy of the
 * same six words.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const COMPLAINT_STATUS_CHANGED_KIND = SUBSCRIPTION_KIND.ownComplaintStatusChanged;

/** What this email needs in order to be written. */
export interface ComplaintStatusChangedEmailValues {
	/** The Keluhan's title, exactly as the reporter wrote it. */
	readonly title: string;
	/** The status the Keluhan just moved to. */
	readonly status: ComplaintStatus;
	/** Free-text colour left on the transition, or `null` when there was none. */
	readonly note: string | null;
	/** Why it was rejected, or `null` for every other status. */
	readonly rejectionReason: string | null;
	/** The absolute address of the reporter's detail page, `${ORIGIN}/complaints/${complaint.id}`. */
	readonly url: string;
	/** Which Paraglide locale renders the fixed text. Defaults to the base locale, `id`. */
	readonly locale?: Locale;
}

/** Builds the payload for a queue row of kind `own-complaint-status-changed`. */
export function complaintStatusChangedPayload(
	values: ComplaintStatusChangedEmailValues
): EmailPayload {
	return {
		title: values.title,
		status: values.status,
		note: values.note,
		rejectionReason: values.rejectionReason,
		url: values.url,
		locale: values.locale ?? baseLocale
	};
}

/** One status word per value, read off the same catalog the complaint screens already render. */
const STATUS_LABEL: Readonly<
	Record<ComplaintStatus, (params: Record<string, never>, options: { locale: Locale }) => string>
> = {
	[COMPLAINT_STATUS.new]: m.complaints_status_new,
	[COMPLAINT_STATUS.reviewing]: m.complaints_status_reviewing,
	[COMPLAINT_STATUS.working]: m.complaints_status_working,
	[COMPLAINT_STATUS.resolved]: m.complaints_status_resolved,
	[COMPLAINT_STATUS.rejected]: m.complaints_status_rejected,
	[COMPLAINT_STATUS.withdrawn]: m.complaints_status_withdrawn
};

/** Whether `value` is one of the six status values this template knows a word for. */
function isComplaintStatus(value: unknown): value is ComplaintStatus {
	return typeof value === 'string' && (COMPLAINT_STATUSES as readonly string[]).includes(value);
}

/** Whether `value` is a string or `null` — the shape both `note` and `rejectionReason` take. */
function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

/** Writes the complaint-status-changed email, in the payload's own `locale`. */
export const complaintStatusChangedTemplate: EmailTemplate = (payload) => {
	const { title, status, note, rejectionReason, url, locale } = payload;
	if (
		typeof title !== 'string' ||
		!isComplaintStatus(status) ||
		!isNullableString(note) ||
		!isNullableString(rejectionReason) ||
		typeof url !== 'string' ||
		typeof locale !== 'string' ||
		!(locales as readonly string[]).includes(locale)
	) {
		throw new TypeError(
			`An email of kind "${COMPLAINT_STATUS_CHANGED_KIND}" needs a title and a url, both strings, a status that is one of ${COMPLAINT_STATUSES.join(', ')}, a note and a rejectionReason that are each a string or null, and a locale that is one of ${locales.join(', ')}.`
		);
	}
	const resolvedLocale = locale as Locale;

	const colourLines = [
		...(note ? [m.emailComplaintStatus_noteLine({ note }, { locale: resolvedLocale })] : []),
		...(rejectionReason
			? [m.emailComplaintStatus_reasonLine({ reason: rejectionReason }, { locale: resolvedLocale })]
			: [])
	];

	return {
		subject: m.emailComplaintStatus_subject({ title }, { locale: resolvedLocale }),
		text: [
			m.emailComplaintStatus_greeting({}, { locale: resolvedLocale }),
			'',
			m.emailComplaintStatus_intro(
				{ title, status: STATUS_LABEL[status]({}, { locale: resolvedLocale }) },
				{ locale: resolvedLocale }
			),
			...colourLines,
			'',
			m.emailComplaintStatus_linkLabel({}, { locale: resolvedLocale }),
			url,
			'',
			m.emailComplaintStatus_closing({}, { locale: resolvedLocale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const complaintStatusChangedTemplates: EmailTemplates = {
	[COMPLAINT_STATUS_CHANGED_KIND]: complaintStatusChangedTemplate
};
