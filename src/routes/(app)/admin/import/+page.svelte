<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import PreviewTable from '$lib/components/import/preview-table.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/**
	 * The preview the last upload produced, or the one a refused confirmation produced again. Read
	 * with `in` because the two actions answer with different shapes and only one of them carries a
	 * preview at all.
	 */
	const preview = $derived(form && 'preview' in form ? form.preview : undefined);

	/** The status line of whichever action ran last: a refusal, or "the import went in". */
	const message = $derived(form && 'message' in form ? form.message : undefined);

	/** Whether the file in the preview is one the confirm step would accept whole. */
	const isImportable = $derived(
		preview !== undefined && preview.problems.length === 0 && preview.validRowCount > 0
	);
</script>

<svelte:head>
	<title>{pageTitle(m.adminImport_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminImport_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminImport_description()}</p>
	</header>

	{#if message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{message}</p>
	{/if}

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="text-lg font-semibold">{m.adminImport_guideHeading()}</h2>
		<ol class="flex flex-col gap-1 text-sm text-muted-foreground">
			<li>{m.adminImport_guideStep1()}</li>
			<li>{m.adminImport_guideStep2()}</li>
			<li>{m.adminImport_guideStep3()}</li>
		</ol>
		<p class="text-sm text-muted-foreground">{m.adminImport_rowLimit({ maximum: data.maxRows })}</p>
		<Button href={resolve('/admin/import/template')} variant="secondary" class="h-11 w-fit">
			{m.adminImport_downloadTemplate()}
		</Button>
	</section>

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="text-lg font-semibold">{m.adminImport_uploadHeading()}</h2>

		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			class="flex flex-col gap-3 sm:flex-row sm:items-end"
		>
			<div class="flex flex-1 flex-col gap-1">
				<label class="text-sm font-medium" for="admin-import-file-{uid}">
					{m.adminImport_fileLabel()}
				</label>
				<input
					id="admin-import-file-{uid}"
					name="file"
					type="file"
					accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
					required
					class="h-11 rounded-md border border-border bg-background px-3 py-2 text-sm"
				/>
			</div>
			<Button type="submit" class="h-11">{m.adminImport_uploadSubmit()}</Button>
		</form>
	</section>

	{#if preview}
		<PreviewTable
			fileName={preview.fileName}
			validRowCount={preview.validRowCount}
			newUnitCount={preview.newUnitCount}
			newResidentCount={preview.newResidentCount}
			problems={preview.problems}
		/>

		{#if isImportable}
			<form method="POST" action="?/confirm" class="flex flex-col gap-3">
				<!-- The file's own text, carried back so the confirm step can parse and check it again
				     from scratch. See the service module's doc comment: this is input, not a result. -->
				<input type="hidden" name="content" value={preview.content} />
				<input type="hidden" name="fileName" value={preview.fileName} />
				<Button type="submit" class="h-11">
					{m.adminImport_confirmSubmit({ count: preview.validRowCount })}
				</Button>
			</form>
		{:else}
			<p
				class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
				role="alert"
			>
				{m.adminImport_blockedByProblems()}
			</p>
		{/if}
	{/if}
</main>
