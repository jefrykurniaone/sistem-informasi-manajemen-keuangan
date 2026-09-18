<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import OccupancyForm from '$lib/components/occupancy/occupancy-form.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** Label per occupancy role — the value itself stays what the schema stores. */
	const ROLE_LABEL: Record<string, () => string> = {
		owner: m.adminOccupancies_roleOwner,
		tenant: m.adminOccupancies_roleTenant
	};

	/** The stay's stretch of days, read as one line. */
	function period(startedOn: string, endedOn: string | null): string {
		if (endedOn === null) {
			return m.adminOccupancies_periodRunning({ startedOn });
		}
		return m.adminOccupancies_periodEnded({ startedOn, endedOn });
	}
</script>

<svelte:head>
	<title>{m.adminOccupancies_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
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

	{#if !data.unit.hasPrimaryOccupant}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{m.adminOccupancies_needsPrimaryOccupant()}
		</p>
	{/if}

	<OccupancyForm residents={data.residents} roles={data.roles} formMessage={form?.message} />

	<section class="flex flex-col gap-3">
		<h2 class="text-lg font-semibold">{m.adminOccupancies_historyHeading()}</h2>

		{#each data.occupancies as occupancy (occupancy.occupancyId)}
			<article class="flex flex-col gap-3 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="font-medium">{occupancy.residentName}</span>
					<span class="text-sm text-muted-foreground">
						{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
					</span>
				</div>

				<p class="text-sm text-muted-foreground">
					{period(occupancy.startedOn, occupancy.endedOn)}
				</p>

				{#if occupancy.isPrimaryOccupant}
					<p class="text-sm font-medium">{m.adminOccupancies_primaryBadge()}</p>
				{/if}

				{#if occupancy.isRunning}
					<div class="flex flex-col gap-3 sm:flex-row sm:items-end">
						<form method="POST" action="?/end" class="flex flex-1 flex-col gap-3 sm:flex-row">
							<input type="hidden" name="occupancyId" value={occupancy.occupancyId} />
							<div class="flex flex-1 flex-col gap-1.5">
								<label
									class="text-sm font-medium"
									for="occupancy-end-{occupancy.occupancyId}-{uid}"
								>
									{m.adminOccupancies_endedOnLabel()}
								</label>
								<input
									id="occupancy-end-{occupancy.occupancyId}-{uid}"
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

						{#if !occupancy.isPrimaryOccupant}
							<form method="POST" action="?/setPrimary">
								<input type="hidden" name="occupancyId" value={occupancy.occupancyId} />
								<Button type="submit" class="h-11">
									{m.adminOccupancies_setPrimarySubmit()}
								</Button>
							</form>
						{/if}
					</div>
				{/if}
			</article>
		{/each}

		{#if data.occupancies.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminOccupancies_empty()}</p>
		{/if}
	</section>
</main>
