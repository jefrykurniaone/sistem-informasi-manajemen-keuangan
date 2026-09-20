import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { database } from '$lib/server/db';
import { renderPostBody } from '$lib/server/services/post/markdown';
import { assertUuidParam } from '$lib/server/services/identifier';
import { PostNotFoundError } from '$lib/server/services/post';
import { getPublishedPost } from '$lib/server/services/post/public';
import { systemClock } from '$lib/server/ports/clock';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { PageServerLoad } from './$types';

/**
 * The one Post a shared link opens — story 14: "membuka tautan sebuah kegiatan dan membacanya,
 * supaya tautan yang dibagikan di grup berguna." No session is read here at all, which is what
 * proves the success criterion "halaman kegiatan yang sudah terbit dapat dibuka di peramban tanpa
 * sesi": there is no `locals.user` check to bypass, because none exists on this route.
 *
 * `getPublishedPost` is what makes story 15 hold even against a guessed id — see its own doc
 * comment in `$lib/server/services/post/public.ts`. A `draft` or an `archived` Post answers exactly
 * like one that was never written: `PostNotFoundError` becomes `error(404, …)`, the same
 * translation `(app)/admin/posts/[id]/+page.server.ts` makes for the same class.
 *
 * `bodyHtml` is `renderPostBody`'s output and nothing else, handed to `+page.svelte`'s
 * `post-preview.svelte` exactly the way `(app)/admin/posts/[id]/+page.server.ts` already does for
 * its own preview — see `post-preview.svelte`'s doc comment for why nothing else may reach
 * `{@html …}`.
 *
 * `shareUrl` and the cover image's signed link are both built as absolute URLs, because the
 * acceptance criterion this route exists for is what a link pasted into WhatsApp shows, and
 * `og:url` / `og:image` are read by a server that has no notion of "relative to this site". The
 * cover image's link is the gap this ticket's delivery report names: `LocalFileStore.signedLink`
 * returns a path under `SIGNED_LINK_BASE_PATH`, and no route in this repository serves it yet, so
 * the `<img>` and `og:image` built from it 404 until a `ServedFileStore` route exists — a new
 * route this ticket's `writes:` does not include.
 */

export const load: PageServerLoad = async ({ params, url }) => {
	// `params.id` reaches no session check on this route at all — see the doc comment above — so an
	// id shaped like `new` (the sibling `/admin/posts/new` route's own segment) or any other
	// non-uuid string must be refused before it ever reaches `getPublishedPost`'s `uuid` comparison.
	// See #111 and `$lib/server/services/identifier.ts`.
	assertUuidParam(params.id, m.postPublic_notFound());

	let post;
	try {
		post = await getPublishedPost(database(), params.id);
	} catch (caught) {
		if (caught instanceof PostNotFoundError) {
			throw error(404, m.postPublic_notFound());
		}
		throw caught;
	}

	const fileStore = localFileStoreFromEnvironment(systemClock);
	const coverImageUrl = post.coverImageKey
		? toAbsoluteUrl(url, await fileStore.signedLink(post.coverImageKey))
		: null;

	return {
		post: {
			id: post.id,
			type: post.type,
			category: post.category,
			title: post.title,
			summary: post.summary,
			location: post.location,
			startsAtLabel: formatInstant(post.startsAt),
			endsAtLabel: formatInstant(post.endsAt),
			coverImageUrl
		},
		bodyHtml: renderPostBody(post.bodyMarkdown),
		shareUrl: `${url.origin}${url.pathname}`
	};
};

/** `link`, made absolute against `base`'s origin. `LocalFileStore.signedLink` only ever returns a path. */
function toAbsoluteUrl(base: URL, link: string): string {
	return new URL(link, base.origin).toString();
}

/**
 * An instant as a sentence, in the interface locale, or `null` when there is no instant. Copied
 * from `(app)/admin/posts/+page.server.ts`'s helper of the same name — a route helper belongs next
 * to the route that uses it, as that file's own comment explains.
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
