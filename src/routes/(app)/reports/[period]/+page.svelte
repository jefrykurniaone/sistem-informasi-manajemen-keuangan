<script lang="ts">
	import { resolve } from '$app/paths';
	import CategoryTable from '$lib/components/report/category-table.svelte';
	import ReportSummary from '$lib/components/report/report-summary.svelte';
	import { formatRupiah } from '$lib/money';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDateTime, formatDay } from '$lib/time';
	import type { PageProps } from './$types';

	/**
	 * One published Laporan Bulanan: the revision banner, the four cash figures, the iuran summary,
	 * the two per-category breakdowns, and — when a reader opens one — the transactions inside a
	 * category.
	 *
	 * Everything on this page except the drill-down list is the frozen document. The drill-down is
	 * the live buku kas, because a published report holds per-category *totals* and no list of rows;
	 * `src/lib/server/services/report/composition.ts` records why that split is forced. When the two
	 * disagree the page says so rather than hiding it — a month that changed after its report went
	 * out is a real fact about the complex's books, and the next revision is where it lands.
	 *
	 * There is no name anywhere on this page, and that is not because the markup leaves one out: the
	 * payload has no field that could hold one. See
	 * `src/lib/server/services/report/resident-payload.ts`.
	 */

	let { data }: PageProps = $props();

	/** The stored value that means money coming in, as `cash_transactions.type` writes it. */
	const INCOME = 'income';

	/** A stored `YYYY-MM-DD` as a day a person reads — `$lib/time`'s `formatDay`. */
	function asDay(day: string): string {
		return formatDay(new Date(`${day}T00:00:00.000Z`));
	}
</script>

<svelte:head>
	<title>{pageTitle(m.reports_detail_pageTitle({ period: data.report.period }))}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<a
		class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
		href={resolve('/reports')}
	>
		{m.reports_detail_backLink()}
	</a>

	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">
			{m.reports_detail_heading({ period: data.report.period })}
		</h1>
	</header>

	<ReportSummary
		period={data.report.period}
		figures={data.report.headline}
		dues={data.report.dues}
		revision={{
			revision: data.report.revision,
			publishedAt: data.report.publishedAt,
			revisionReason: data.report.revisionReason,
			isLatest: data.report.isLatest
		}}
	/>

	<CategoryTable
		heading={m.reports_categories_incomeHeading()}
		lines={data.report.income}
		emptyMessage={m.reports_categories_incomeEmpty()}
		drilldown={{ period: data.report.period, revision: data.report.revision }}
		openCategoryId={data.drilldown?.categoryId ?? null}
	/>

	<CategoryTable
		heading={m.reports_categories_expenseHeading()}
		lines={data.report.expense}
		emptyMessage={m.reports_categories_expenseEmpty()}
		drilldown={{ period: data.report.period, revision: data.report.revision }}
		openCategoryId={data.drilldown?.categoryId ?? null}
	/>

	{#if data.drilldown}
		{@const detail = data.drilldown}
		<section class="flex flex-col gap-2">
			<h2 class="text-lg font-semibold">
				{m.reports_drilldown_heading({ category: detail.name })}
			</h2>

			{#if detail.frozenIncomeTotal > 0 || detail.liveIncomeTotal > 0}
				<p class="text-sm text-muted-foreground">
					{m.reports_drilldown_frozenIncome({ amount: formatRupiah(detail.frozenIncomeTotal) })}
					·
					{m.reports_drilldown_liveIncome({ amount: formatRupiah(detail.liveIncomeTotal) })}
				</p>
			{/if}
			{#if detail.frozenExpenseTotal > 0 || detail.liveExpenseTotal > 0}
				<p class="text-sm text-muted-foreground">
					{m.reports_drilldown_frozenExpense({ amount: formatRupiah(detail.frozenExpenseTotal) })}
					·
					{m.reports_drilldown_liveExpense({ amount: formatRupiah(detail.liveExpenseTotal) })}
				</p>
			{/if}
			{#if detail.changedSincePublication}
				<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
					{m.reports_drilldown_changed()}
				</p>
			{/if}

			{#if detail.entries.length === 0}
				<p class="text-sm text-muted-foreground">{m.reports_drilldown_empty()}</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<caption class="pb-2 text-left text-sm text-muted-foreground">
							{m.reports_drilldown_caption()}
						</caption>
						<thead>
							<tr class="border-b border-border text-left">
								<th scope="col" class="px-2 py-2 font-medium">
									{m.reports_drilldown_columnDate()}
								</th>
								<th scope="col" class="px-2 py-2 font-medium">
									{m.reports_drilldown_columnDescription()}
								</th>
								<th scope="col" class="px-2 py-2 text-right font-medium">
									{m.reports_drilldown_columnIn()}
								</th>
								<th scope="col" class="px-2 py-2 text-right font-medium">
									{m.reports_drilldown_columnOut()}
								</th>
							</tr>
						</thead>
						<tbody>
							{#each detail.entries as entry (entry.id)}
								<tr class="border-b border-border align-top">
									<td class="px-2 py-2 whitespace-nowrap">{asDay(entry.occurredOn)}</td>
									<td class="px-2 py-2">
										<span>{entry.description}</span>
										{#if entry.isCorrection}
											<span class="block text-xs font-medium">
												{m.reports_drilldown_correctionBadge()}
											</span>
										{/if}
									</td>
									<td class="px-2 py-2 text-right whitespace-nowrap">
										{entry.type === INCOME ? formatRupiah(entry.amount) : ''}
									</td>
									<td class="px-2 py-2 text-right whitespace-nowrap">
										{entry.type === INCOME ? '' : formatRupiah(entry.amount)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<a
				class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
				href={resolve(`/reports/${data.report.period}?revision=${data.report.revision}`)}
			>
				{m.reports_drilldown_closeLink()}
			</a>
		</section>
	{/if}

	<section class="flex flex-col gap-2">
		<h2 class="text-lg font-semibold">{m.reports_detail_revisionsHeading()}</h2>
		<ul class="flex flex-col gap-1">
			{#each data.report.revisions as revision (revision.id)}
				<li class="text-sm">
					{#if revision.revision === data.report.revision}
						<span class="font-medium">
							{m.reports_detail_revisionLink({
								revision: revision.revision,
								date: formatDateTime(revision.publishedAt)
							})}
						</span>
						<span class="text-muted-foreground">({m.reports_detail_revisionCurrent()})</span>
					{:else}
						<a
							class="inline-flex min-h-11 items-center underline underline-offset-4"
							href={resolve(`/reports/${data.report.period}?revision=${revision.revision}`)}
						>
							{m.reports_detail_revisionLink({
								revision: revision.revision,
								date: formatDateTime(revision.publishedAt)
							})}
						</a>
					{/if}
					{#if revision.revisionReason !== null}
						<span class="block text-xs text-muted-foreground">
							{m.reports_revisionReason({ reason: revision.revisionReason })}
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
</main>
