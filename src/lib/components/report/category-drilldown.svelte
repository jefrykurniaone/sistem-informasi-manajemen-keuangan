<script lang="ts" module>
	import type { Rupiah } from '$lib/money';

	/** Which way money moves on a category line: the stored type of a Kategori Kas. */
	export type ReportDirection = 'income' | 'expense';

	/** One Transaksi Kas inside an opened category line, as the detail renders it. */
	export interface ReportDrilldownEntry {
		readonly id: string;
		/** The day money moved, as `YYYY-MM-DD`. */
		readonly occurredOn: string;
		/** The keterangan, or on a Koreksi, the alasan. */
		readonly description: string;
		readonly amount: Rupiah;
		readonly isCorrection: boolean;
	}

	/** One category line opened out into its transactions, one direction only. */
	export interface ReportCategoryDetail {
		/** The name as the revision being read froze it. */
		readonly name: string;
		/** The direction every entry moves in, which is also the table this detail belongs to. */
		readonly direction: ReportDirection;
		/** The figure published on the line. */
		readonly frozenTotal: Rupiah;
		/** The same direction in the buku kas right now. */
		readonly liveTotal: Rupiah;
		/** True when the two above disagree. */
		readonly changedSincePublication: boolean;
		readonly entries: readonly ReportDrilldownEntry[];
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDay } from '$lib/time';

	/**
	 * The transactions behind one category line, drawn inside the detail row that
	 * `category-table.svelte` puts directly under that line.
	 *
	 * Only one direction, so the Jumlah column adds up to the figure on the row above it; the payload
	 * already carries only that direction, see `src/lib/server/services/report/resident-payload.ts`.
	 * That is also why the table is three columns and not four: every amount moves the same way, so
	 * there is nothing for a kas masuk and a kas keluar column to tell apart, and three columns fit
	 * at 390 pixels with the keterangan wrapping and the amount whole.
	 *
	 * The published and live figures are printed only when they differ. When they agree the row
	 * above already says the number, and saying it twice more is noise.
	 *
	 * The heading takes `tabindex="-1"` so the report page can move focus onto it after the detail
	 * opens; it is never a stop in the tab order. The page does that, not this component, because
	 * only the page knows whether the navigation that drew it was an open.
	 */
	interface Props {
		readonly detail: ReportCategoryDetail;
		/** The heading's id, which the report page focuses. */
		readonly headingId: string;
		/**
		 * The "Tutup" link at the end of the detail. A snippet from `category-table.svelte`, which
		 * draws the row's own "Tutup" too, so the two are one link with one address.
		 */
		readonly closeLink: Snippet;
	}

	let { detail, headingId, closeLink }: Readonly<Props> = $props();

	/** The direction whose heading reads "kas masuk". */
	const INCOME: ReportDirection = 'income';

	const heading = $derived(
		detail.direction === INCOME
			? m.reports_drilldown_headingIncome({ category: detail.name })
			: m.reports_drilldown_headingExpense({ category: detail.name })
	);

	/** A stored `YYYY-MM-DD` as a day a person reads — `$lib/time`'s `formatDay`. */
	function asDay(day: string): string {
		return formatDay(new Date(`${day}T00:00:00.000Z`));
	}
</script>

<div class="flex flex-col gap-2 pt-1 pb-2">
	<h3 id={headingId} tabindex="-1" class="text-base font-semibold">{heading}</h3>

	{#if detail.changedSincePublication}
		<p class="text-sm text-muted-foreground">
			{m.reports_drilldown_figures({
				published: formatRupiah(detail.frozenTotal),
				live: formatRupiah(detail.liveTotal)
			})}
		</p>
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
			{m.reports_drilldown_changed()}
		</p>
	{/if}

	{#if detail.entries.length === 0}
		<p class="text-sm text-muted-foreground">{m.reports_drilldown_empty()}</p>
	{:else}
		<table class="w-full border-collapse text-sm">
			<caption class="pb-2 text-left text-sm text-muted-foreground">
				{m.reports_drilldown_caption()}
			</caption>
			<thead>
				<tr class="border-b border-border text-left">
					<th scope="col" class="py-2 pr-2 font-medium">{m.reports_drilldown_columnDate()}</th>
					<th scope="col" class="px-2 py-2 font-medium">
						{m.reports_drilldown_columnDescription()}
					</th>
					<th scope="col" class="py-2 pl-2 text-right font-medium">
						{m.reports_drilldown_columnAmount()}
					</th>
				</tr>
			</thead>
			<tbody>
				{#each detail.entries as entry (entry.id)}
					<tr class="border-b border-border align-top">
						<td class="py-2 pr-2 whitespace-nowrap">{asDay(entry.occurredOn)}</td>
						<td class="px-2 py-2 wrap-anywhere">
							<span>{entry.description}</span>
							{#if entry.isCorrection}
								<span class="block text-xs font-medium">
									{m.reports_drilldown_correctionBadge()}
								</span>
							{/if}
						</td>
						<td class="py-2 pl-2 text-right whitespace-nowrap">{formatRupiah(entry.amount)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<div class="self-start">
		{@render closeLink()}
	</div>
</div>
