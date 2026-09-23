<script lang="ts">
	import { resolve } from '$app/paths';
	import PostForm, {
		EMPTY_POST_FORM_VALUES,
		type PostFormValues
	} from '$lib/components/post/post-form.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** What the fields hold: whatever the last rejected submission carried, or an empty form. */
	const values: PostFormValues = $derived(form?.values ?? EMPTY_POST_FORM_VALUES);
</script>

<svelte:head>
	<title>{pageTitle(m.adminPosts_new_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminPosts_new_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminPosts_new_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
		</p>
	{/if}

	<PostForm
		action="?/create"
		{values}
		categories={data.categories}
		types={data.types}
		coverImageContentTypes={data.coverImageContentTypes}
		submitLabel={m.adminPosts_form_submitCreate()}
	/>

	<a
		class="flex h-11 items-center text-sm underline underline-offset-4"
		href={resolve('/admin/posts')}
	>
		{m.adminPosts_backLink()}
	</a>
</main>
