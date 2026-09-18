import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { POST_TYPES, type PostType } from '$lib/server/db/schema/post';
import { systemClock } from '$lib/server/ports/clock';
import {
	assertMayManagePosts,
	createPost,
	POST_CATEGORIES,
	POST_RULE,
	PostRuleError,
	type PostRule
} from '$lib/server/services/post';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen an admin writes a new Post on. It always saves a draft — publishing is a separate,
 * audited step on `(app)/admin/posts/[id]`, per `docs/spec-konten-v1.md`'s stories 5 and 8 — and it
 * redirects to that screen on success so that previewing, uploading a cover and publishing all
 * happen in one place.
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

	return { categories: POST_CATEGORIES, types: POST_TYPES };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const values = readPostFormValues(form);
		if (values.title === '' || values.summary === '' || values.bodyMarkdown === '') {
			return fail(400, { message: m.adminPosts_invalidForm(), values });
		}

		const startsAt = parseLocalInstant(values.startsAt);
		const endsAt = parseLocalInstant(values.endsAt);
		if (startsAt === 'invalid' || endsAt === 'invalid') {
			return fail(400, { message: m.adminPosts_invalidTime(), values });
		}

		let createdId: string;
		try {
			const created = await createPost(database(), systemClock, {
				actorId: locals.user.id,
				type: parseType(values.type),
				title: values.title,
				summary: values.summary,
				bodyMarkdown: values.bodyMarkdown,
				category: values.category,
				startsAt,
				endsAt,
				location: values.location || null
			});
			createdId = created.id;
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
		bodyMarkdown: String(form.get('bodyMarkdown') ?? '').trim(),
		category: String(form.get('category') ?? ''),
		startsAt: String(form.get('startsAt') ?? ''),
		endsAt: String(form.get('endsAt') ?? ''),
		location: String(form.get('location') ?? '').trim()
	};
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
