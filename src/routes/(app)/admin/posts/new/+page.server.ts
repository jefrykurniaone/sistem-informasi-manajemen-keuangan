import { fail, redirect } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { POST_TYPES, type PostType } from '#lib/server/db/schema/post.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	assertAcceptableCoverImage,
	assertMayManagePosts,
	COVER_IMAGE_CONTENT_TYPES,
	createPost,
	POST_CATEGORIES,
	POST_RULE,
	PostRuleError,
	setPostCoverImage,
	type CoverImageUpload,
	type PostRule
} from '#lib/server/services/post/index.ts';
import { combineCivilDateTime } from '#lib/server/services/post/time.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen an admin writes a new Post on. It always saves a draft — publishing is a separate,
 * audited step on `(app)/admin/posts/[id]`, per `docs/spec-konten-v1.md`'s stories 5 and 8 — and it
 * redirects to that screen on success so that publishing happens in one place.
 *
 * Since #140 the Sampul is chosen on this form too, so the `create` action reads a file as well as
 * the typed fields. It checks that file *before* it writes anything: see
 * `assertAcceptableCoverImage` in `#lib/server/services/post/index.ts` for the whole argument.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a rule refusal becomes `fail(400, …)` with every typed value handed back.
 */

/** The 403 for anyone who may not manage Posts. A Post being written has no 404 yet. */
const PAGE = { forbidden: m.adminPosts_forbidden } satisfies PageMessages;

/**
 * `create`: a named rule refusal reads its own sentence, and a `TypeError` from the service's own
 * validation reads the invalid-form sentence, as it did before #318.
 */
const CREATE_FORM = {
	...PAGE,
	fallback: m.adminPosts_invalidForm,
	refusals: [
		refusal(PostRuleError, ({ error }) => ruleMessage(error.rule)),
		refusal(TypeError, m.adminPosts_invalidForm)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	// There is no data to fetch — this screen is a blank form — so the permission check is made on
	// its own rather than riding along on a query. Without it a resident would be shown a form and
	// only refused once they had filled it in.
	const { db } = productionDependencies();
	try {
		await assertMayManagePosts(db, user.id);
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}

	return {
		categories: POST_CATEGORIES,
		types: POST_TYPES,
		coverImageContentTypes: COVER_IMAGE_CONTENT_TYPES
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const values = readPostFormValues(form);
		if (values.title === '' || values.summary === '' || values.bodyHtml === '') {
			return fail(400, { message: m.adminPosts_invalidForm(), values });
		}

		let startsAt: Date | null;
		let endsAt: Date | null;
		try {
			startsAt = combineCivilDateTime(values.startsAtDate, values.startsAtTime);
			endsAt = combineCivilDateTime(values.endsAtDate, values.endsAtTime);
		} catch (caught) {
			if (caught instanceof RangeError) {
				return fail(400, { message: m.adminPosts_timeFormat(), values });
			}
			throw caught;
		}

		// The Sampul is checked before the Post is written, so that a picture this application refuses
		// leaves no Post behind — see `assertAcceptableCoverImage` for why this order rather than one
		// transaction around both. Every typed value comes back with the refusal, so the only field the
		// admin has to fill in again is the file, which no browser lets a server repopulate anyway.
		const coverImage = await readCoverImage(form);
		if (coverImage) {
			try {
				assertAcceptableCoverImage(coverImage);
			} catch (caught) {
				return failOrThrow(caught, CREATE_FORM, { values });
			}
		}

		const dependencies = productionDependencies();
		let createdId: string;
		try {
			const created = await createPost(dependencies.db, dependencies.clock, {
				actorId: user.id,
				type: parseType(values.type),
				title: values.title,
				summary: values.summary,
				bodyHtml: values.bodyHtml,
				category: values.category,
				startsAt,
				endsAt,
				location: values.location || null
			});
			createdId = created.id;
			if (coverImage) {
				// The file store is read only here, when there is a Sampul to keep, so a missing
				// `FILE_STORE_SECRET` never refuses a Post written without one.
				await setPostCoverImage(dependencies.db, dependencies.clock, dependencies.fileStore, {
					actorId: user.id,
					postId: created.id,
					...coverImage
				});
			}
		} catch (caught) {
			return failOrThrow(caught, CREATE_FORM, { values });
		}

		redirect(303, `/admin/posts/${createdId}`);
	}
};

/**
 * What the write form carries, as strings: the typed text trimmed, the type, the category and the
 * date and time boxes exactly as posted.
 *
 * `(app)/admin/posts/[id]/+page.server.ts` carries its own copy: a helper that reads one route's form
 * belongs next to that route, and the two are free to drift apart when the two screens do.
 */
function readPostFormValues(form: FormData) {
	return {
		type: String(form.get('type') ?? ''),
		title: readText(form, 'title'),
		summary: readText(form, 'summary'),
		bodyHtml: readText(form, 'bodyHtml'),
		category: String(form.get('category') ?? ''),
		startsAtDate: String(form.get('startsAtDate') ?? ''),
		startsAtTime: String(form.get('startsAtTime') ?? ''),
		endsAtDate: String(form.get('endsAtDate') ?? ''),
		endsAtTime: String(form.get('endsAtTime') ?? ''),
		location: readText(form, 'location')
	};
}

/**
 * The Sampul the form carried, or `undefined` when its field was left empty.
 *
 * An untouched `<input type="file">` still posts a `File` — an empty one with an empty name — so the
 * size is what tells "no picture was chosen" apart from "a picture was chosen", exactly as the
 * upload form this replaced already did.
 */
async function readCoverImage(form: FormData): Promise<CoverImageUpload | undefined> {
	const file = form.get('coverImage');
	if (!(file instanceof File) || file.size === 0) {
		return undefined;
	}
	return { contentType: file.type, content: new Uint8Array(await file.arrayBuffer()) };
}

/** The submitted type, defaulted to the first one the schema knows when nothing recognisable came. */
function parseType(value: string): PostType {
	return POST_TYPES.find((type) => type === value) ?? POST_TYPES[0];
}

/** The sentence a person reads for each named rule refusal. */
function ruleMessage(rule: PostRule): string {
	const messages: Record<PostRule, () => string> = {
		[POST_RULE.announcementHasEventTimes]: m.adminPosts_rule_announcementHasEventTimes,
		[POST_RULE.eventNeedsStartTime]: m.adminPosts_rule_eventNeedsStartTime,
		[POST_RULE.endsBeforeStart]: m.adminPosts_rule_endsBeforeStart,
		[POST_RULE.unknownCategory]: m.adminPosts_rule_unknownCategory,
		[POST_RULE.authorNotRegistered]: m.adminPosts_rule_authorNotRegistered,
		[POST_RULE.coverImageNotAnImage]: m.adminPosts_rule_coverImageNotAnImage,
		[POST_RULE.coverImageTooLarge]: m.adminPosts_rule_coverImageTooLarge
	};
	return messages[rule]();
}
