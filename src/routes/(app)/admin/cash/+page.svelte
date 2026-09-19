<script lang="ts">
	import { resolve } from '$app/paths';
	import CashBookTable from '$lib/components/cash/cash-book-table.svelte';
	import CorrectionDialog, {
		type CorrectableCashTransaction
	} from '$lib/components/cash/correction-dialog.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** The line a Koreksi is being written for, or nothing while the dialog is closed. */
	let correcting = $state<CorrectableCashTransaction | undefined>(undefined);

	/** The category the filter is on, when it is on one and that category is still in the book. */
	const filteredCategory = $derived(
		data.categories.find((category) => category.id === data.filter.categoryId)
	);

	/**
	 * What the balance column means for the filter currently on.
	 *
	 * Saying it is not decoration. A running balance over a filtered view is either the balance of
	 * the filtered rows or the true balance at each row, and
	 * `src/lib/server/services/cash/balance.ts` picks the first; a column headed "saldo berjalan"
	 * that silently changed meaning with a dropdown is exactly the unexplained difference this
	 * spec's problem statement is about.
	 */
	const scopeNote = $derived(scopeNoteFor(data.filter.month, filteredCategory?.name));

	/** The sentence above the table, for each of the four combinations of the two filters. */
	function scopeNoteFor(month: string | undefined, category: string | undefined): string {
		if (category === undefined) {
			return month === undefined ? m.adminCash_scopeAll() : m.adminCash_scopeMonth();
		}
		return month === undefined
			? m.adminCash_scopeCategory({ category })
			: m.adminCash_scopeMonthAndCategory({ category });
	}
</script>

<svelte:head>
	<title>{m.adminCash_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminCash_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminCash_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<div>
		<a
			class="inline-flex h-11 items-center rounded-md border border-border px-4 text-sm font-medium"
			href={resolve('/admin/cash/new')}
		>
			{m.adminCash_newLink()}
		</a>
	</div>

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="font-medium">{m.adminCash_filterHeading()}</h2>
		<form method="GET" class="flex flex-col gap-3 sm:flex-row sm:items-end">
			<div class="flex flex-1 flex-col gap-1.5">
				<label class="text-sm font-medium" for="cash-filter-month-{uid}">
					{m.adminCash_filterMonthLabel()}
				</label>
				<select
					id="cash-filter-month-{uid}"
					name="month"
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					<option value="" selected={data.filter.month === undefined}>
						{m.adminCash_filterMonthAll()}
					</option>
					{#each data.months as month (month)}
						<option value={month} selected={data.filter.month === month}>{month}</option>
					{/each}
				</select>
			</div>
			<div class="flex flex-1 flex-col gap-1.5">
				<label class="text-sm font-medium" for="cash-filter-category-{uid}">
					{m.adminCash_filterCategoryLabel()}
				</label>
				<select
					id="cash-filter-category-{uid}"
					name="category"
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					<option value="" selected={data.filter.categoryId === undefined}>
						{m.adminCash_filterCategoryAll()}
					</option>
					{#each data.categories as category (category.id)}
						<option value={category.id} selected={data.filter.categoryId === category.id}>
							{category.name}
						</option>
					{/each}
				</select>
			</div>
			<Button type="submit" class="h-11">{m.adminCash_filterSubmit()}</Button>
		</form>
	</section>

	<section class="flex flex-col gap-3">
		<p class="text-sm text-muted-foreground">{scopeNote}</p>

		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm sm:max-w-md">
			<dt class="text-muted-foreground">{m.adminCash_openingBalanceLabel()}</dt>
			<dd class="font-medium">{formatRupiah(data.openingBalance)}</dd>
			<dt class="text-muted-foreground">{m.adminCash_closingBalanceLabel()}</dt>
			<dd class="font-medium">{formatRupiah(data.closingBalance)}</dd>
		</dl>

		{#if data.rows.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminCash_empty()}</p>
		{:else}
			<CashBookTable
				rows={data.rows}
				onCorrect={(transaction) => {
					correcting = transaction;
				}}
			/>
		{/if}
	</section>
</main>

<CorrectionDialog
	action="?/correct"
	transaction={correcting}
	onClose={() => {
		correcting = undefined;
	}}
/>
