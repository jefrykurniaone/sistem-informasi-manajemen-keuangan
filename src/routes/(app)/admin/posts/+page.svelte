<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		POST_CATEGORY_LABEL,
		POST_STATUS_LABEL,
		POST_TYPE_LABEL
	} from '$lib/components/post/post-form.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const uid = $props.id();

	const totalPages = $derived(Math.max(1, Math.ceil(data.totalCount / data.pageSize)));

	/**
	 * The query string for this same screen with `page` replaced, keeping the three filters. Returns
	 * only the query string, not the full href — `resolve()` has to be called directly at each
	 * `href={…}` for `eslint-plugin-svelte`'s `no-navigation-without-resolve` to see it, exactly as
	 * `(app)/admin/units/+page.svelte` explains.
	 */
	function pageQuery(page: number): string {
		const params = new SvelteURLSearchParams();
		for (const [name, value] of Object.entries(data.filters)) {
			if (value) {
				params.set(name, value);
			}
		}
		params.set('page', String(page));
		return params.toString();
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminPosts_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminPosts_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminPosts_description()}</p>
	</header>

	<a
		class="flex h-11 w-full items-center justify-center rounded-md border border-border px-4 text-sm font-medium sm:w-auto sm:self-start"
		href={resolve('/admin/posts/new')}
	>
		{m.adminPosts_newLink()}
	</a>

	<form method="GET" class="flex flex-col gap-3 sm:flex-row sm:items-end">
		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="admin-posts-status-{uid}">
				{m.adminPosts_filterStatusLabel()}
			</label>
			<select
				id="admin-posts-status-{uid}"
				name="status"
				value={data.filters.status}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			>
				<option value="">{m.adminPosts_filterAll()}</option>
				{#each data.statuses as status (status)}
					<option value={status}>{POST_STATUS_LABEL[status]?.() ?? status}</option>
				{/each}
			</select>
		</div>

		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="admin-posts-type-{uid}">
				{m.adminPosts_filterTypeLabel()}
			</label>
			<select
				id="admin-posts-type-{uid}"
				name="type"
				value={data.filters.type}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			>
				<option value="">{m.adminPosts_filterAll()}</option>
				{#each data.types as type (type)}
					<option value={type}>{POST_TYPE_LABEL[type]?.() ?? type}</option>
				{/each}
			</select>
		</div>

		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="admin-posts-category-{uid}">
				{m.adminPosts_filterCategoryLabel()}
			</label>
			<select
				id="admin-posts-category-{uid}"
				name="category"
				value={data.filters.category}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			>
				<option value="">{m.adminPosts_filterAll()}</option>
				{#each data.categories as category (category)}
					<option value={category}>{POST_CATEGORY_LABEL[category]?.() ?? category}</option>
				{/each}
			</select>
		</div>

		<Button type="submit" variant="outline" class="h-11">{m.adminPosts_filterSubmit()}</Button>
	</form>

	<div class="flex flex-col gap-4">
		{#each data.posts as post (post.id)}
			<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span class="rounded-md border border-border px-2 py-1">
						{POST_STATUS_LABEL[post.status]?.() ?? post.status}
					</span>
					<span class="rounded-md border border-border px-2 py-1">
						{POST_TYPE_LABEL[post.type]?.() ?? post.type}
					</span>
					<span class="rounded-md border border-border px-2 py-1">
						{POST_CATEGORY_LABEL[post.category]?.() ?? post.category}
					</span>
				</div>

				<h2 class="font-medium">{post.title}</h2>
				<p class="text-sm text-muted-foreground">{post.summary}</p>

				<dl class="flex flex-col gap-1 text-sm text-muted-foreground">
					<div class="flex flex-wrap gap-2">
						<dt class="font-medium">{m.adminPosts_authorLabel()}</dt>
						<dd>{post.authorName}</dd>
					</div>
					<div class="flex flex-wrap gap-2">
						<dt class="font-medium">{m.adminPosts_publishedAtLabel()}</dt>
						<dd>{post.publishedAtLabel ?? m.adminPosts_notPublishedYet()}</dd>
					</div>
					{#if post.startsAtLabel}
						<div class="flex flex-wrap gap-2">
							<dt class="font-medium">{m.adminPosts_startsAtLabel()}</dt>
							<dd>{post.startsAtLabel}</dd>
						</div>
					{/if}
				</dl>

				<a
					class="flex h-11 items-center text-sm underline underline-offset-2"
					href={resolve(`/admin/posts/${post.id}`)}
				>
					{m.adminPosts_editLink()}
				</a>
			</section>
		{/each}

		{#if data.posts.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminPosts_empty()}</p>
		{/if}
	</div>

	{#if data.totalCount > data.pageSize}
		<nav
			class="flex items-center justify-between gap-3 text-sm"
			aria-label={m.adminPosts_heading()}
		>
			<a
				class="flex h-11 items-center rounded-md border border-border px-3"
				class:pointer-events-none={data.page <= 1}
				class:opacity-50={data.page <= 1}
				href={resolve(`/admin/posts?${pageQuery(Math.max(1, data.page - 1))}`)}
			>
				{m.adminPosts_prevPage()}
			</a>
			<span class="text-muted-foreground">
				{m.adminPosts_paginationSummary({ page: data.page, totalPages })}
			</span>
			<a
				class="flex h-11 items-center rounded-md border border-border px-3"
				class:pointer-events-none={data.page >= totalPages}
				class:opacity-50={data.page >= totalPages}
				href={resolve(`/admin/posts?${pageQuery(Math.min(totalPages, data.page + 1))}`)}
			>
				{m.adminPosts_nextPage()}
			</a>
		</nav>
	{/if}
</main>
