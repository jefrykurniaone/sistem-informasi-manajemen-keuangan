import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { POST_STATUS, POST_TYPES, type PostType } from '$lib/server/db/schema/post';
import { assertUuidParam } from '$lib/server/services/identifier';
import { systemClock } from '$lib/server/ports/clock';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import {
	archivePost,
	assertAcceptableCoverImage,
	COVER_IMAGE_CONTENT_TYPES,
	getPost,
	isAllowedPostTransition,
	POST_CATEGORIES,
	POST_RULE,
	PostNotFoundError,
	PostRuleError,
	PostTransitionError,
	publishPost,
	removePostCoverImage,
	setPostCoverImage,
	updatePost,
	type CoverImageUpload,
	type PostRule
} from '$lib/server/services/post';
import type { Actions, PageServerLoad } from './$types';

/**
 * The one screen an admin does everything else to a Post from: edit it, change its Sampul, publish
 * it and archive it. `docs/spec-konten-v1.md`'s stories 6, 8, 9 and 10 land here.
 *
 * Story 4's separate preview is gone as of #140: the editor on the form renders the body as it is
 * typed, so a `?/preview` round trip could only ever show what was already on the screen. The
 * `?/uploadCover` action is gone with it — the Sampul is a field of the write form now, which is
 * what lets a Post be created with its picture already on it rather than published without one
 * because the admin left the screen too early.
 *
 * Follows the shape `(app)/admin/units/[id]/+page.server.ts` settled: `PermissionDeniedError`
 * becomes `error(403, …)` and `PostNotFoundError` becomes `error(404, …)`, both here rather than in
 * the service, while a named rule refusal or a refused status change is a rejected form —
 * `fail(400, …)` — because the actor was inside their rights and the specific change is what was
 * wrong.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}
	// `posts.id` is a `uuid` column, and a non-uuid `params.id` must be refused here rather than
	// reach `getPost`'s comparison — see #111 and `$lib/server/services/identifier.ts`.
	assertUuidParam(params.id, m.adminPosts_notFound());

	try {
		const post = await getPost(database(), locals.user.id, params.id);
		return {
			post: {
				id: post.id,
				type: post.type,
				status: post.status,
				category: post.category,
				title: post.title,
				summary: post.summary,
				location: post.location,
				authorName: post.authorName,
				coverImageKey: post.coverImageKey,
				publishedAtLabel: formatInstant(post.publishedAt),
				startsAtLabel: formatInstant(post.startsAt),
				endsAtLabel: formatInstant(post.endsAt)
			},
			values: {
				type: post.type,
				title: post.title,
				summary: post.summary,
				bodyHtml: post.bodyHtml,
				category: post.category,
				startsAt: toLocalInputValue(post.startsAt),
				endsAt: toLocalInputValue(post.endsAt),
				location: post.location ?? ''
			},
			categories: POST_CATEGORIES,
			types: POST_TYPES,
			coverImageContentTypes: COVER_IMAGE_CONTENT_TYPES,
			canPublish: isAllowedPostTransition(post.status, POST_STATUS.published),
			canArchive: isAllowedPostTransition(post.status, POST_STATUS.archived)
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	update: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}
		assertUuidParam(params.id, m.adminPosts_notFound());

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

		// Checked before anything is written, for the same reason the write screen checks it there —
		// see `assertAcceptableCoverImage` in `$lib/server/services/post`.
		const coverImage = await readCoverImage(form);
		const coverRefusal = coverImage && coverImageRefusal(coverImage);
		if (coverRefusal) {
			return fail(400, { message: coverRefusal, values });
		}

		try {
			await updatePost(database(), systemClock, {
				actorId: locals.user.id,
				postId: params.id,
				type: parseType(values.type),
				title: values.title,
				summary: values.summary,
				bodyHtml: values.bodyHtml,
				category: values.category,
				startsAt,
				endsAt,
				location: values.location || null
			});
			await saveCoverImage(
				locals.user.id,
				params.id,
				coverImage,
				form.get('removeCoverImage') !== null
			);
		} catch (caught) {
			if (caught instanceof PostRuleError) {
				return fail(400, { message: ruleMessage(caught.rule), values });
			}
			if (caught instanceof TypeError) {
				return fail(400, { message: m.adminPosts_invalidForm(), values });
			}
			throwAsRouteError(caught);
		}

		return { message: m.adminPosts_updatedMessage() };
	},

	publish: async ({ locals, params }) => {
		return moveStatus(locals.user, params.id, publishPost, m.adminPosts_publishedMessage());
	},

	archive: async ({ locals, params }) => {
		return moveStatus(locals.user, params.id, archivePost, m.adminPosts_archivedMessage());
	}
};

/**
 * The Sampul the form carried, or `undefined` when its field was left empty. The copy on
 * `(app)/admin/posts/new/+page.server.ts` carries the note about why an empty size is the test.
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

/**
 * Attaches, replaces or takes away this Post's Sampul, after its content has been saved.
 *
 * A chosen file beats a ticked "hapus Sampul". The two together are a contradiction, and of the two
 * the file is the one the person went and picked, so it is the one this honours; the checkbox on its
 * own still removes.
 */
async function saveCoverImage(
	actorId: string,
	postId: string,
	image: CoverImageUpload | undefined,
	removeRequested: boolean
): Promise<void> {
	if (image) {
		await setPostCoverImage(database(), systemClock, localFileStoreFromEnvironment(systemClock), {
			actorId,
			postId,
			...image
		});
		return;
	}
	if (removeRequested) {
		await removePostCoverImage(
			database(),
			systemClock,
			localFileStoreFromEnvironment(systemClock),
			{ actorId, postId }
		);
	}
}

/** What `publishPost` and `archivePost` both look like to this route. */
type StatusMove = typeof publishPost;

/** Shared body of the `publish` and `archive` actions: they differ only in which move and message. */
async function moveStatus(
	actor: App.Locals['user'],
	postId: string,
	move: StatusMove,
	message: string
) {
	if (!actor) {
		redirect(303, AUTH_PATHS.login);
	}
	assertUuidParam(postId, m.adminPosts_notFound());

	try {
		await move(database(), systemClock, { actorId: actor.id, postId });
	} catch (caught) {
		if (caught instanceof PostTransitionError) {
			return fail(400, {
				message: m.adminPosts_transitionRefused({ from: caught.from, to: caught.to })
			});
		}
		throwAsRouteError(caught);
	}

	return { message };
}

/**
 * What the write form carries, trimmed, as strings. `(app)/admin/posts/new/+page.server.ts` carries
 * its own copy — see the note there.
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

/** The submitted type, defaulted to the first one the schema knows when nothing recognisable came. */
function parseType(value: string): PostType {
	return POST_TYPES.find((type) => type === value) ?? POST_TYPES[0];
}

/**
 * A `datetime-local` value as an instant, `null` for an empty field, or `'invalid'` for something
 * that is not a moment. Read in the server's own zone — see the longer note on the copy of this
 * helper in `(app)/admin/posts/new/+page.server.ts`, and `toLocalInputValue` below, which is its
 * other half.
 */
function parseLocalInstant(value: string): Date | null | 'invalid' {
	if (value === '') {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed;
}

/**
 * An instant as the `YYYY-MM-DDTHH:mm` a `datetime-local` input reads, in the server's own zone —
 * the same zone `parseLocalInstant` reads a submitted value in, so that opening a saved kegiatan and
 * saving it again without touching the field leaves its time exactly where it was.
 */
function toLocalInputValue(instant: Date | null): string {
	if (!instant) {
		return '';
	}
	const pad = (value: number): string => String(value).padStart(2, '0');
	const date = `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
	return `${date}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

/**
 * An instant as a sentence, in the interface locale, or `null` when there is no instant. The copy
 * on `(app)/admin/posts/+page.server.ts` carries the note about why the formatting happens here
 * rather than in the page.
 */
function formatInstant(instant: Date | null): string | null {
	if (!instant) {
		return null;
	}
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: 'full',
		timeStyle: 'short'
	}).format(instant);
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
 * Turns a caught permission refusal into a 403, or a caught missing Post into a 404, and throws it —
 * or rethrows whatever else it was. Always throws, for the same reason the unit screens' copies of
 * this helper are declared `never`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminPosts_forbidden());
	}
	if (caught instanceof PostNotFoundError) {
		throw error(404, m.adminPosts_notFound());
	}
	throw caught;
}
