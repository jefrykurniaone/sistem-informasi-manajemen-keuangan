import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { civilDayOf, formatDateTime, formatTime } from '#lib/time.ts';
import { POST_STATUS, POST_TYPES, type PostType } from '#lib/server/db/schema/post.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	requireUuidParam,
	throwRouteError,
	type FormMessages,
	type PageMessages,
	type RouteDependencies,
	type SignedInUser
} from '#lib/server/route-action.ts';
import {
	archivePost,
	assertAcceptableCoverImage,
	COVER_IMAGE_CONTENT_TYPES,
	getPost,
	isAllowedPostTransition,
	POST_CATEGORIES,
	POST_RULE,
	PostRuleError,
	PostTransitionError,
	publishPost,
	removePostCoverImage,
	setPostCoverImage,
	updatePost,
	type CoverImageUpload,
	type PostRule
} from '#lib/server/services/post/index.ts';
import { combineCivilDateTime } from '#lib/server/services/post/time.ts';
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
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): `PermissionDeniedError`
 * becomes `error(403, …)` and `PostNotFoundError` becomes `error(404, …)`, both here rather than in
 * the service, while a rule refusal or a refused status change is a rejected form —
 * `fail(400, …)` — because the actor was inside their rights and the specific change is what was
 * wrong.
 */

/** The 403 for anyone who may not manage Posts, and the 404 for an id that names no Post. */
const PAGE = {
	forbidden: m.adminPosts_forbidden,
	notFound: m.adminPosts_notFound
} satisfies PageMessages;

/**
 * `update`: a named rule refusal reads its own sentence, and a `TypeError` from the service's own
 * validation reads the invalid-form sentence, as it did before #318.
 */
const UPDATE_FORM = {
	...PAGE,
	fallback: m.adminPosts_invalidForm,
	refusals: [
		refusal(PostRuleError, ({ error }) => ruleMessage(error.rule)),
		refusal(TypeError, m.adminPosts_invalidForm)
	]
} satisfies FormMessages;

/** `publish` and `archive`: a status change the Post's current status does not allow. */
const STATUS_FORM = {
	...PAGE,
	fallback: m.adminPosts_invalidForm,
	refusals: [
		refusal(PostTransitionError, ({ error }) =>
			m.adminPosts_transitionRefused({ from: error.from, to: error.to })
		)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	// `posts.id` is a `uuid` column, and a non-uuid `params.id` must be refused here rather than
	// reach `getPost`'s comparison — see #111 and `#lib/server/services/identifier.ts`.
	const postId = requireUuidParam(params.id, PAGE);

	const { db } = productionDependencies();
	try {
		const post = await getPost(db, user.id, postId);
		const startsAtFields = civilDateAndTimeOf(post.startsAt);
		const endsAtFields = civilDateAndTimeOf(post.endsAt);
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
				startsAtDate: startsAtFields.date,
				startsAtTime: startsAtFields.time,
				endsAtDate: endsAtFields.date,
				endsAtTime: endsAtFields.time,
				location: post.location ?? ''
			},
			categories: POST_CATEGORIES,
			types: POST_TYPES,
			coverImageContentTypes: COVER_IMAGE_CONTENT_TYPES,
			canPublish: isAllowedPostTransition(post.status, POST_STATUS.published),
			canArchive: isAllowedPostTransition(post.status, POST_STATUS.archived)
		};
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	update: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const postId = requireUuidParam(params.id, PAGE);

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

		// Checked before anything is written, for the same reason the write screen checks it there —
		// see `assertAcceptableCoverImage` in `#lib/server/services/post/index.ts`.
		const coverImage = await readCoverImage(form);
		if (coverImage) {
			try {
				assertAcceptableCoverImage(coverImage);
			} catch (caught) {
				return failOrThrow(caught, UPDATE_FORM, { values });
			}
		}

		const dependencies = productionDependencies();
		try {
			await updatePost(dependencies.db, dependencies.clock, {
				actorId: user.id,
				postId,
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
				dependencies,
				user.id,
				postId,
				coverImage,
				form.get('removeCoverImage') !== null
			);
		} catch (caught) {
			return failOrThrow(caught, UPDATE_FORM, { values });
		}

		return { message: m.adminPosts_updatedMessage() };
	},

	publish: async ({ locals, params }) => {
		return moveStatus(requireUser(locals), params.id, publishPost, m.adminPosts_publishedMessage());
	},

	archive: async ({ locals, params }) => {
		return moveStatus(requireUser(locals), params.id, archivePost, m.adminPosts_archivedMessage());
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

/**
 * Attaches, replaces or takes away this Post's Sampul, after its content has been saved.
 *
 * A chosen file beats a ticked "hapus Sampul". The two together are a contradiction, and of the two
 * the file is the one the person went and picked, so it is the one this honours; the checkbox on its
 * own still removes.
 *
 * `dependencies.fileStore` is read only inside the branch that touches the Sampul: reading it builds
 * the store from `FILE_STORE_SECRET`, and a Post saved without touching its Sampul must not need it.
 */
async function saveCoverImage(
	dependencies: RouteDependencies,
	actorId: string,
	postId: string,
	image: CoverImageUpload | undefined,
	removeRequested: boolean
): Promise<void> {
	if (image) {
		await setPostCoverImage(dependencies.db, dependencies.clock, dependencies.fileStore, {
			actorId,
			postId,
			...image
		});
		return;
	}
	if (removeRequested) {
		await removePostCoverImage(dependencies.db, dependencies.clock, dependencies.fileStore, {
			actorId,
			postId
		});
	}
}

/** What `publishPost` and `archivePost` both look like to this route. */
type StatusMove = typeof publishPost;

/** Shared body of the `publish` and `archive` actions: they differ only in which move and message. */
async function moveStatus(
	actor: SignedInUser,
	postIdParam: string,
	move: StatusMove,
	message: string
) {
	const postId = requireUuidParam(postIdParam, PAGE);

	const { db, clock } = productionDependencies();
	try {
		await move(db, clock, { actorId: actor.id, postId });
	} catch (caught) {
		return failOrThrow(caught, STATUS_FORM);
	}

	return { message };
}

/**
 * What the write form carries, as strings: the typed text trimmed, the type, the category and the
 * date and time boxes exactly as posted. `(app)/admin/posts/new/+page.server.ts` carries its own
 * copy — see the note there.
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

/** The submitted type, defaulted to the first one the schema knows when nothing recognisable came. */
function parseType(value: string): PostType {
	return POST_TYPES.find((type) => type === value) ?? POST_TYPES[0];
}

/**
 * `date-time-fields.svelte`'s two boxes' initial values for a stored instant, in `COMPLEX_TIME_ZONE`
 * (WIB) — `civilDayOf` for the date box and a colon-separated `formatTime` for the time box, both
 * empty strings for `null`. So that opening a saved kegiatan and saving it again without touching a
 * field leaves its time exactly where it was, this is the other half of `combineCivilDateTime`,
 * which reads the same two boxes back in the same zone.
 *
 * `formatTime` is built for a label a person reads — `id-ID`'s own `10.30 WIB` — so its result is cut
 * down to what the time box's `pattern` requires: the zone name and the space before it dropped, and
 * the full stop `id-ID` separates hours and minutes with turned into the colon the box needs.
 */
function civilDateAndTimeOf(instant: Date | null): { date: string; time: string } {
	if (!instant) {
		return { date: '', time: '' };
	}
	const [clock] = formatTime(instant).split(' ');
	return { date: civilDayOf(instant), time: clock.replace('.', ':') };
}

/**
 * An instant as a sentence, labelled with the WIB zone, or `null` when there is no instant —
 * `formatDateTime` from `#lib/time.ts`. The copy on `(app)/admin/posts/+page.server.ts` carries the
 * note about why the formatting happens here rather than in the page.
 */
function formatInstant(instant: Date | null): string | null {
	return instant && formatDateTime(instant);
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
