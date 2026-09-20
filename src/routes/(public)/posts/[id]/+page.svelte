<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';
	import PostPreview from '$lib/components/post/post-preview.svelte';
	import type { PageProps } from './$types';

	/**
	 * The Post a shared link opens, read by anyone with no session — see `+page.server.ts`'s doc
	 * comment for the acceptance criteria this satisfies. `post-preview.svelte` already renders the
	 * sanitized body the same way the admin preview screen does; this page adds only the cover image,
	 * the back link, and the sharing metadata `og:title` / `og:image` / `og:url` read.
	 */
	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.post.title} — {m.appShell_brand()}</title>
	<meta name="description" content={data.post.summary} />
	<meta property="og:type" content="article" />
	<meta property="og:title" content={data.post.title} />
	<meta property="og:description" content={data.post.summary} />
	<meta property="og:url" content={data.shareUrl} />
	{#if data.post.coverImageUrl}
		<meta property="og:image" content={data.post.coverImageUrl} />
	{/if}
</svelte:head>

<a
	class="flex h-11 min-w-24 items-center text-sm underline underline-offset-2"
	href={resolve('/posts')}
>
	{m.postPublic_backLink()}
</a>

<!--
	The page's real heading, for the document outline and for anyone using a screen reader — a
	single Post's own title is what this whole page is about, so it belongs at level 1. It stays
	visually hidden rather than shown twice: `post-preview.svelte` already renders the same title as
	its own `<h3>`, styled the way this page wants it to look.
-->
<h1 class="sr-only">{data.post.title}</h1>

{#if data.post.coverImageUrl}
	<img src={data.post.coverImageUrl} alt={data.post.title} class="w-full rounded-lg object-cover" />
{/if}

<PostPreview
	type={data.post.type}
	category={data.post.category}
	title={data.post.title}
	summary={data.post.summary}
	bodyHtml={data.bodyHtml}
	startsAtLabel={data.post.startsAtLabel}
	endsAtLabel={data.post.endsAtLabel}
	location={data.post.location}
/>
