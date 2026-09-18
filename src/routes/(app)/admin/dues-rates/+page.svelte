<script lang="ts">
	import DuesRateForm from '$lib/components/dues/dues-rate-form.svelte';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.adminDuesRates_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminDuesRates_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminDuesRates_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="text-lg font-semibold">{m.adminDuesRates_setHeading()}</h2>
		<DuesRateForm />
	</section>

	<section class="flex flex-col gap-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold">{m.adminDuesRates_historyHeading()}</h2>
			<p class="text-sm text-muted-foreground">
				{m.adminDuesRates_asOf({ date: data.today })}
			</p>
		</div>

		{#each data.rates as rate (rate.id)}
			<article class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="text-base font-medium">{formatRupiah(rate.amount)}</span>
					{#if rate.isInForce}
						<span class="rounded-md border border-border px-2 py-1 text-xs font-medium">
							{m.adminDuesRates_inForce()}
						</span>
					{/if}
				</div>

				<p class="text-sm text-muted-foreground">
					{m.adminDuesRates_effectiveFrom({ date: rate.effectiveFrom })}
				</p>

				{#if rate.usedSincePeriod}
					<p class="text-sm text-muted-foreground">
						{m.adminDuesRates_usedSince({ period: rate.usedSincePeriod })}
					</p>
				{/if}

				{#if rate.isEditable}
					<DuesRateForm
						rate={{ id: rate.id, amount: rate.amount, effectiveFrom: rate.effectiveFrom }}
					/>
				{/if}
			</article>
		{/each}

		{#if data.rates.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminDuesRates_empty()}</p>
		{/if}
	</section>
</main>
