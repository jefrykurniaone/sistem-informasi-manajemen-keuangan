import * as m from '$lib/paraglide/messages';
import { isLocale } from '$lib/paraglide/runtime';
import type { EmailPayload, EmailTemplate, EmailTemplates } from '$lib/server/ports/email';

/**
 * The email that tells a subscribed resident a Post reached the public board: its title, its
 * summary, and a link — never the body. `src/lib/server/services/post/notification.ts` is the only
 * caller, and only for a Post's first publication; see that module's doc comment for why a
 * re-publish never reaches here a second time.
 *
 * **This is the one template that renders through Paraglide instead of a hand-written string.**
 * Every other template in this directory writes fixed Indonesian text, because every other kind is
 * transactional — sent about something the recipient themselves did, in the language the whole
 * application already answers a signed-out visitor in. This one is sent because a resident opted
 * into a Langganan, and the acceptance criteria for #41 ask for it to go through
 * `messages/id.json` / `messages/en.json` and an explicit `locale` in the payload, so that a later
 * spec that starts storing a resident's own language preference only has to change what locale this
 * payload carries — never this template. Until that exists, `notifyNewPost` always passes the base
 * locale, `'id'`, because `subscriptions` has no language column: `docs/spec-konten-v1.md` names no
 * per-resident language and the interface locale today is a browser cookie, not a fact about a
 * resident's row.
 *
 * The same refusal shape as every other template here: a payload that is not shaped the way this
 * one expects throws `TypeError`, so the worker fails that one queue row permanently instead of
 * retrying text that will never render.
 */

/** The `kind` stored on the queue row, and the key this template is registered under. */
export const NEW_POST_KIND = 'new-post';

/** What this email needs in order to be written. */
export interface NewPostEmailValues {
	/** The Post's title, exactly as the admin screen saved it. */
	readonly title: string;
	/** `posts.summary`. Never the Markdown body — that is the one rule this email exists to keep. */
	readonly summary: string;
	/** The absolute address of the public page, `${ORIGIN}/posts/${post.id}`. */
	readonly url: string;
	/** Which Paraglide locale renders the fixed text. `'id'` until a resident's own language is stored. */
	readonly locale: string;
}

/** Builds the payload for a queue row of kind `new-post`. */
export function newPostPayload(values: NewPostEmailValues): EmailPayload {
	return {
		title: values.title,
		summary: values.summary,
		url: values.url,
		locale: values.locale
	};
}

/** Writes the new-post notification email, in the payload's own `locale`. */
export const newPostTemplate: EmailTemplate = (payload) => {
	const { title, summary, url, locale } = payload;
	if (
		typeof title !== 'string' ||
		typeof summary !== 'string' ||
		typeof url !== 'string' ||
		!isLocale(locale)
	) {
		throw new TypeError(
			`An email of kind "${NEW_POST_KIND}" needs a title, a summary, a url and a locale that is one of the application's locales, all strings.`
		);
	}

	return {
		subject: m.emailNewPost_subject({ title }, { locale }),
		text: [
			m.emailNewPost_greeting({}, { locale }),
			'',
			m.emailNewPost_intro({ title }, { locale }),
			'',
			summary,
			'',
			m.emailNewPost_linkLabel({}, { locale }),
			url,
			'',
			m.emailNewPost_footer({}, { locale })
		].join('\n')
	};
};

/** This template, keyed by its kind, ready to be merged into the set the worker is given. */
export const newPostTemplates: EmailTemplates = {
	[NEW_POST_KIND]: newPostTemplate
};
