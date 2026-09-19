<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.adminOverdue_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminOverdue_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminOverdue_description()}</p>
	</header>

	{#if data.overdue.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminOverdue_empty()}</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each data.overdue as row (row.unitId)}
				<a
					href={resolve(`/admin/overdue/${row.unitId}`)}
					class="flex min-h-11 flex-col gap-2 rounded-lg border border-border p-4"
				>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h2 class="font-medium">
							{m.adminOverdue_unitLabel({ block: row.block, number: row.number })}
						</h2>
						<span class="text-lg font-bold text-destructive">
							{formatRupiah(row.totalOverdue)}
						</span>
					</div>
					<p class="text-sm text-muted-foreground">
						{m.adminOverdue_monthsLabel({ count: row.overdueInvoiceCount })}
					</p>
				</a>
			{/each}
		</div>
	{/if}
</main>
