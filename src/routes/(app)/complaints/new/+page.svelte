<script lang="ts">
	import ComplaintForm, {
		type ComplaintFormValues
	} from '$lib/components/complaint/complaint-form.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** What repopulates each field: the values just posted after a `fail()`, or a blank form. */
	const values: ComplaintFormValues = $derived(
		form?.values ?? { title: '', category: '', description: '', makePublic: false }
	);
</script>

<svelte:head>
	<title>{m.complaintsNew_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.complaintsNew_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.complaintsNew_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<ComplaintForm
		{values}
		acceptedAttachmentTypes={data.acceptedAttachmentTypes}
		maximumAttachmentBytes={data.maximumAttachmentBytes}
		maxAttachments={data.maxAttachments}
	/>
</main>
