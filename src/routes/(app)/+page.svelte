<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import StatusBadge from '$lib/components/complaint/status-badge.svelte';
	import StatCard from '$lib/components/dashboard/stat-card.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{pageTitle(data.pageTitle)}</title>
</svelte:head>

{#if data.role === 'admin'}
	<main class="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10">
		<header class="flex flex-col gap-1">
			<h1 class="text-2xl font-bold tracking-tight">{data.heading}</h1>
			<p class="text-sm text-muted-foreground">{data.subheading}</p>
		</header>

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each data.cards as card (card.key)}
				<StatCard {...card} />
			{/each}
		</div>
	</main>
{:else}
	<main class="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-10">
		<header class="flex flex-col gap-1">
			<h1 class="text-2xl font-bold tracking-tight">{data.heading}</h1>
			<p class="text-sm text-muted-foreground">{data.subheading}</p>
		</header>

		<div class="flex flex-wrap gap-3">
			<Button href={resolve('/payments/new')} class="min-h-11">
				{m.dashboard_residentPaymentButton()}
			</Button>
			<Button href={resolve('/complaints/new')} variant="outline" class="min-h-11">
				{m.dashboard_residentComplaintButton()}
			</Button>
		</div>

		{#if !data.hasUnit}
			<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<h2 class="font-medium">{m.dashboard_residentNoUnitTitle()}</h2>
				<p class="text-sm text-muted-foreground">{m.dashboard_residentNoUnitBody()}</p>
			</section>
		{:else}
			{#each data.units as unit (unit.unitId)}
				<section class="flex flex-col gap-3">
					{#if unit.unitLabel}
						<h2 class="font-medium">{unit.unitLabel}</h2>
					{/if}
					<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
						<StatCard {...unit.invoiceCard} />
						<StatCard {...unit.creditCard} />
					</div>
				</section>
			{/each}
		{/if}

		<section class="flex flex-col gap-3">
			<h2 class="font-medium">{m.dashboard_residentComplaintsHeading()}</h2>
			{#if data.complaints.length === 0}
				<p class="text-sm text-muted-foreground">{m.dashboard_residentComplaintsEmpty()}</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each data.complaints as complaint (complaint.id)}
						<li class="flex min-h-11 items-center gap-2 text-sm">
							<StatusBadge status={complaint.status} />
							<span>{complaint.title}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<StatCard {...data.postsCard} />
	</main>
{/if}
