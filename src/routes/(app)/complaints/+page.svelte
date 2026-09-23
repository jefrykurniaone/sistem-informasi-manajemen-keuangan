<script lang="ts">
	import { resolve } from '$app/paths';
	import StatusBadge from '$lib/components/complaint/status-badge.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** One row either list renders, already reduced by `+page.server.ts` to what the screen shows. */
	interface ComplaintRow {
		readonly id: string;
		readonly title: string;
		readonly category: string;
		readonly status: ComplaintStatus;
		readonly ageDays: number;
	}
</script>

{#snippet complaintList(rows: readonly ComplaintRow[], emptyMessage: string)}
	{#if rows.length === 0}
		<p class="text-sm text-muted-foreground">{emptyMessage}</p>
	{:else}
		<ul class="flex flex-col gap-3">
			{#each rows as row (row.id)}
				<li>
					<a
						href={resolve(`/complaints/${row.id}`)}
						class="flex min-h-11 flex-col gap-2 rounded-lg border border-border p-4"
					>
						<div class="flex flex-wrap items-center gap-2">
							<StatusBadge status={row.status} />
							<span class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
								{row.category}
							</span>
						</div>
						<h3 class="font-medium">{row.title}</h3>
						<p class="text-sm text-muted-foreground">
							{m.complaints_ageLabel({ days: row.ageDays })}
						</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<svelte:head>
	<title>{pageTitle(m.complaints_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.complaints_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.complaints_description()}</p>
	</header>

	<a
		class="flex h-11 items-center text-sm underline underline-offset-4"
		href={resolve('/complaints/new')}
	>
		{m.complaints_newLink()}
	</a>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.complaints_mineHeading()}</h2>
		{@render complaintList(data.mine, m.complaints_mineEmpty())}
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.complaints_publicHeading()}</h2>
		{@render complaintList(data.public, m.complaints_publicEmpty())}
	</section>
</main>
