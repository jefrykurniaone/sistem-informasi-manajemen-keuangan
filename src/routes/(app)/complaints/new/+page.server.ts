import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { COMPLAINT_VISIBILITY } from '$lib/server/db/schema/complaint';
import { systemClock } from '$lib/server/ports/clock';
import {
	ATTACHMENT_CONTENT_TYPES,
	COMPLAINT_ATTACHMENT_RULE,
	COMPLAINT_RULE,
	ComplaintAttachmentRuleError,
	ComplaintRuleError,
	MAX_ATTACHMENTS_PER_COMPLAINT,
	MAXIMUM_ATTACHMENT_BYTES,
	MAXIMUM_ATTACHMENT_MEBIBYTES,
	createComplaint,
	type ComplaintAttachmentRule,
	type ComplaintAttachmentUpload,
	type ComplaintRule
} from '$lib/server/services/complaint';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen a Warga reports a Keluhan on — `docs/spec-keluhan-v1.md` user stories 1 through 3.
 *
 * Follows the shape `(app)/payments/new/+page.server.ts` settled: nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a named rule refusal becomes `fail(400, …)` with the fields still filled in.
 *
 * **The visibility choice is one checkbox, not the two-value form the schema and the service
 * accept.** `docs/spec-keluhan-v1.md`'s "Keluhan bersifat pribadi secara bawaan" means an unticked
 * box is `private` and a ticked one is `public` — there is no third option a resident can reach,
 * and lowering a `public` complaint back to `private` afterwards is `setComplaintVisibility`
 * (#43), which this ticket's acceptance criteria never asks this screen to expose.
 *
 * **A successful report redirects to its own detail page**, the same reasoning the payment
 * screen's doc comment states: reporting a Keluhan is a thing a resident does once and then wants
 * to see the state of.
 */

/** The form field naming the complaint's title. */
const TITLE_FIELD = 'title';
/** The form field naming its category — free text; see `src/lib/server/db/schema/complaint.ts`. */
const CATEGORY_FIELD = 'category';
/** The form field carrying the uraian. */
const DESCRIPTION_FIELD = 'description';
/** The form field for the "tampilkan ke semua warga" checkbox. Present only when ticked. */
const MAKE_PUBLIC_FIELD = 'makePublic';
/** The form field every attached photo is posted under, one entry per file. */
const ATTACHMENTS_FIELD = 'attachments';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	return {
		acceptedAttachmentTypes: ATTACHMENT_CONTENT_TYPES,
		maximumAttachmentBytes: MAXIMUM_ATTACHMENT_BYTES,
		maxAttachments: MAX_ATTACHMENTS_PER_COMPLAINT
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const values = readFormValues(form);
		if (values.title === '' || values.category === '' || values.description === '') {
			return fail(400, { message: m.complaintsNew_invalidForm(), values });
		}

		const attachments = await readAttachments(form);
		const visibility = values.makePublic
			? COMPLAINT_VISIBILITY.public
			: COMPLAINT_VISIBILITY.private;

		let created;
		try {
			created = await createComplaint(
				database(),
				systemClock,
				localFileStoreFromEnvironment(systemClock),
				{
					actorId: locals.user.id,
					title: values.title,
					category: values.category,
					description: values.description,
					visibility,
					attachments
				}
			);
		} catch (caught) {
			if (caught instanceof ComplaintAttachmentRuleError) {
				return fail(400, { message: attachmentRuleMessage(caught.rule), values });
			}
			if (caught instanceof ComplaintRuleError) {
				return fail(400, { message: complaintRuleMessage(caught.rule), values });
			}
			throwAsRouteError(caught);
		}

		redirect(303, `/complaints/${created.id}?created=1`);
	}
};

/** What the report form carries, trimmed, as the values a re-rendered form is repopulated with. */
function readFormValues(form: FormData) {
	return {
		title: String(form.get(TITLE_FIELD) ?? '').trim(),
		category: String(form.get(CATEGORY_FIELD) ?? '').trim(),
		description: String(form.get(DESCRIPTION_FIELD) ?? '').trim(),
		makePublic: form.get(MAKE_PUBLIC_FIELD) !== null
	};
}

/**
 * Every attached photograph, read into memory. An empty file input still posts a zero-byte `File`
 * for `multiple`, which is filtered out here the same way `payments/new/+page.server.ts` filters a
 * zero-byte proof — "no file chosen" rather than "an empty image". Whether the bytes really are the
 * image they claim to be, and whether there are too many of them, is `createComplaint`'s question,
 * not this one's.
 */
async function readAttachments(form: FormData): Promise<ComplaintAttachmentUpload[]> {
	const files = form
		.getAll(ATTACHMENTS_FIELD)
		.filter((value): value is File => value instanceof File && value.size > 0);
	return Promise.all(
		files.map(async (file) => ({
			contentType: file.type,
			content: new Uint8Array(await file.arrayBuffer())
		}))
	);
}

/** The sentence a resident reads for each named Keluhan rule refusal this screen can run into. */
function complaintRuleMessage(rule: ComplaintRule): string {
	const messages: Partial<Record<ComplaintRule, () => string>> = {
		[COMPLAINT_RULE.actorNotRegistered]: m.complaintsNew_rule_actorNotRegistered
	};
	return messages[rule]?.() ?? m.complaintsNew_invalidForm();
}

/** The sentence a resident reads for each named Lampiran rule refusal. */
function attachmentRuleMessage(rule: ComplaintAttachmentRule): string {
	const messages: Record<ComplaintAttachmentRule, () => string> = {
		[COMPLAINT_ATTACHMENT_RULE.tooMany]: m.complaintsNew_rule_tooMany,
		[COMPLAINT_ATTACHMENT_RULE.attachmentNotAnImage]: m.complaintsNew_rule_attachmentNotAnImage,
		[COMPLAINT_ATTACHMENT_RULE.attachmentTooLarge]: () =>
			m.complaintsNew_rule_attachmentTooLarge({ maximumSize: MAXIMUM_ATTACHMENT_MEBIBYTES })
	};
	return messages[rule]();
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` for the same reason the payments and posts screens'
 * copies of this helper are.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.complaintsNew_forbidden());
	}
	throw caught;
}
