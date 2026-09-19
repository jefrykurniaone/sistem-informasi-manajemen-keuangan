<script lang="ts">
	import InvoiceCard from '$lib/components/dues/invoice-card.svelte';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Shown on every card only once this warga has been recorded in more than one house. */
	const showUnit = $derived(new Set(data.invoices.map((invoice) => invoice.unitId)).size > 1);
</script>

<svelte:head>
	<title>{m.invoices_pageTitle()} — Komplek</title>
</svelte:head>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.invoices_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.invoices_subheading()}</p>
	</header>

	<section class="flex flex-col gap-1 rounded-lg border border-border p-4">
		<span class="text-sm text-muted-foreground">{m.invoices_totalOverdueLabel()}</span>
		<span class="text-2xl font-bold">{formatRupiah(data.totalOverdue)}</span>
	</section>

	{#if data.invoices.length === 0}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.invoices_emptyTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.invoices_emptyBody()}</p>
		</section>
	{:else}
		{#each data.invoices as invoice (invoice.invoiceId)}
			<InvoiceCard
				period={invoice.period}
				block={invoice.block}
				number={invoice.number}
				amount={invoice.amount}
				remainingAmount={invoice.remainingAmount}
				dueDate={invoice.dueDate}
				status={invoice.status}
				{showUnit}
			/>
		{/each}
	{/if}
</main>
