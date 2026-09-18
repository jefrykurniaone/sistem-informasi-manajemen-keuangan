<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Label per occupancy role — the value itself stays what the schema stores. */
	const ROLE_LABEL: Record<string, () => string> = {
		owner: m.myUnit_roleOwner,
		tenant: m.myUnit_roleTenant
	};

	/** The stay's stretch of days, read as one line. */
	function period(startedOn: string, endedOn: string | null): string {
		if (endedOn === null) {
			return m.myUnit_periodRunning({ startedOn });
		}
		return m.myUnit_periodEnded({ startedOn, endedOn });
	}
</script>

<svelte:head>
	<title>{m.myUnit_pageTitle()} — Komplek</title>
</svelte:head>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.myUnit_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.myUnit_subheading()}</p>
	</header>

	{#if !data.hasResidentRecord}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.myUnit_noRecordTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.myUnit_noRecordBody()}</p>
		</section>
	{:else if data.occupancies.length === 0}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.myUnit_emptyTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.myUnit_emptyBody()}</p>
		</section>
	{:else}
		{#each data.occupancies as occupancy (occupancy.occupancyId)}
			<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="font-medium">
						{m.myUnit_unitHeading({ block: occupancy.block, number: occupancy.number })}
					</h2>
					<span class="text-sm text-muted-foreground">
						{ROLE_LABEL[occupancy.role]?.() ?? occupancy.role}
					</span>
				</div>

				<p class="text-sm text-muted-foreground">
					{period(occupancy.startedOn, occupancy.endedOn)}
				</p>

				{#if occupancy.isPrimaryOccupant}
					<p class="text-sm font-medium">{m.myUnit_primaryBadge()}</p>
				{/if}

				{#if occupancy.endedOn === null}
					<h3 class="text-sm font-medium">{m.myUnit_occupantsHeading()}</h3>
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
				{:else}
					<p class="text-sm text-muted-foreground">{m.myUnit_endedNote()}</p>
				{/if}
			</section>
		{/each}
	{/if}
</main>
