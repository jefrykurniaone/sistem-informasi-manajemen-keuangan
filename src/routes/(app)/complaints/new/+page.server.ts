import { fail, redirect } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { COMPLAINT_VISIBILITY } from '#lib/server/db/schema/complaint.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	type FormMessages
} from '#lib/server/route-action.ts';
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
} from '#lib/server/services/complaint/index.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen a Warga reports a Keluhan on — `docs/spec-keluhan-v1.md` user stories 1 through 3.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a rule refusal becomes `fail(400, …)` with the fields still filled in.
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

/**
 * `create`: the 403 for anyone who may not report a Keluhan, and a named Lampiran or Keluhan rule.
 * A new Keluhan has no 404 of its own.
 */
const CREATE_FORM = {
	forbidden: m.complaintsNew_forbidden,
	fallback: m.complaintsNew_invalidForm,
	refusals: [
		refusal(ComplaintAttachmentRuleError, ({ error }) => attachmentRuleMessage(error.rule)),
		refusal(ComplaintRuleError, ({ error }) => complaintRuleMessage(error.rule))
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);

	return {
		acceptedAttachmentTypes: ATTACHMENT_CONTENT_TYPES,
		maximumAttachmentBytes: MAXIMUM_ATTACHMENT_BYTES,
		maxAttachments: MAX_ATTACHMENTS_PER_COMPLAINT
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const values = readFormValues(form);
		if (values.title === '' || values.category === '' || values.description === '') {
			return fail(400, { message: m.complaintsNew_invalidForm(), values });
		}

		const attachments = await readAttachments(form);
		const visibility = values.makePublic
			? COMPLAINT_VISIBILITY.public
			: COMPLAINT_VISIBILITY.private;

		const dependencies = productionDependencies();
		let created;
		try {
			created = await createComplaint(dependencies.db, dependencies.clock, dependencies.fileStore, {
				actorId: user.id,
				title: values.title,
				category: values.category,
				description: values.description,
				visibility,
				attachments
			});
		} catch (caught) {
			return failOrThrow(caught, CREATE_FORM, { values });
		}

		redirect(303, `/complaints/${created.id}?created=1`);
	}
};

/** What the report form carries, trimmed, as the values a re-rendered form is repopulated with. */
function readFormValues(form: FormData) {
	return {
		title: readText(form, TITLE_FIELD),
		category: readText(form, CATEGORY_FIELD),
		description: readText(form, DESCRIPTION_FIELD),
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
