<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import OccupancyForm from '$lib/components/occupancy/occupancy-form.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** Label per occupancy role — the value itself stays what the schema stores. */
	const ROLE_LABEL: Record<string, () => string> = {
		owner: m.adminOccupancies_roleOwner,
		tenant: m.adminOccupancies_roleTenant
	};

	/**
	 * Why this unit needs a Penanggung Jawab named, as the Unit service decided it: `missing` is the
	 * red warning, `leaving` the yellow one, `null` neither.
	 */
	const primaryOccupantNeed = $derived(data.unit.primaryOccupantNeed);

	/**
	 * `listUnitOccupanciesGrouped` already splits this unit's Masa Huni into the three groups
	 * `docs/spec-penghuni-v1.md` decision 3 defines. This page only renders them; it makes no date
	 * comparison and no `endedOn === null` check of its own.
	 */
	const groups = $derived(data.occupancies);
	const hasAnyOccupancy = $derived(
		groups.current.length > 0 || groups.upcoming.length > 0 || groups.history.length > 0
	);
</script>

{#snippet endForm(occupancyId: string)}
	<form method="POST" action="?/end" class="flex flex-1 flex-col gap-3 sm:flex-row">
		<input type="hidden" name="occupancyId" value={occupancyId} />
		<div class="flex flex-1 flex-col gap-1.5">
			<label class="text-sm font-medium" for="occupancy-end-{occupancyId}-{uid}">
				{m.adminOccupancies_endedOnLabel()}
			</label>
			<input
				id="occupancy-end-{occupancyId}-{uid}"
				name="endedOn"
				type="date"
				required
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>
		<Button type="submit" variant="outline" class="h-11 self-end">
			{m.adminOccupancies_endSubmit()}
		</Button>
	</form>
{/snippet}

<svelte:head>
	<title>{pageTitle(m.adminOccupancies_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<a
		class="text-sm text-muted-foreground underline underline-offset-2"
		href={resolve('/admin/units')}
	>
		{m.adminOccupancies_backToUnits()}
	</a>

	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">
			{m.adminOccupancies_heading({ block: data.unit.block, number: data.unit.number })}
		</h1>
		<p class="text-sm text-muted-foreground">{m.adminOccupancies_description()}</p>
	</header>

	{#if primaryOccupantNeed?.kind === 'missing'}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{m.adminOccupancies_needsPrimaryOccupant()}
		</p>
	{:else if primaryOccupantNeed?.kind === 'leaving'}
		<p
			class="rounded-md border border-amber-500 bg-amber-50 px-3 py-2 text-sm break-words text-amber-900 dark:bg-amber-950 dark:text-amber-100"
			role="status"
		>
			{m.adminOccupancies_primaryLeaving({
				resident: primaryOccupantNeed.name,
				endedOn: primaryOccupantNeed.endedOn
			})}
		</p>
	{/if}

	<OccupancyForm residents={data.residents} roles={data.roles} formMessage={form?.message} />

	{#if !hasAnyOccupancy}
		<p class="text-sm text-muted-foreground">{m.adminOccupancies_empty()}</p>
	{:else}
		<section class="flex flex-col gap-3">
			<h2 class="text-lg font-semibold">{m.adminOccupancies_currentHeading()}</h2>

			{#each groups.current as occupancy (occupancy.occupancyId)}
				<article class="flex flex-col gap-3 rounded-lg border border-border p-4">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-medium">{occupancy.residentName}</span>
						<span class="text-sm text-muted-foreground">
							{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
						</span>
					</div>

					<p class="text-sm text-muted-foreground">
						{#if occupancy.endedOn}
							{m.adminOccupancies_currentSinceWithEnd({
								startedOn: occupancy.startedOn,
								endedOn: occupancy.endedOn
							})}
						{:else}
							{m.adminOccupancies_currentSince({ startedOn: occupancy.startedOn })}
						{/if}
					</p>

					<!-- Only a running stay can hold the flag, so every row here may show the badge. -->
					{#if occupancy.isPrimaryOccupant}
						<p class="text-sm font-medium">{m.adminOccupancies_primaryBadge()}</p>
					{/if}

					<div class="flex flex-col gap-3 sm:flex-row sm:items-end">
						{@render endForm(occupancy.occupancyId)}

						<!-- Offered only on a stay that does not hold the flag already. -->
						{#if !occupancy.isPrimaryOccupant}
							<form method="POST" action="?/setPrimary">
								<input type="hidden" name="occupancyId" value={occupancy.occupancyId} />
								<Button type="submit" class="h-11">
									{m.adminOccupancies_setPrimarySubmit()}
								</Button>
							</form>
						{/if}
					</div>
				</article>
			{/each}
		</section>

		{#if groups.upcoming.length > 0}
			<section class="flex flex-col gap-3">
				<h2 class="text-lg font-semibold">{m.adminOccupancies_upcomingHeading()}</h2>

				{#each groups.upcoming as occupancy (occupancy.occupancyId)}
					<article class="flex flex-col gap-3 rounded-lg border border-border p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-medium">{occupancy.residentName}</span>
							<span class="text-sm text-muted-foreground">
								{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
							</span>
						</div>

						<p class="text-sm text-muted-foreground">
							{m.adminOccupancies_upcomingStarts({ startedOn: occupancy.startedOn })}
						</p>

						<!--
							No "Jadikan penanggung jawab" here: the service refuses the flag on a stay that has
							not started, so the button is never offered on one.
						-->
						<div class="flex flex-col gap-3 sm:flex-row sm:items-end">
							{@render endForm(occupancy.occupancyId)}
						</div>
					</article>
				{/each}
			</section>
		{/if}

		<details class="rounded-lg border border-border">
			<summary class="cursor-pointer px-4 py-3 text-lg font-semibold select-none">
				{m.adminOccupancies_historySummary({ count: groups.history.length })}
			</summary>
			<div class="flex flex-col gap-3 border-t border-border p-4">
				{#each groups.history as occupancy (occupancy.occupancyId)}
					<article class="flex flex-col gap-2 rounded-lg border border-border p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-medium">{occupancy.residentName}</span>
							<span class="text-sm text-muted-foreground">
								{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
							</span>
						</div>

						<p class="text-sm text-muted-foreground">
							{m.adminOccupancies_periodEnded({
								startedOn: occupancy.startedOn,
								endedOn: occupancy.endedOn
							})}
						</p>
					</article>
				{/each}
			</div>
		</details>
	{/if}
</main>
