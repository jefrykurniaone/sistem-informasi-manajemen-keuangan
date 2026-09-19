<script lang="ts">
	import { resolve } from '$app/paths';
	import InvoiceCard from '$lib/components/dues/invoice-card.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.adminOverdueUnit_pageTitle({ block: data.block, number: data.number })}</title>
</svelte:head>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 py-10">
	<a class="text-sm underline underline-offset-2" href={resolve('/admin/overdue')}>
		{m.adminOverdueUnit_backLink()}
	</a>

	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">
			{m.adminOverdueUnit_heading({ block: data.block, number: data.number })}
		</h1>
	</header>

	{#if data.invoices.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminOverdueUnit_empty()}</p>
	{:else}
		{#each data.invoices as invoice (invoice.invoiceId)}
			<div class="flex flex-col gap-1">
				<InvoiceCard
					period={invoice.period}
					block={data.block}
					number={data.number}
					amount={invoice.amount}
					remainingAmount={invoice.remainingAmount}
					dueDate={invoice.dueDate}
					status={invoice.status}
				/>
				{#if invoice.voidReason !== null}
					<p class="px-4 text-sm text-muted-foreground">
						{m.adminOverdueUnit_voidReasonLabel({ reason: invoice.voidReason })}
					</p>
				{/if}
			</div>
		{/each}
	{/if}
</main>
