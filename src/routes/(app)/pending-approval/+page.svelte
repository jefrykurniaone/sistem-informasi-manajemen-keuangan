<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** The claimed house as one line, for the sentence that quotes it back. */
	const claim = $derived(
		data.registration
			? m.pendingApproval_claim({
					block: data.registration.claimedBlock,
					number: data.registration.claimedNumber
				})
			: ''
	);
</script>

<svelte:head>
	<title>{pageTitle(m.pendingApproval_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
	{#if data.registration?.status === 'pending'}
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-bold tracking-tight">{m.pendingApproval_pendingHeading()}</h1>
			<p class="text-sm text-muted-foreground">{m.pendingApproval_pendingBody()}</p>
		</header>
		<p class="rounded-lg border border-border p-4 text-sm">{claim}</p>
	{:else if data.registration?.status === 'rejected'}
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-bold tracking-tight">{m.pendingApproval_rejectedHeading()}</h1>
			<p class="text-sm text-muted-foreground">{m.pendingApproval_rejectedBody()}</p>
		</header>
		<p class="rounded-lg border border-destructive p-4 text-sm" role="alert">
			{data.registration.rejectionReason ?? m.pendingApproval_rejectedNoReason()}
		</p>
		<p class="text-sm text-muted-foreground">{claim}</p>
		<p class="text-sm">
			<a
				class="inline-flex min-h-11 items-center underline underline-offset-4"
				href={resolve('/register')}
			>
				{m.pendingApproval_registerAgain()}
			</a>
		</p>
	{:else if data.registration?.status === 'approved'}
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-bold tracking-tight">{m.pendingApproval_approvedHeading()}</h1>
			<p class="text-sm text-muted-foreground">{m.pendingApproval_approvedBody()}</p>
		</header>
		<p class="text-sm">
			<a
				class="inline-flex min-h-11 items-center underline underline-offset-4"
				href={resolve('/my-unit')}
			>
				{m.pendingApproval_toMyUnit()}
			</a>
		</p>
	{:else}
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-bold tracking-tight">{m.pendingApproval_noneHeading()}</h1>
			<p class="text-sm text-muted-foreground">{m.pendingApproval_noneBody()}</p>
		</header>
		<p class="text-sm">
			<a
				class="inline-flex min-h-11 items-center underline underline-offset-4"
				href={resolve('/register')}
			>
				{m.pendingApproval_registerAgain()}
			</a>
		</p>
	{/if}
</main>
