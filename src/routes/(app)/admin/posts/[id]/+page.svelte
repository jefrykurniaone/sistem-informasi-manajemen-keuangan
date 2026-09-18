<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import PostForm, {
		POST_STATUS_LABEL,
		type PostFormValues
	} from '$lib/components/post/post-form.svelte';
	import PostPreview from '$lib/components/post/post-preview.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** What the fields hold: whatever the last submission carried, or what is stored. */
	const values: PostFormValues = $derived(form?.values ?? data.values);

	/** The preview of the unsaved body when there is one, otherwise of the saved body. */
	const previewHtml = $derived(form?.previewHtml ?? data.previewHtml);
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
		submitLabel={m.adminPosts_form_submitUpdate()}
	/>

	<section class="flex flex-col gap-3">
		<h2 class="text-lg font-semibold">{m.adminPosts_previewHeading()}</h2>
		<p class="text-sm text-muted-foreground">{m.adminPosts_previewHint()}</p>

		<form method="POST" action="?/preview">
			<input type="hidden" name="bodyMarkdown" value={values.bodyMarkdown} />
			<input type="hidden" name="type" value={values.type} />
			<input type="hidden" name="title" value={values.title} />
			<input type="hidden" name="summary" value={values.summary} />
			<input type="hidden" name="category" value={values.category} />
			<input type="hidden" name="startsAt" value={values.startsAt} />
			<input type="hidden" name="endsAt" value={values.endsAt} />
			<input type="hidden" name="location" value={values.location} />
			<Button type="submit" variant="outline" class="h-11 w-full sm:w-auto">
				{m.adminPosts_previewSubmit()}
			</Button>
		</form>

		<PostPreview
			type={values.type}
			category={values.category}
			title={values.title}
			summary={values.summary}
			bodyHtml={previewHtml}
			startsAtLabel={data.post.startsAtLabel}
			endsAtLabel={data.post.endsAtLabel}
			location={data.post.location}
		/>
	</section>

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="text-lg font-semibold">{m.adminPosts_coverHeading()}</h2>
		<p class="text-sm text-muted-foreground">
			{data.post.coverImageKey
				? m.adminPosts_coverCurrent({ key: data.post.coverImageKey })
				: m.adminPosts_coverNone()}
		</p>

		<form
			method="POST"
			action="?/uploadCover"
			enctype="multipart/form-data"
			class="flex flex-col gap-3"
		>
			<label class="text-sm font-medium" for="admin-posts-cover-{uid}">
				{m.adminPosts_coverLabel()}
			</label>
			<input
				id="admin-posts-cover-{uid}"
				name="cover"
				type="file"
				accept={data.coverImageContentTypes.join(',')}
				aria-describedby="admin-posts-cover-hint-{uid}"
				class="rounded-md border border-border bg-background px-3 py-2.5 text-sm"
			/>
			<p class="text-xs text-muted-foreground" id="admin-posts-cover-hint-{uid}">
				{m.adminPosts_coverHint()}
			</p>
			<Button type="submit" variant="outline" class="h-11 w-full sm:w-auto sm:self-start">
				{m.adminPosts_coverSubmit()}
			</Button>
		</form>
	</section>

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
