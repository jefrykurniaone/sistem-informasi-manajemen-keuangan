<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * One row of the public board's list — `(public)/posts/+page.svelte`'s per-Post card. It shows
	 * only the summary, never the body: the full, sanitized body is what
	 * `(public)/posts/[id]/+page.svelte` shows through `post-preview.svelte`, and this card's job is
	 * to get a visitor there.
	 *
	 * `type` and `category` are read through their own small label maps, same reasoning
	 * `category-filter.svelte`'s doc comment gives for not importing `post-form.svelte`.
	 */
	interface Props {
		readonly id: string;
		readonly type: string;
		readonly category: string;
		readonly title: string;
		readonly summary: string;
		/** The kegiatan's start, already formatted for reading, or `null` for a pengumuman. */
		readonly startsAtLabel?: string | null;
		readonly location?: string | null;
		/** A signed link to the cover image, or `null` while none has been uploaded. */
		readonly coverImageUrl?: string | null;
	}

	let {
		id,
		type,
		category,
		title,
		summary,
		startsAtLabel = null,
		location = null,
		coverImageUrl = null
	}: Readonly<Props> = $props();

	/** The label for one of the two Post types. Read from the same functions `post-form.svelte` uses. */
	const TYPE_LABEL: Record<string, () => string> = {
		event: m.adminPosts_type_event,
		announcement: m.adminPosts_type_announcement
	};

	/** The label for one of the five categories. Read from the same functions `post-form.svelte` uses. */
	const CATEGORY_LABEL: Record<string, () => string> = {
		posyandu: m.adminPosts_category_posyandu,
		'kerja-bakti': m.adminPosts_category_kerjaBakti,
		perayaan: m.adminPosts_category_perayaan,
		rapat: m.adminPosts_category_rapat,
		umum: m.adminPosts_category_umum
	};
</script>

<article class="flex flex-col gap-3 rounded-lg border border-border p-4">
	{#if coverImageUrl}
		<img
			src={coverImageUrl}
			alt={title}
			loading="lazy"
			class="h-40 w-full rounded-md object-cover"
		/>
	{/if}

	<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span class="rounded-md border border-border px-2 py-1">{TYPE_LABEL[type]?.() ?? type}</span>
		<span class="rounded-md border border-border px-2 py-1">
			{CATEGORY_LABEL[category]?.() ?? category}
		</span>
	</div>

	<h2 class="font-medium">{title}</h2>
	<p class="text-sm text-muted-foreground">{summary}</p>

	{#if startsAtLabel || location}
		<dl class="flex flex-col gap-1 text-sm text-muted-foreground">
			{#if startsAtLabel}
				<div class="flex flex-wrap gap-2">
					<dt class="font-medium">{m.adminPosts_form_startsAtLabel()}</dt>
					<dd>{startsAtLabel}</dd>
				</div>
			{/if}
			{#if location}
				<div class="flex flex-wrap gap-2">
					<dt class="font-medium">{m.adminPosts_form_locationLabel()}</dt>
					<dd>{location}</dd>
				</div>
			{/if}
		</dl>
	{/if}

	<a
		class="flex h-11 min-w-24 items-center text-sm underline underline-offset-2"
		href={resolve(`/posts/${id}`)}
	>
		{m.postPublic_readMoreLink()}
	</a>
</article>
