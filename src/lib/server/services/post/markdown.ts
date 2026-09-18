import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * Turning a Post's Markdown into the HTML a browser is allowed to see.
 *
 * This module is the security boundary of the announcement board. `docs/spec-konten-v1.md` settles
 * both halves of it: "Isi ditulis Markdown dan dibersihkan saat ditampilkan" — Markdown becomes
 * HTML and is filtered against a whitelist of tags and attributes before it is displayed — and the
 * reason it matters even though the authors are trusted admins: "halaman ini bisa dibuka tanpa
 * masuk, dan skrip yang lolos di halaman publik adalah kerugian yang tidak bisa ditarik kembali".
 *
 * ## Two stages, and why the second one is not optional
 *
 * `marked` turns Markdown into HTML. It is not a sanitizer and has not tried to be one since it
 * removed its own `sanitize` option: Markdown lets an author write raw HTML, and `marked` passes
 * that raw HTML through untouched — `<script>alert(1)</script>` in the body comes out of `marked`
 * as `<script>alert(1)</script>`. `sanitize-html` then parses that HTML and rebuilds it from a
 * whitelist, dropping every tag and every attribute the list below does not name. Nothing here
 * tries to recognise dangerous input; the list says what is allowed and everything else is gone,
 * which is the only shape of this rule that stays correct against an attack nobody thought of.
 *
 * No part of this is hand-rolled with a regular expression. A whitelist written as a pattern over
 * HTML is both wrong (HTML is not a regular language) and a backtracking hazard; the parser does
 * the work instead.
 *
 * ## Where the output goes
 *
 * `renderPostBody` returns HTML meant for `{@html …}`. That is the whole point of it, and it is the
 * only value in this application for which that is true. A caller that puts anything else through
 * `{@html …}` is outside what this module promises.
 *
 * ## The whitelist, and why each decision went the way it did
 *
 * What the spec's user stories actually ask the body to carry is lists, emphasis, headings, links,
 * quotes, code and tables. Every one of those survives; the list was checked against real `marked`
 * output for each of them rather than guessed, because a whitelist that quietly kills the tables an
 * author needs is as much a failure as one that lets a script through.
 *
 * - **Tables survive, alignment included.** GFM alignment reaches the browser as `align="left"` on
 *   `th` and `td`, so those two attributes are on the list. `align` is a presentational attribute
 *   with no scripting surface; dropping it would silently reflow every table an author aligned.
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
 *   pasted the URL would have no idea. Nothing in the spec's user stories asks for images inside
 *   the body — story 6 asks for a cover image and stops there. The admin write screen says so in
 *   its own hint rather than letting an author wonder where their picture went. Widening this later
 *   is one entry plus a rule about which origins a `src` may name; widening it now would be
 *   widening it without either.
 * - **GFM task-list checkboxes lose their `<input>` and keep their text.** `- [ ] beli air` becomes
 *   a plain list item reading "beli air". An `<input>` on a public page is form surface for the sake
 *   of a tick mark nobody can click, so the tag goes and the words stay.
 * - **A code block keeps its `<pre><code>` and loses its `language-…` class.** No syntax
 *   highlighter reads that class today. `class` is not on the list at all, which also means no
 *   author can reach into this application's stylesheet from inside a post body.
 * - **`h1` through `h6` all survive.** An author who typed `#` gets a heading rather than a line
 *   that silently lost its markup. The page that displays a Post owns where those headings sit in
 *   its own outline — this module owns whether they are safe, and a heading is.
 * - **`script`, `style`, `textarea`, `option` and `noscript` lose their text as well as their
 *   tags.** For every other disallowed tag the text between the tags is kept, which is what makes a
 *   stray `<div>` harmless rather than destructive. For these five, the text *is* the payload —
 *   keeping the body of a `<script>` would print the attack into the page as prose.
 * - **No attribute is allowed on any tag except the three named below.** Event handlers are not
 *   listed as forbidden anywhere here, and they do not need to be: `onerror`, `onclick` and every
 *   other `on…` attribute is simply not on the list, so it never survives. A whitelist that had to
 *   enumerate the dangerous attributes would be one release behind the next one invented.
 */

/** Every HTML tag a rendered Post body may contain. Anything else loses its tag. */
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

/** Every attribute a rendered Post body may carry, per tag. Anything else is dropped. */
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

/** How `marked` is asked to read a Post body. Named so that a test parses exactly what a page does. */
const MARKDOWN_OPTIONS = {
	/** Tables and strikethrough, which the whitelist above keeps. */
	gfm: true,
	/** A single newline stays a single newline; a paragraph break needs a blank line. */
	breaks: false,
	/** The CommonMark-ish rules `marked` uses by default, not the original perl script's bugs. */
	pedantic: false,
	/** Synchronous, so that this function can be one too and a test needs no await to read it. */
	async: false
} as const;

/** How `sanitize-html` is asked to filter what `marked` produced. */
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
 * The Markdown of a Post body, as HTML that is safe to put through `{@html …}`.
 *
 * @param bodyMarkdown what the author typed, exactly as `posts.bodyMarkdown` stores it.
 * @returns HTML containing only the tags and attributes named above. Never a `<script>`, never an
 *   event handler, never a `javascript:` link — see this module's doc comment for the whole list
 *   and for what each decision costs.
 */
export function renderPostBody(bodyMarkdown: string): string {
	const html = marked.parse(bodyMarkdown, MARKDOWN_OPTIONS);
	return sanitizeHtml(html, SANITIZE_OPTIONS);
}
