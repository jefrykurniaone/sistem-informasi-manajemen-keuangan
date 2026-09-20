import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { POST_TYPES, type PostType } from '$lib/server/db/schema/post';
import { systemClock } from '$lib/server/ports/clock';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
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
} from '$lib/server/services/post';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen an admin writes a new Post on. It always saves a draft — publishing is a separate,
 * audited step on `(app)/admin/posts/[id]`, per `docs/spec-konten-v1.md`'s stories 5 and 8 — and it
 * redirects to that screen on success so that publishing happens in one place.
 *
 * Since #140 the Sampul is chosen on this form too, so the `create` action reads a file as well as
 * the typed fields. It checks that file *before* it writes anything: see
 * `assertAcceptableCoverImage` in `$lib/server/services/post` for the whole argument, and
 * `coverImageRefusal` below for the one line of it that lives here.
 *
 * Follows the shape `(app)/admin/units/+page.server.ts` settled: nobody who is not signed in reaches
 * the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the service,
 * and a named rule refusal becomes `fail(400, …)`.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	// There is no data to fetch — this screen is a blank form — so the permission check is made on
	// its own rather than riding along on a query. Without it a resident would be shown a form and
	// only refused once they had filled it in.
	try {
		await assertMayManagePosts(database(), locals.user.id);
	} catch (caught) {
		throwAsRouteError(caught);
	}

	return {
		categories: POST_CATEGORIES,
		types: POST_TYPES,
		coverImageContentTypes: COVER_IMAGE_CONTENT_TYPES
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const values = readPostFormValues(form);
		if (values.title === '' || values.summary === '' || values.bodyHtml === '') {
			return fail(400, { message: m.adminPosts_invalidForm(), values });
		}

		const startsAt = parseLocalInstant(values.startsAt);
		const endsAt = parseLocalInstant(values.endsAt);
		if (startsAt === 'invalid' || endsAt === 'invalid') {
			return fail(400, { message: m.adminPosts_invalidTime(), values });
		}

		// The Sampul is checked before the Post is written, so that a picture this application refuses
		// leaves no Post behind — see `assertAcceptableCoverImage` for why this order rather than one
		// transaction around both. Every typed value comes back with the refusal, so the only field the
		// admin has to fill in again is the file, which no browser lets a server repopulate anyway.
		const coverImage = await readCoverImage(form);
		const coverRefusal = coverImage && coverImageRefusal(coverImage);
		if (coverRefusal) {
			return fail(400, { message: coverRefusal, values });
		}

		let createdId: string;
		try {
			const created = await createPost(database(), systemClock, {
				actorId: locals.user.id,
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
				await setPostCoverImage(
					database(),
					systemClock,
					localFileStoreFromEnvironment(systemClock),
					{ actorId: locals.user.id, postId: created.id, ...coverImage }
				);
			}
		} catch (caught) {
			if (caught instanceof PostRuleError) {
				return fail(400, { message: ruleMessage(caught.rule), values });
			}
			if (caught instanceof TypeError) {
				return fail(400, { message: m.adminPosts_invalidForm(), values });
			}
			throwAsRouteError(caught);
		}

		redirect(303, `/admin/posts/${createdId}`);
	}
};

/**
 * What the write form carries, trimmed, as strings.
 *
 * `(app)/admin/posts/[id]/+page.server.ts` carries its own copy, the same way the three unit and
 * role screens each carry their own `throwAsRouteError`: a helper that reads one route's form
 * belongs next to that route, and the two are free to drift apart when the two screens do.
 */
function readPostFormValues(form: FormData) {
	return {
		type: String(form.get('type') ?? ''),
		title: String(form.get('title') ?? '').trim(),
		summary: String(form.get('summary') ?? '').trim(),
		bodyHtml: String(form.get('bodyHtml') ?? '').trim(),
		category: String(form.get('category') ?? ''),
		startsAt: String(form.get('startsAt') ?? ''),
		endsAt: String(form.get('endsAt') ?? ''),
		location: String(form.get('location') ?? '').trim()
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

/** The sentence for a Sampul the service refuses, or `undefined` when it accepts it. */
function coverImageRefusal(image: CoverImageUpload): string | undefined {
	try {
		assertAcceptableCoverImage(image);
		return undefined;
	} catch (caught) {
		if (caught instanceof PostRuleError) {
			return ruleMessage(caught.rule);
		}
		throw caught;
	}
}

/** The submitted type, defaulted to the first one the schema knows when nothing recognisable came. */
function parseType(value: string): PostType {
	return POST_TYPES.find((type) => type === value) ?? POST_TYPES[0];
}

/**
 * A `datetime-local` value as an instant, `null` when the field was left empty, or the string
 * `'invalid'` when it holds something that is not a moment at all.
 *
 * A `datetime-local` input carries no time zone, so this reads it in the server's own zone — which
 * is the complex's zone in any real deployment. `src/lib/server/ports/clock.ts` settles that a zone
 * is a property of the complex rather than of the clock, and building a zone-aware helper is not
 * this ticket's job; what matters here is that the same zone is used to parse a submitted value and
 * to render a stored one back into the field, so a round trip does not move an event by hours.
 */
function parseLocalInstant(value: string): Date | null | 'invalid' {
	if (value === '') {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed;
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

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` for the same reason the unit screens' copies of this
 * helper are.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminPosts_forbidden());
	}
	throw caught;
}
