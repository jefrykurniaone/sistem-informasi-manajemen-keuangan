<script lang="ts">
	import { resolve } from '$app/paths';
	import RupiahInput from '$lib/components/rupiah-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();
</script>

<svelte:head>
	<title>{pageTitle(m.adminPayments_cash_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminPayments_cash_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminPayments_cash_description()}</p>
	</header>

	<a
		href={resolve('/admin/payments')}
		class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
	>
		{m.adminPayments_cash_backLink()}
	</a>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	{#if data.units.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminPayments_cash_noUnits()}</p>
	{:else}
		<form method="POST" action="?/record" class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="unit-{uid}">
					{m.adminPayments_cash_unitLabel()}
				</label>
				<select
					id="unit-{uid}"
					name="unitId"
					required
					class="min-h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					<option value="" selected={!form?.values?.unitId}>
						{m.adminPayments_cash_unitPlaceholder()}
					</option>
					{#each data.units as unit (unit.unitId)}
						<option value={unit.unitId} selected={unit.unitId === form?.values?.unitId}>
							{m.adminPayments_unitName({ block: unit.block, number: unit.number })}
						</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="amount-{uid}">
					{m.adminPayments_cash_amountLabel()}
				</label>
				<RupiahInput
					id="amount-{uid}"
					name="amount"
					required
					value={form?.values?.amount ?? ''}
					placeholder={m.adminPayments_cash_amountPlaceholder()}
				/>
				<p class="text-sm text-muted-foreground">{m.adminPayments_cash_amountHint()}</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="received-on-{uid}">
					{m.adminPayments_cash_receivedOnLabel()}
				</label>
				<input
					id="received-on-{uid}"
					name="receivedOn"
					type="date"
					required
					value={form?.values?.receivedOn ?? ''}
					class="min-h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>

			<Button class="min-h-11 self-start" type="submit">{m.adminPayments_cash_submit()}</Button>
		</form>
	{/if}
</main>
