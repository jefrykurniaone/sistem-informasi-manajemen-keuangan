<script lang="ts">
	import { resolve } from '$app/paths';
	import TransactionForm, {
		EMPTY_CASH_TRANSACTION_FORM_VALUES,
		type CashTransactionFormValues
	} from '$lib/components/cash/transaction-form.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** What the fields hold: whatever the last submission left behind, or an empty form. */
	const values: CashTransactionFormValues = $derived(
		form?.values ?? EMPTY_CASH_TRANSACTION_FORM_VALUES
	);
</script>

<svelte:head>
	<title>{pageTitle(m.adminCash_new_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminCash_new_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminCash_new_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	{#if data.categories.length === 0}
		<p class="rounded-md border border-border px-3 py-2 text-sm">
			{m.adminCash_new_noCategories()}
		</p>
	{:else}
		<TransactionForm
			action="?/create"
			{values}
			categories={data.categories}
			acceptedReceiptTypes={data.acceptedReceiptTypes}
		/>
	{/if}

	<a
		class="flex h-11 items-center text-sm underline underline-offset-4"
		href={resolve('/admin/cash')}
	>
		{m.adminCash_new_backLink()}
	</a>
</main>
