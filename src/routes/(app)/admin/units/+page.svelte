<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import UnitForm from '$lib/components/unit/unit-form.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	const totalPages = $derived(Math.max(1, Math.ceil(data.totalCount / data.pageSize)));

	/**
	 * The query string for this same screen with `page` replaced, keeping the current search and
	 * filter. Returns only the query string, not the full href — `resolve()` has to be called
	 * directly at each `href={…}` for `eslint-plugin-svelte`'s `no-navigation-without-resolve` to see
	 * it, so the templates below wrap this in `resolve(\`/admin/units?${pageQuery(…)}\`)` themselves.
	 */
	function pageQuery(page: number): string {
		const params = new SvelteURLSearchParams();
		if (data.search) {
			params.set('q', data.search);
		}
		if (data.includeInactive) {
			params.set('includeInactive', 'true');
		}
		params.set('page', String(page));
		return params.toString();
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminUnits_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminUnits_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminUnits_description()}</p>
	</header>

	<UnitForm formMessage={form?.message} />

	<form method="GET" class="flex flex-col gap-3 sm:flex-row sm:items-end">
		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="admin-units-search-{uid}">
				{m.adminUnits_searchLabel()}
			</label>
			<input
				id="admin-units-search-{uid}"
				name="q"
				type="text"
				value={data.search}
				placeholder={m.adminUnits_searchPlaceholder()}
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>
		<label class="flex h-9 items-center gap-2 text-sm" for="admin-units-include-inactive-{uid}">
			<input
				id="admin-units-include-inactive-{uid}"
				name="includeInactive"
				type="checkbox"
				value="true"
				checked={data.includeInactive}
				class="h-4 w-4 rounded border-border"
			/>
			{m.adminUnits_showInactiveLabel()}
		</label>
		<Button type="submit" variant="outline">{m.adminUnits_searchSubmit()}</Button>
	</form>

	<div class="flex flex-col gap-4">
		{#each data.units as unit (unit.id)}
			<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="font-medium">
						{m.unit_label({ block: unit.block, number: unit.number })}
					</span>
					<span class="text-sm text-muted-foreground">
						{unit.isActive ? m.adminUnits_statusActive() : m.adminUnits_statusInactive()}
					</span>
				</div>
				<p class="text-sm text-muted-foreground">
					{m.adminUnits_tableOccupants()}: {unit.activeOccupantCount}
				</p>
				{#if unit.needsPrimaryOccupant}
					<p class="text-sm font-medium text-destructive" role="alert">
						{m.adminOccupancies_needsPrimaryOccupant()}
					</p>
				{/if}
				<div class="flex flex-wrap gap-4">
					<a class="text-sm underline underline-offset-2" href={resolve(`/admin/units/${unit.id}`)}>
						{m.adminUnits_detailLink()}
					</a>
					<a
						class="text-sm underline underline-offset-2"
						href={resolve(`/admin/units/${unit.id}/occupancies`)}
					>
						{m.adminOccupancies_historyLink()}
					</a>
				</div>
			</section>
		{/each}

		{#if data.units.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminUnits_empty()}</p>
		{/if}
	</div>

	{#if data.totalCount > data.pageSize}
		<nav
			class="flex items-center justify-between gap-3 text-sm"
			aria-label={m.adminUnits_heading()}
		>
			<a
				class="rounded-md border border-border px-3 py-1.5"
				class:pointer-events-none={data.page <= 1}
				class:opacity-50={data.page <= 1}
				href={resolve(`/admin/units?${pageQuery(Math.max(1, data.page - 1))}`)}
			>
				{m.adminUnits_prevPage()}
			</a>
			<span class="text-muted-foreground">
				{m.adminUnits_paginationSummary({ page: data.page, totalPages })}
			</span>
			<a
				class="rounded-md border border-border px-3 py-1.5"
				class:pointer-events-none={data.page >= totalPages}
				class:opacity-50={data.page >= totalPages}
				href={resolve(`/admin/units?${pageQuery(Math.min(totalPages, data.page + 1))}`)}
			>
				{m.adminUnits_nextPage()}
			</a>
		</nav>
	{/if}
</main>
