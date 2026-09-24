<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import WorklistTable from '$lib/components/complaint/worklist-table.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const uid = $props.id();

	/** The label for one of the open statuses this screen's filter offers. */
	const STATUS_LABEL: Record<ComplaintStatus, () => string> = {
		new: m.adminComplaints_status_new,
		reviewing: m.adminComplaints_status_reviewing,
		working: m.adminComplaints_status_working,
		resolved: m.adminComplaints_status_resolved,
		rejected: m.adminComplaints_status_rejected,
		withdrawn: m.adminComplaints_status_withdrawn
	};
</script>

<svelte:head>
	<title>{pageTitle(m.adminComplaints_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminComplaints_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminComplaints_description()}</p>
	</header>

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:gap-6">
		<div class="flex flex-1 flex-col gap-1">
			<span class="text-sm text-muted-foreground">{m.adminComplaints_openedThisMonthLabel()}</span>
			<span class="text-2xl font-bold">{data.summary.openedThisMonth}</span>
		</div>
		<div class="flex flex-1 flex-col gap-1">
			<span class="text-sm text-muted-foreground">{m.adminComplaints_resolvedThisMonthLabel()}</span
			>
			<span class="text-2xl font-bold">{data.summary.resolvedThisMonth}</span>
		</div>
	</section>

	<form method="GET" class="flex flex-col gap-3 sm:flex-row sm:items-end">
		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="admin-complaints-status-{uid}">
				{m.adminComplaints_filterStatusLabel()}
			</label>
			<select
				id="admin-complaints-status-{uid}"
				name="status"
				value={data.filters.status}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			>
				<option value="">{m.adminComplaints_filterAll()}</option>
				{#each data.statuses as status (status)}
					<option value={status}>{STATUS_LABEL[status]?.() ?? status}</option>
				{/each}
			</select>
		</div>

		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="admin-complaints-category-{uid}">
				{m.adminComplaints_filterCategoryLabel()}
			</label>
			<input
				id="admin-complaints-category-{uid}"
				name="category"
				type="text"
				value={data.filters.category}
				placeholder={m.adminComplaints_filterCategoryPlaceholder()}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>

		<Button type="submit" variant="outline" class="h-11">
			{m.adminComplaints_filterSubmit()}
		</Button>
	</form>

	<WorklistTable rows={data.complaints} />
</main>
