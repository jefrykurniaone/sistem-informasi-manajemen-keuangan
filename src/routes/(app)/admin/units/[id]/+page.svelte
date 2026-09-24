<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDay } from '$lib/time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>
		{pageTitle(m.adminUnits_detailHeading({ block: data.unit.block, number: data.unit.number }))}
	</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<a
		class="text-sm text-muted-foreground underline underline-offset-2"
		href={resolve('/admin/units')}
	>
		{m.adminUnits_detailBack()}
	</a>

	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">
			{m.adminUnits_detailHeading({ block: data.unit.block, number: data.unit.number })}
		</h1>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
		<dt class="text-muted-foreground">{m.adminUnits_tableStatus()}</dt>
		<dd>{data.unit.isActive ? m.adminUnits_statusActive() : m.adminUnits_statusInactive()}</dd>
		<dt class="text-muted-foreground">{m.adminUnits_detailOccupants()}</dt>
		<dd>{data.unit.activeOccupantCount}</dd>
		<dt class="text-muted-foreground">{m.adminUnits_detailCreatedAt()}</dt>
		<dd>{formatDay(data.unit.createdAt)}</dd>
	</dl>

	<div>
		<a
			class="inline-flex h-11 items-center rounded-md border border-border px-4 text-sm font-medium"
			href={resolve(`/admin/units/${data.unit.id}/finance`)}
		>
			{m.unitFinance_linkFromUnit()}
		</a>
	</div>

	<form method="POST" action={data.unit.isActive ? '?/deactivate' : '?/reactivate'}>
		<Button type="submit" variant={data.unit.isActive ? 'outline' : 'default'}>
			{data.unit.isActive ? m.adminUnits_deactivateSubmit() : m.adminUnits_reactivateSubmit()}
		</Button>
	</form>
</main>
