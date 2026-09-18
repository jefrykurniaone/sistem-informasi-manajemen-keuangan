<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import CategoryFilter from '$lib/components/post/category-filter.svelte';
	import PostCard from '$lib/components/post/post-card.svelte';
	import type { PageProps } from './$types';

	/**
	 * The announcement board a visitor with no session opens. `data.when` is `'upcoming'` or
	 * `'past'`, the two values `$lib/server/services/post/public.ts`'s `POST_WHEN` names — written
	 * out as the literal `'past'` below rather than imported, because that module is under
	 * `$lib/server/` and this component also runs in the browser, the same reasoning
	 * `post-form.svelte`'s own `EVENT_TYPE` constant explains.
	 */
	let { data }: PageProps = $props();

	const totalPages = $derived(Math.max(1, Math.ceil(data.totalCount / data.pageSize)));

	/** The query string for this screen with `page` replaced, keeping the current filters. */
	function pageQuery(page: number): string {
		const params = new SvelteURLSearchParams();
		if (data.filters.category) {
			params.set('category', data.filters.category);
		}
		if (data.when === 'past') {
			params.set('when', 'past');
		}
		params.set('page', String(page));
		return params.toString();
	}

	/** The query string for switching between the upcoming and the past view, keeping the category. */
	function whenQuery(when: 'upcoming' | 'past'): string {
		const params = new SvelteURLSearchParams();
		if (data.filters.category) {
			params.set('category', data.filters.category);
		}
		if (when === 'past') {
			params.set('when', 'past');
		}
		return params.toString();
	}
</script>

<svelte:head>
	<title>{m.postPublic_pageTitle()}</title>
	<meta name="description" content={m.postPublic_pageDescription()} />
</svelte:head>

<header class="flex flex-col gap-1">
	<h1 class="text-2xl font-bold tracking-tight">{m.postPublic_heading()}</h1>
	<p class="text-sm text-muted-foreground">{m.postPublic_description()}</p>
</header>

<nav class="flex gap-2" aria-label={m.postPublic_whenNavLabel()}>
	<a
		class="flex h-11 min-w-24 items-center justify-center rounded-md border border-border px-4 text-sm font-medium"
		class:bg-accent={data.when === 'upcoming'}
		aria-current={data.when === 'upcoming' ? 'page' : undefined}
		href={resolve(`/posts?${whenQuery('upcoming')}`)}
	>
		{m.postPublic_whenUpcoming()}
	</a>
	<a
		class="flex h-11 min-w-24 items-center justify-center rounded-md border border-border px-4 text-sm font-medium"
		class:bg-accent={data.when === 'past'}
		aria-current={data.when === 'past' ? 'page' : undefined}
		href={resolve(`/posts?${whenQuery('past')}`)}
	>
		{m.postPublic_whenPast()}
	</a>
</nav>

<form method="GET" class="flex flex-col gap-3 sm:flex-row sm:items-end">
	<CategoryFilter categories={data.categories} selected={data.filters.category} />
	{#if data.when === 'past'}
		<input type="hidden" name="when" value="past" />
	{/if}
	<button
		type="submit"
		class="flex h-11 min-w-24 items-center justify-center rounded-md border border-border px-4 text-sm font-medium"
	>
		{m.postPublic_filterSubmit()}
	</button>
</form>

<div class="flex flex-col gap-4">
	{#each data.posts as post (post.id)}
		<PostCard {...post} />
	{/each}

	{#if data.posts.length === 0}
		<p class="text-sm text-muted-foreground">{m.postPublic_empty()}</p>
	{/if}
</div>

{#if data.totalCount > data.pageSize}
	<nav class="flex items-center justify-between gap-3 text-sm" aria-label={m.postPublic_heading()}>
		<a
			class="flex h-11 min-w-24 items-center justify-center rounded-md border border-border px-3"
			class:pointer-events-none={data.page <= 1}
			class:opacity-50={data.page <= 1}
			href={resolve(`/posts?${pageQuery(Math.max(1, data.page - 1))}`)}
		>
			{m.postPublic_prevPage()}
		</a>
		<span class="text-muted-foreground">
			{m.postPublic_paginationSummary({ page: data.page, totalPages })}
		</span>
		<a
			class="flex h-11 min-w-24 items-center justify-center rounded-md border border-border px-3"
			class:pointer-events-none={data.page >= totalPages}
			class:opacity-50={data.page >= totalPages}
			href={resolve(`/posts?${pageQuery(Math.min(totalPages, data.page + 1))}`)}
		>
			{m.postPublic_nextPage()}
		</a>
	</nav>
{/if}
