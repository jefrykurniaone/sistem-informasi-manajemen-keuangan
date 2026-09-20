import sanitizeHtml from 'sanitize-html';

/**
 * Filtering a Post's HTML down to what a browser is allowed to see.
 *
 * This module is the security boundary of the announcement board. `docs/spec-post-editor-v1.md`
 * replaces the Markdown body the board started with by the HTML a rich-text editor produces, and
 * `docs/spec-konten-v1.md`'s reason for filtering it is unchanged and is the reason both callers
 * below exist: "halaman ini bisa dibuka tanpa masuk, dan skrip yang lolos di halaman publik adalah
 * kerugian yang tidak bisa ditarik kembali".
 *
 * ## One filter, called at two points
 *
 * `sanitizePostHtml` runs **when a Post is saved**, so that nothing dangerous is ever written to
 * `posts.body_html` in the first place, and **again when a Post is rendered**, so that narrowing
 * the whitelist below reaches rows that were written while it was wider. Neither pass makes the
 * other redundant: the save-time pass is what keeps a stored row honest against anything that reads
 * it later, and the render-time pass is what keeps a page honest against anything that wrote the
 * row — including a row written before this list was last changed, or by a path nobody has thought
 * of yet. `src/lib/server/services/post/index.ts` holds the first call and
 * `src/lib/server/services/post/public.ts` the second.
 *
 * `sanitize-html` parses the HTML and rebuilds it from a whitelist, dropping every tag and every
 * attribute the list below does not name. Nothing here tries to recognise dangerous input; the list
 * says what is allowed and everything else is gone, which is the only shape of this rule that stays
 * correct against an attack nobody thought of.
 *
 * No part of this is hand-rolled with a regular expression. A whitelist written as a pattern over
 * HTML is both wrong (HTML is not a regular language) and a backtracking hazard; the parser does
 * the work instead.
 *
 * ## Where the output goes
 *
 * The rendered result is HTML meant for `{@html …}`. That is the whole point of it, and it is the
 * only value in this application for which that is true. A caller that puts anything else through
 * `{@html …}` is outside what this module promises.
 *
 * ## The whitelist, and why each decision went the way it did
 *
 * What the spec's user stories actually ask the body to carry is lists, emphasis, headings, links,
 * quotes, code and tables. Every one of those survives. The list is unchanged from the one this
 * module replaced — same tags, same attributes, same link schemes — because the editor #140 builds
 * is being fitted to the whitelist rather than the whitelist widened to the editor.
 *
 * - **Tables survive, alignment included.** Alignment reaches the browser as `align="left"` on `th`
 *   and `td`, so those two attributes are on the list. `align` is a presentational attribute with
 *   no scripting surface; dropping it would silently reflow every table an author aligned.
 * - **Links survive; their schemes do not, unless they are one of four.** `http`, `https`, `mailto`
 *   and `tel` — enough for a link to a map, a government page, a phone number or an email address,
 *   and nothing else. `javascript:` is the attack this closes, and `data:` is refused too, because
 *   a `data:text/html` link is a same-origin script by another name. `ftp` is in `sanitize-html`'s
 *   own default list and is deliberately removed here: no announcement in this complex needs it.
 *   `allowProtocolRelative: false` closes `//evil.example/x`, which has no scheme to check at all.
 *   `target` is not allowed, so every link opens in the same tab and reverse tabnabbing has no
 *   opening to work through.
 * - **`img` is not on the list, on purpose.** The one image this spec gives a Post is the cover
 *   image, which is uploaded through the `FileStore` port and stored by this application. A body
 *   `<img>` would point at a host this application does not control, on a page that is open without
 *   an account: every visitor's address would be handed to that host on load, and the author who
 *   pasted the URL would have no idea. Widening this later is one entry plus a rule about which
 *   origins a `src` may name; widening it now would be widening it without either.
 * - **A checkbox loses its `<input>` and keeps its text.** An `<input>` on a public page is form
 *   surface for the sake of a tick mark nobody can click, so the tag goes and the words stay.
 * - **A code block keeps its `<pre><code>` and loses its `language-…` class.** No syntax
 *   highlighter reads that class today. `class` is not on the list at all, which also means no
 *   author can reach into this application's stylesheet from inside a post body.
 * - **`h1` through `h6` all survive.** The page that displays a Post owns where those headings sit
 *   in its own outline — this module owns whether they are safe, and a heading is.
 * - **`script`, `style`, `textarea`, `option` and `noscript` lose their text as well as their
 *   tags.** For every other disallowed tag the text between the tags is kept, which is what makes a
 *   stray `<div>` harmless rather than destructive. For these five, the text *is* the payload —
 *   keeping the body of a `<script>` would print the attack into the page as prose.
 * - **No attribute is allowed on any tag except the three named below.** Event handlers are not
 *   listed as forbidden anywhere here, and they do not need to be: `onerror`, `onclick` and every
 *   other `on…` attribute is simply not on the list, so it never survives. A whitelist that had to
 *   enumerate the dangerous attributes would be one release behind the next one invented.
 */

/** Every HTML tag a Post body may contain. Anything else loses its tag. */
export const ALLOWED_POST_BODY_TAGS: readonly string[] = [
	'p',
	'br',
	'hr',
	'blockquote',
	'pre',
	'code',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'ul',
	'ol',
	'li',
	'strong',
	'em',
	'del',
	'a',
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'th',
	'td'
];

/** Every attribute a Post body may carry, per tag. Anything else is dropped. */
export const ALLOWED_POST_BODY_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
	a: ['href', 'title'],
	th: ['align'],
	td: ['align']
};

/** The only URL schemes a link in a Post body may use. */
export const ALLOWED_POST_BODY_SCHEMES: readonly string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * The tags whose text content is discarded along with the tag itself, because for these the text
 * between the tags is the payload rather than something an author wrote to be read.
 */
const NON_TEXT_TAGS: readonly string[] = ['script', 'style', 'textarea', 'option', 'noscript'];

/** How `sanitize-html` is asked to filter a Post body. */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [...ALLOWED_POST_BODY_TAGS],
	allowedAttributes: Object.fromEntries(
		Object.entries(ALLOWED_POST_BODY_ATTRIBUTES).map(([tag, attributes]) => [tag, [...attributes]])
	),
	allowedSchemes: [...ALLOWED_POST_BODY_SCHEMES],
	allowProtocolRelative: false,
	// Keep the words inside a tag that is not allowed, drop only the tag — except for the five in
	// `NON_TEXT_TAGS`, where the words are the attack.
	disallowedTagsMode: 'discard',
	nonTextTags: [...NON_TEXT_TAGS]
};

/**
 * `html`, rebuilt from the whitelist above — the only form of a Post body that may reach
 * `{@html …}`.
 *
 * Idempotent, which is what lets the service call it on the way in and a page call it again on the
 * way out: the output already contains only allowed tags and attributes, so a second pass has
 * nothing left to remove.
 *
 * @param html the editor's output on the way in, or `posts.bodyHtml` on the way out.
 * @returns HTML containing only the tags and attributes named above. Never a `<script>`, never an
 *   event handler, never a `javascript:` link — see this module's doc comment for the whole list
 *   and for what each decision costs.
 */
export function sanitizePostHtml(html: string): string {
	return sanitizeHtml(html, SANITIZE_OPTIONS);
}
