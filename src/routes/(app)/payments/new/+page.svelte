<script lang="ts">
	import { resolve } from '$app/paths';
	import PaymentForm, {
		EMPTY_PAYMENT_FORM_VALUES,
		type PaymentFormValues
	} from '$lib/components/dues/payment-form.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** What the fields hold: whatever the last rejected submission left behind, or an empty form. */
	const values: PaymentFormValues = $derived(form?.values ?? EMPTY_PAYMENT_FORM_VALUES);
</script>

<svelte:head>
	<title>{pageTitle(m.payments_new_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.payments_new_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.payments_new_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="alert">{form.message}</p>
	{/if}

	{#if data.units.length === 0}
		<p class="rounded-md border border-border px-3 py-2 text-sm">{m.payments_new_noUnit()}</p>
	{:else}
		<PaymentForm
			action="?/create"
			{values}
			units={data.units}
			acceptedProofTypes={data.acceptedProofTypes}
			maximumProofBytes={data.maximumProofBytes}
		/>
	{/if}

	<a
		class="flex h-11 items-center text-sm underline underline-offset-4"
		href={resolve('/payments')}
	>
		{m.payments_new_backLink()}
	</a>
</main>
