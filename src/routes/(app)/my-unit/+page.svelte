<script lang="ts">
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Label per occupancy role — the value itself stays what the schema stores. */
	const ROLE_LABEL: Record<string, () => string> = {
		owner: m.myUnit_roleOwner,
		tenant: m.myUnit_roleTenant
	};

	/**
	 * `occupiedUnitsForUserGrouped` already splits these houses into the three groups
	 * `docs/spec-penghuni-v1.md` decision 3 defines. This page only renders them; it makes no date
	 * comparison and no `endedOn === null` check of its own.
	 */
	const groups = $derived(data.occupancies);
	const hasAnyHouse = $derived(
		groups.current.length > 0 || groups.upcoming.length > 0 || groups.history.length > 0
	);
</script>

<svelte:head>
	<title>{pageTitle(m.myUnit_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.myUnit_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.myUnit_subheading()}</p>
	</header>

	{#if !data.hasResidentRecord}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.myUnit_noRecordTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.myUnit_noRecordBody()}</p>
		</section>
	{:else if !hasAnyHouse}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.myUnit_emptyTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.myUnit_emptyBody()}</p>
		</section>
	{:else}
		{#if groups.current.length > 0}
			<section class="flex flex-col gap-3">
				<h2 class="text-lg font-semibold">{m.myUnit_currentHeading()}</h2>

				{#each groups.current as occupancy (occupancy.occupancyId)}
					<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<h3 class="font-medium">
								{m.myUnit_unitHeading({ block: occupancy.block, number: occupancy.number })}
							</h3>
							<span class="text-sm text-muted-foreground">
								{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
							</span>
						</div>

						<p class="text-sm text-muted-foreground">
							{#if occupancy.endedOn}
								{m.myUnit_currentSinceWithEnd({
									startedOn: occupancy.startedOn,
									endedOn: occupancy.endedOn
								})}
							{:else}
								{m.myUnit_currentSince({ startedOn: occupancy.startedOn })}
							{/if}
						</p>

						{#if occupancy.isPrimaryOccupant}
							<p class="text-sm font-medium">{m.myUnit_primaryBadge()}</p>
						{/if}

						<h4 class="text-sm font-medium">{m.myUnit_occupantsHeading()}</h4>
						<ul class="flex flex-col gap-2">
							{#each occupancy.occupants as occupant (occupant.residentId)}
								<li class="flex flex-wrap items-center justify-between gap-2 text-sm">
									<span>{occupant.name}</span>
									<span class="text-muted-foreground">
										{ROLE_LABEL[occupant.role]?.() ?? occupant.role}
										{#if occupant.isPrimaryOccupant}
											· {m.myUnit_occupantPrimaryBadge()}
										{/if}
									</span>
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</section>
		{/if}

		{#if groups.upcoming.length > 0}
			<section class="flex flex-col gap-3">
				<h2 class="text-lg font-semibold">{m.myUnit_upcomingHeading()}</h2>

				{#each groups.upcoming as occupancy (occupancy.occupancyId)}
					<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<h3 class="font-medium">
								{m.myUnit_unitHeading({ block: occupancy.block, number: occupancy.number })}
							</h3>
							<span class="text-sm text-muted-foreground">
								{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
							</span>
						</div>

						<p class="text-sm text-muted-foreground">
							{m.myUnit_upcomingStarts({ startedOn: occupancy.startedOn })}
						</p>
					</section>
				{/each}
			</section>
		{/if}

		{#if groups.history.length > 0}
			<details class="rounded-lg border border-border">
				<summary class="cursor-pointer px-4 py-3 text-lg font-semibold select-none">
					{m.myUnit_historySummary({ count: groups.history.length })}
				</summary>
				<div class="flex flex-col gap-3 border-t border-border p-4">
					{#each groups.history as occupancy (occupancy.occupancyId)}
						<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<h3 class="font-medium">
									{m.myUnit_unitHeading({ block: occupancy.block, number: occupancy.number })}
								</h3>
								<span class="text-sm text-muted-foreground">
									{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
								</span>
							</div>

							<p class="text-sm text-muted-foreground">
								{m.myUnit_periodEnded({
									startedOn: occupancy.startedOn,
									endedOn: occupancy.endedOn
								})}
							</p>
						</section>
					{/each}
				</div>
			</details>
		{/if}
	{/if}
</main>
