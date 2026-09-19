<script lang="ts" module>
	import type { Rupiah } from '$lib/money';

	/** One category line of a Laporan Bulanan, as the table renders it. */
	export interface ReportCategoryLine {
		/** The drill-down anchor the report froze with the line. */
		readonly categoryId: string;
		/** The category's name as it read at publication, never as it reads now. */
		readonly name: string;
		readonly total: Rupiah;
		/** False for the iuran category, whose rows are one house's payments each. */
		readonly mayDrillDown: boolean;
	}

	/** Where a drill-down link points, or `null` when this table offers none. */
	export interface ReportDrilldownTarget {
		/** The Periode, as `YYYY-MM` — the `[period]` segment of the report's own address. */
		readonly period: string;
		/** The revision being read, carried along so a link never moves the reader to another one. */
		readonly revision: number;
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatRupiah, rupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * One direction of a Laporan Bulanan's per-category breakdown — the "rincian pemasukan per
	 * kategori" and "rincian pengeluaran per kategori" of user story 18 — with a link into each
	 * category's own transactions where one is offered.
	 *
	 * The table is deliberately two columns wide plus a link, so that it stays readable at 390
	 * pixels without a horizontal scroll: a category has a name and a number, and anything else
	 * belongs in the drill-down.
	 *
	 * A line that may not be opened says so rather than silently rendering nothing, and the page
	 * prints the reason underneath. The rule itself is not here: what may be opened is decided in
	 * `src/lib/server/services/report/resident-payload.ts` and arrives as `mayDrillDown`, so a link
	 * this component failed to draw would still be refused if somebody typed its address.
	 *
	 * `total` is the sum of the lines rather than a figure passed in beside them, because the two
	 * would be free to disagree; the report's own headline totals come from the same breakdown
	 * server-side, so this addition is a display of what is already true rather than a second
	 * arithmetic.
	 */
	interface Props {
		readonly heading: string;
		readonly lines: readonly ReportCategoryLine[];
		readonly emptyMessage: string;
		/** Where drill-down links point, or null on a preview with no published revision to link to. */
		readonly drilldown: ReportDrilldownTarget | null;
		/** The category currently opened, so its own row says so instead of linking to itself. */
		readonly openCategoryId?: string | null;
	}

	let {
		heading,
		lines,
		emptyMessage,
		drilldown,
		openCategoryId = null
	}: Readonly<Props> = $props();

	const total = $derived(rupiah(lines.reduce((sum, line) => sum + line.total, 0)));

	/** Whether any line in this table is one the report declines to break down. */
	const hasClosedLine = $derived(lines.some((line) => !line.mayDrillDown));

	/** The query string that opens `categoryId` on the revision currently being read. */
	function drilldownQuery(target: ReportDrilldownTarget, categoryId: string): string {
		return new URLSearchParams({
			revision: String(target.revision),
			category: categoryId
		}).toString();
	}
</script>

<section class="flex flex-col gap-2">
	<h2 class="text-lg font-semibold">{heading}</h2>

	{#if lines.length === 0}
		<p class="text-sm text-muted-foreground">{emptyMessage}</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<caption class="pb-2 text-left text-sm text-muted-foreground">
					{m.reports_categories_caption()}
				</caption>
				<thead>
					<tr class="border-b border-border text-left">
						<th scope="col" class="px-2 py-2 font-medium">
							{m.reports_categories_columnCategory()}
						</th>
						<th scope="col" class="px-2 py-2 text-right font-medium">
							{m.reports_categories_columnTotal()}
						</th>
						<th scope="col" class="px-2 py-2 font-medium">
							{m.reports_categories_columnDetail()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each lines as line (line.categoryId)}
						<tr class="border-b border-border align-top">
							<th scope="row" class="px-2 py-2 text-left font-normal">{line.name}</th>
							<td class="px-2 py-2 text-right whitespace-nowrap">{formatRupiah(line.total)}</td>
							<td class="px-2 py-2">
								{#if !line.mayDrillDown}
									<span class="text-muted-foreground">
										{m.reports_categories_drilldownClosed()}
									</span>
								{:else if line.categoryId === openCategoryId}
									<span class="font-medium">{m.reports_categories_drilldownOpen()}</span>
								{:else if drilldown}
									<a
										class="inline-flex min-h-11 items-center underline underline-offset-4"
										href={resolve(
											`/reports/${drilldown.period}?${drilldownQuery(drilldown, line.categoryId)}`
										)}
									>
										{m.reports_categories_drilldownLink()}
									</a>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" class="px-2 py-2 text-left font-medium">
							{m.reports_categories_totalRow()}
						</th>
						<td class="px-2 py-2 text-right font-semibold whitespace-nowrap">
							{formatRupiah(total)}
						</td>
						<td class="px-2 py-2"></td>
					</tr>
				</tfoot>
			</table>
		</div>

		{#if hasClosedLine}
			<p class="text-xs text-muted-foreground">{m.reports_categories_drilldownClosedHint()}</p>
		{/if}
	{/if}
</section>
