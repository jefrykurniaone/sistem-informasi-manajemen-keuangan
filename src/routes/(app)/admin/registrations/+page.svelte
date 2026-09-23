<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDay } from '$lib/time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** A day a person reads, out of the instant the row stores. */
	function asDay(instant: Date): string {
		return formatDay(instant);
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminRegistrations_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminRegistrations_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminRegistrations_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	{#each data.registrations as registration (registration.registrationId)}
		<article class="flex flex-col gap-4 rounded-lg border border-border p-4">
			<div class="flex flex-col gap-1">
				<span class="font-medium">{registration.name}</span>
				<span class="text-sm text-muted-foreground">{registration.email}</span>
				<span class="text-sm text-muted-foreground">
					{m.adminRegistrations_submittedOn({ date: asDay(registration.createdAt) })}
				</span>
			</div>

			<div class="flex flex-col gap-1">
				<span class="text-sm">
					{m.adminRegistrations_claim({
						block: registration.claimedBlock,
						number: registration.claimedNumber
					})}
				</span>
				{#if registration.matchedUnit}
					<span class="text-sm text-muted-foreground">
						{m.adminRegistrations_claimMatched({
							block: registration.matchedUnit.block,
							number: registration.matchedUnit.number
						})}
					</span>
				{:else}
					<span
						class="w-fit rounded-md border border-destructive px-2 py-1 text-sm text-destructive"
					>
						{m.adminRegistrations_claimUnknown()}
					</span>
				{/if}
			</div>

			<form method="POST" action="?/approve" class="flex flex-col gap-3 sm:flex-row sm:items-end">
				<input type="hidden" name="registrationId" value={registration.registrationId} />
				<div class="flex flex-1 flex-col gap-1.5">
					<label class="text-sm font-medium" for="unit-{registration.registrationId}-{uid}">
						{m.adminRegistrations_unitLabel()}
					</label>
					<select
						id="unit-{registration.registrationId}-{uid}"
						name="unitId"
						required
						class="min-h-11 rounded-md border border-border bg-background px-3 text-sm"
					>
						{#each data.units as unit (unit.id)}
							<option value={unit.id} selected={unit.id === registration.matchedUnit?.unitId}>
								{m.unit_label({ block: unit.block, number: unit.number })}
							</option>
						{/each}
					</select>
				</div>
				<Button class="min-h-11" type="submit">{m.adminRegistrations_approveSubmit()}</Button>
			</form>

			<form method="POST" action="?/reject" class="flex flex-col gap-3 sm:flex-row sm:items-end">
				<input type="hidden" name="registrationId" value={registration.registrationId} />
				<div class="flex flex-1 flex-col gap-1.5">
					<label class="text-sm font-medium" for="reason-{registration.registrationId}-{uid}">
						{m.adminRegistrations_reasonLabel()}
					</label>
					<input
						id="reason-{registration.registrationId}-{uid}"
						name="reason"
						type="text"
						required
						placeholder={m.adminRegistrations_reasonPlaceholder()}
						class="min-h-11 rounded-md border border-border bg-background px-3 text-sm"
					/>
				</div>
				<Button class="min-h-11" type="submit" variant="outline">
					{m.adminRegistrations_rejectSubmit()}
				</Button>
			</form>
		</article>
	{/each}

	{#if data.registrations.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminRegistrations_empty()}</p>
	{/if}
</main>
