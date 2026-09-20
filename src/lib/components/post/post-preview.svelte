<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { POST_CATEGORY_LABEL, POST_TYPE_LABEL } from './post-form.svelte';

	/**
	 * A Post as a resident reads it. It shows and it changes nothing; the screen around it owns every
	 * button.
	 *
	 * It was written for `docs/spec-konten-v1.md`'s story 4 — the admin preview before publishing —
	 * and `(public)/posts/[id]` is its only caller since #140, where the editor on the write form
	 * became the preview. The name is kept rather than churned: this is still the one place that
	 * decides what a rendered Post looks like, which is what both callers ever wanted from it.
	 *
	 * ## `bodyHtml` and `{@html …}`
	 *
	 * `bodyHtml` must be the output of `sanitizePostHtml` in
	 * `src/lib/server/services/post/sanitize.ts`, and nothing else — reached through
	 * `previewPostBody` on the admin screen or `renderPublicPostBody` on the public one. That
	 * function rebuilds the HTML from a whitelist of tags and attributes, so what arrives here has no
	 * `<script>`, no event handler and no `javascript:` link left in it —
	 * `tests/unit/post-sanitize.test.ts` is the proof, and it is the reason this component may use
	 * `{@html …}` at all.
	 *
	 * The screen that uses this component gets `bodyHtml` from a server `load` that called that
	 * function. Passing anything else — a body straight out of the database, a string built here —
	 * would put unsanitized markup into the page, which is the one failure this whole spec is written
	 * around.
	 *
	 * ## `prose`
	 *
	 * The body wears `prose prose-neutral max-w-none` from `@tailwindcss/typography`, which
	 * `src/app.css` registers, rather than the tag-by-tag rules this component used to carry in its
	 * own scoped stylesheet. `rich-text-editor.svelte` puts the same classes on the editable area, so
	 * what an admin sees while typing is what a resident gets, from one definition instead of two that
	 * drift.
	 *
	 * (Spelling the tag out in this comment is what "`<script>` was left open" turned out to mean the
	 * first time it was written that way: `svelte2tsx` scans the file for tag names without parsing
	 * the comments out first, so a literal opening style tag here swallowed the rest of the file.)
	 */
	interface Props {
		readonly type: string;
		readonly category: string;
		readonly title: string;
		readonly summary: string;
		/** Sanitized HTML from `sanitizePostHtml`. Never a stored body handed over unfiltered. */
		readonly bodyHtml: string;
		/** The kegiatan's start, already formatted for reading, or `null`. */
		readonly startsAtLabel?: string | null;
		/** The kegiatan's end, already formatted for reading, or `null`. */
		readonly endsAtLabel?: string | null;
		readonly location?: string | null;
	}

	let {
		type,
		category,
		title,
		summary,
		bodyHtml,
		startsAtLabel = null,
		endsAtLabel = null,
		location = null
	}: Readonly<Props> = $props();
</script>

<article class="flex flex-col gap-4 rounded-lg border border-border p-4">
	<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span class="rounded-md border border-border px-2 py-1">
			{POST_TYPE_LABEL[type]?.() ?? type}
		</span>
		<span class="rounded-md border border-border px-2 py-1">
			{POST_CATEGORY_LABEL[category]?.() ?? category}
		</span>
	</div>

	<header class="flex flex-col gap-2">
		<h3 class="text-xl font-bold tracking-tight">{title}</h3>
		<p class="text-sm text-muted-foreground">{summary}</p>
	</header>

	{#if startsAtLabel}
		<dl class="flex flex-col gap-1 text-sm">
			<div class="flex flex-wrap gap-2">
				<dt class="font-medium">{m.adminPosts_form_startsAtLabel()}</dt>
				<dd class="text-muted-foreground">{startsAtLabel}</dd>
			</div>
			{#if endsAtLabel}
				<div class="flex flex-wrap gap-2">
					<dt class="font-medium">{m.adminPosts_form_endsAtLabel()}</dt>
					<dd class="text-muted-foreground">{endsAtLabel}</dd>
				</div>
			{/if}
			{#if location}
				<div class="flex flex-wrap gap-2">
					<dt class="font-medium">{m.adminPosts_form_locationLabel()}</dt>
					<dd class="text-muted-foreground">{location}</dd>
				</div>
			{/if}
		</dl>
	{/if}

	<!--
		Sanitized by `sanitizePostHtml`, which is the whole reason this component exists — see the doc
		comment above. `svelte/no-at-html-tags` is disabled for this one line because there is no other
		way to render HTML in Svelte, and the value being rendered is the output of the sanitizer this
		spec is built around rather than anything a caller composed.
	-->
	<div class="post-body prose max-w-none text-sm break-words prose-neutral dark:prose-invert">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html bodyHtml}
	</div>
</article>

<style>
	/*
		The one rule `@tailwindcss/typography` does not give a Post body. Its tables are laid out to the
		width of their content, so a wide one at 390 pixels pushes the whole page sideways; this makes
		the table itself the thing that scrolls. Everything else the sanitizer's whitelist allows —
		headings, lists, links, quotes, code — is styled by the `prose` classes on the element above.
	*/
	.post-body :global(table) {
		display: block;
		overflow-x: auto;
	}
</style>
