<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import PostForm, {
		POST_STATUS_LABEL,
		type PostFormValues
	} from '$lib/components/post/post-form.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** What the fields hold: whatever the last submission carried, or what is stored. */
	const values: PostFormValues = $derived(form?.values ?? data.values);
</script>

<svelte:head>
	<title>{m.adminPosts_edit_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-2">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminPosts_edit_heading()}</h1>
		<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span class="rounded-md border border-border px-2 py-1">
				{POST_STATUS_LABEL[data.post.status]?.() ?? data.post.status}
			</span>
			<span>{m.adminPosts_authorLabel()}: {data.post.authorName}</span>
			<span>
				{m.adminPosts_publishedAtLabel()}:
				{data.post.publishedAtLabel ?? m.adminPosts_notPublishedYet()}
			</span>
		</div>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<PostForm
		action="?/update"
		{values}
		categories={data.categories}
		types={data.types}
		coverImageContentTypes={data.coverImageContentTypes}
		coverImageKey={data.post.coverImageKey}
		submitLabel={m.adminPosts_form_submitUpdate()}
	/>

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="text-lg font-semibold">{m.adminPosts_statusHeading()}</h2>

		<div class="flex flex-col gap-3 sm:flex-row">
			{#if data.canPublish}
				<form method="POST" action="?/publish" class="flex-1">
					<Button type="submit" class="h-11 w-full">{m.adminPosts_publishSubmit()}</Button>
				</form>
			{/if}
			{#if data.canArchive}
				<form method="POST" action="?/archive" class="flex-1">
					<Button type="submit" variant="outline" class="h-11 w-full">
						{m.adminPosts_archiveSubmit()}
					</Button>
				</form>
			{/if}
		</div>
	</section>

	<a
		class="flex h-11 items-center text-sm underline underline-offset-4"
		href={resolve('/admin/posts')}
	>
		{m.adminPosts_backLink()}
	</a>
</main>
