<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { POST_CATEGORY_LABEL, POST_TYPE_LABEL } from './post-form.svelte';

	/**
	 * A Post as a resident would read it — `docs/spec-konten-v1.md`'s story 4, "saya ingin melihat
	 * pratinjau tampilan sebelum menerbitkan". It shows and it changes nothing; the screen around it
	 * owns every button.
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
	 * The two screens that use this component both get `bodyHtml` from a server `load` or a form
	 * action that called that function. Passing anything else — a body straight out of the database,
	 * a string built here — would put unsanitized markup into the page, which is the one failure this
	 * whole spec is written around.
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
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<div class="post-body flex flex-col gap-3 text-sm break-words">{@html bodyHtml}</div>
</article>

<style>
	/*
		The sanitizer's whitelist is the list of tags that can appear in `.post-body`, so these are the
		only selectors that can ever match. Tailwind's preflight strips the browser's own list and
		heading styles, which would otherwise make a rendered body indistinguishable from a paragraph.
	*/
	.post-body :global(h1),
	.post-body :global(h2),
	.post-body :global(h3),
	.post-body :global(h4),
	.post-body :global(h5),
	.post-body :global(h6) {
		font-weight: 600;
		line-height: 1.3;
	}

	.post-body :global(ul),
	.post-body :global(ol) {
		padding-left: 1.5rem;
	}

	.post-body :global(ul) {
		list-style: disc;
	}

	.post-body :global(ol) {
		list-style: decimal;
	}

	.post-body :global(a) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.post-body :global(blockquote) {
		border-left: 2px solid var(--border);
		padding-left: 0.75rem;
	}

	.post-body :global(pre) {
		overflow-x: auto;
		border-radius: 0.375rem;
		border: 1px solid var(--border);
		padding: 0.75rem;
	}

	/* A table at 390 pixels scrolls sideways rather than pushing the page wider than the screen. */
	.post-body :global(table) {
		display: block;
		overflow-x: auto;
		border-collapse: collapse;
	}

	.post-body :global(th),
	.post-body :global(td) {
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		text-align: left;
	}
</style>
