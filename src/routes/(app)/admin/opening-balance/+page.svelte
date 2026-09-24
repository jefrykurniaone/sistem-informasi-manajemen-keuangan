<script lang="ts">
	import RupiahInput from '$lib/components/rupiah-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatRupiah } from '$lib/money';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDay } from '$lib/time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** A stored `YYYY-MM-DD` as a day a person reads — `$lib/time`'s `formatDay`. */
	function asDay(day: string): string {
		return formatDay(new Date(`${day}T00:00:00.000Z`));
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminOpeningBalance_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminOpeningBalance_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminOpeningBalance_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	{#if data.openingBalance}
		<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.adminOpeningBalance_recordedHeading()}</h2>
			<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
				<dt class="text-muted-foreground">{m.adminOpeningBalance_recordedAmountLabel()}</dt>
				<dd class="font-medium">{formatRupiah(data.openingBalance.amount)}</dd>
				<dt class="text-muted-foreground">{m.adminOpeningBalance_recordedDateLabel()}</dt>
				<dd>{asDay(data.openingBalance.occurredOn)}</dd>
			</dl>
			<p class="text-sm text-muted-foreground">{m.adminOpeningBalance_recordedNote()}</p>
		</section>
	{:else}
		<form
			method="POST"
			action="?/record"
			class="flex flex-col gap-4 rounded-lg border border-border p-4"
		>
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="opening-balance-amount-{uid}">
					{m.adminOpeningBalance_amountLabel()}
				</label>
				<RupiahInput
					id="opening-balance-amount-{uid}"
					name="amount"
					required
					placeholder={m.adminOpeningBalance_amountPlaceholder()}
					aria-describedby="opening-balance-amount-hint-{uid}"
				/>
				<p id="opening-balance-amount-hint-{uid}" class="text-sm text-muted-foreground">
					{m.adminOpeningBalance_amountHint()}
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="opening-balance-date-{uid}">
					{m.adminOpeningBalance_dateLabel()}
				</label>
				<input
					id="opening-balance-date-{uid}"
					name="occurredOn"
					type="date"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>
			<div>
				<Button type="submit" class="h-11">{m.adminOpeningBalance_recordSubmit()}</Button>
			</div>
		</form>
	{/if}
</main>
