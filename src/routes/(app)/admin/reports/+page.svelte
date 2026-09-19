<script lang="ts">
	import { resolve } from '$app/paths';
	import CategoryTable from '$lib/components/report/category-table.svelte';
	import ReportSummary from '$lib/components/report/report-summary.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	/**
	 * Previewing a Laporan Bulanan and publishing it. The preview is rendered by the very components
	 * the published report uses, so what an admin looked at is what a warga then reads — a screen
	 * that previewed with its own markup would be free to show a different arrangement of the same
	 * numbers, which is how a preview stops being worth looking at.
	 *
	 * The preview carries `revision={null}`, because it has none: it is this month as the buku kas
	 * stands right now, recomputed on every load, and it becomes a numbered revision only when the
	 * button below is pressed.
	 *
	 * The publish form is hidden on a month that is already locked, and that is **not** the
	 * authorization — `publishReport` locks the Periode inside its own transaction and is refused by
	 * name when the month is already locked, whoever posts the form. Hiding it only keeps the screen
	 * from offering something the next click would refuse.
	 */

	let { data, form }: PageProps = $props();

	/** A publication instant is read against a clock, so it is shown whole. */
	const PUBLISHED_AT_FORMAT = new Intl.DateTimeFormat('id-ID', {
		dateStyle: 'long',
		timeStyle: 'short'
	});
</script>

<svelte:head>
	<title>{m.adminReports_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminReports_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminReports_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<form method="GET" class="flex flex-wrap items-end gap-3">
		<label class="flex flex-col gap-1 text-sm">
			<span class="font-medium">{m.adminReports_periodLabel()}</span>
			<select name="period" class="h-11 rounded-md border border-border px-3">
				{#each data.periods as period (period)}
					<option value={period} selected={period === data.period}>{period}</option>
				{/each}
			</select>
		</label>
		<Button type="submit" variant="outline" class="h-11">{m.adminReports_periodSubmit()}</Button>
	</form>

	<section class="flex flex-col gap-4">
		<h2 class="text-xl font-semibold">
			{m.adminReports_previewHeading({ period: data.period })}
		</h2>
		<p class="text-sm text-muted-foreground">{m.adminReports_previewNote()}</p>

		<ReportSummary
			period={data.period}
			figures={data.figures}
			dues={{
				collected: data.figures.duesCollected,
				cashIn: data.duesCashIn,
				unitsPaid: data.figures.duesUnitsPaid,
				unitsUnpaid: data.figures.duesUnitsUnpaid
			}}
			revision={null}
		/>

		<CategoryTable
			heading={m.reports_categories_incomeHeading()}
			lines={data.income}
			emptyMessage={m.reports_categories_incomeEmpty()}
			drilldown={null}
		/>

		<CategoryTable
			heading={m.reports_categories_expenseHeading()}
			lines={data.expense}
			emptyMessage={m.reports_categories_expenseEmpty()}
			drilldown={null}
		/>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="text-xl font-semibold">{m.adminReports_revisionsHeading()}</h2>
		{#if data.revisions.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminReports_revisionsEmpty()}</p>
		{:else}
			<ul class="flex flex-col gap-1">
				{#each data.revisions as revision (revision.id)}
					<li class="text-sm">
						{m.adminReports_revisionRow({
							revision: revision.revision,
							date: PUBLISHED_AT_FORMAT.format(revision.publishedAt)
						})}
						{#if revision.revisionReason !== null}
							<span class="block text-xs text-muted-foreground">
								{m.adminReports_revisionReason({ reason: revision.revisionReason })}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			<a
				class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
				href={resolve(`/reports/${data.period}`)}
			>
				{m.adminReports_openReportLink()}
			</a>
		{/if}
	</section>

	<section class="flex flex-col gap-3">
		{#if data.isLocked}
			<p class="rounded-md border border-border px-3 py-2 text-sm">
				{m.adminReports_lockedNote({ period: data.period })}
			</p>
			<a
				class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
				href={resolve('/admin/periods')}
			>
				{m.adminReports_periodsLink()}
			</a>
		{:else}
			<h2 class="text-xl font-semibold">
				{m.adminReports_publishHeading({ revision: data.nextRevision })}
			</h2>
			<p class="text-sm text-muted-foreground">
				{m.adminReports_publishExplain({ revision: data.nextRevision, period: data.period })}
			</p>
			<form method="POST" action="?/publish" class="flex flex-col gap-3">
				<input type="hidden" name="period" value={data.period} />
				{#if data.revisionReasonRequired}
					<label class="flex flex-col gap-1 text-sm">
						<span class="font-medium">{m.adminReports_reasonLabel()}</span>
						<textarea
							name="revisionReason"
							required
							rows="3"
							class="rounded-md border border-border px-3 py-2"></textarea>
						<span class="text-xs text-muted-foreground">{m.adminReports_reasonHint()}</span>
					</label>
				{/if}
				<Button type="submit" class="h-11 self-start">{m.adminReports_publishSubmit()}</Button>
			</form>
		{/if}
	</section>
</main>
