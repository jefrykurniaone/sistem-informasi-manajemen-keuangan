<script lang="ts" module>
	import type { Rupiah } from '$lib/money';
	import type { ReportCategoryDetail, ReportDirection } from './category-drilldown.svelte';

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
		/**
		 * Which direction this table's lines move in. It becomes the links' `type`, and only a detail
		 * in the same direction is drawn here, so opening a category's expense line never opens
		 * anything in the income table. Carried on the target rather than on every line because the
		 * admin preview passes no target at all and so needs no direction either.
		 */
		readonly direction: ReportDirection;
	}

	/** The detail of an opened line, and which category it opened. */
	export interface ReportOpenedLine extends ReportCategoryDetail {
		readonly categoryId: string;
	}

	/**
	 * The `id` of one category line's row, stable per direction and category, which every open and
	 * close link carries as its `#`. The direction is in it because a category with a Koreksi in the
	 * month has a row in each table, and two elements may not share an id.
	 */
	export function categoryRowId(direction: ReportDirection, categoryId: string): string {
		return `transaksi-${direction}-${categoryId}`;
	}

	/** The `id` of the heading of the detail opened under that row, which the report page focuses. */
	export function drilldownHeadingId(direction: ReportDirection, categoryId: string): string {
		return `${categoryRowId(direction, categoryId)}-heading`;
	}

	/** The `id` of that row's "Lihat transaksi" link, which focus returns to when the detail closes. */
	export function drilldownOpenLinkId(direction: ReportDirection, categoryId: string): string {
		return `${categoryRowId(direction, categoryId)}-open`;
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatRupiah, rupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import CategoryDrilldown from './category-drilldown.svelte';

	/**
	 * One direction of a Laporan Bulanan's per-category breakdown — the "rincian pemasukan per
	 * kategori" and "rincian pengeluaran per kategori" of user story 18 — with a link into each
	 * category's own transactions where one is offered, and the opened one drawn directly under its
	 * row.
	 *
	 * A line is three columns: a name, a number, and the link. That stays readable at 390 pixels
	 * without a horizontal scroll. The opened detail is one more row under the line, a single cell as
	 * wide as the table, so it sits where the reader clicked instead of below both tables; its
	 * content is `category-drilldown.svelte`.
	 *
	 * A line that may not be opened says so rather than silently rendering nothing, and the
	 * component prints the reason underneath. The rule itself is not here: what may be opened is
	 * decided in `src/lib/server/services/report/resident-payload.ts` and arrives as
	 * `mayDrillDown`, so a link this component failed to draw would still be refused if somebody
	 * typed its address.
	 *
	 * ## Why every open and close link carries `noscroll` and `keepfocus`
	 *
	 * Opening or closing a detail is a navigation, because the address is what makes it work
	 * without JavaScript and what a reader shares. `noscroll` keeps the screen where it was instead
	 * of jumping to the top. `keepfocus` stops SvelteKit resetting focus: in the installed 2.70,
	 * `reset_focus` in `@sveltejs/kit/src/runtime/client/client.js` sets the focus starting point to
	 * the `#` with `location.replace` inside a `setTimeout` and then scrolls back, which can flicker,
	 * and lands after the report page's own `afterNavigate` has moved focus to the heading or back to
	 * "Lihat transaksi", undoing it. The page does the focusing; see its `afterNavigate`. Without
	 * JavaScript neither attribute means anything and the browser jumps to the `#` row, which is
	 * where the reader was.
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
		/**
		 * The opened category line, in whichever table it belongs to. Drawn here only when its
		 * direction is this table's; the page hands the same detail to both tables.
		 */
		readonly detail?: ReportOpenedLine | null;
	}

	let { heading, lines, emptyMessage, drilldown, detail = null }: Readonly<Props> = $props();

	/** How many columns a line has, which is how wide the detail row's single cell spans. */
	const COLUMN_COUNT = 3;

	/**
	 * The classes of a link inside a line's third cell, "Lihat transaksi" and "Tutup" alike.
	 * `inline-flex` aligns the text on the row's baseline while the box stays 44 pixels tall, and
	 * `-mt-3` stops the line box growing upwards. No matching `-mb-3`: that shrinks rows until
	 * neighbouring 44-pixel boxes overlap (#267).
	 */
	const ROW_LINK_CLASS = '-mt-3 inline-flex min-h-11 items-center underline underline-offset-4';

	/** The classes of the "Tutup" at the end of an open detail, which has no row text to align with. */
	const END_LINK_CLASS = 'inline-flex min-h-11 items-center underline underline-offset-4';

	const total = $derived(rupiah(lines.reduce((sum, line) => sum + line.total, 0)));

	/** Whether any line in this table is one the report declines to break down. */
	const hasClosedLine = $derived(lines.some((line) => !line.mayDrillDown));

	/** The detail to draw in this table, or null when none is open or it belongs to the other one. */
	const openDetail = $derived(
		drilldown !== null && detail !== null && detail.direction === drilldown.direction
			? detail
			: null
	);

	/** The query string that opens `categoryId` in this table's direction on the revision read. */
	function openQuery(target: ReportDrilldownTarget, categoryId: string): string {
		return new URLSearchParams({
			revision: String(target.revision),
			category: categoryId,
			type: target.direction
		}).toString();
	}

	/** The query string that closes whatever is open, keeping the revision being read. */
	function closeQuery(target: ReportDrilldownTarget): string {
		return new URLSearchParams({ revision: String(target.revision) }).toString();
	}
</script>

<!--
	The "Tutup" of an open line, drawn twice with one address: in the row, and at the end of the
	detail under it. In the row it takes the same classes as "Lihat transaksi", so the two align
	identically; at the end of the detail there is no row text to align with, and no pull upwards.
-->
{#snippet closeLinkFor(target: ReportDrilldownTarget, line: ReportCategoryLine, linkClass: string)}
	<a
		class={linkClass}
		href={resolve(
			`/reports/${target.period}?${closeQuery(target)}#${categoryRowId(target.direction, line.categoryId)}`
		)}
		aria-label={m.reports_drilldown_closeLabel({ category: line.name })}
		data-sveltekit-noscroll
		data-sveltekit-keepfocus
	>
		{m.reports_drilldown_closeLink()}
	</a>
{/snippet}

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
							{m.reports_categories_columnTransactions()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each lines as line (line.categoryId)}
						{@const isOpen = openDetail?.categoryId === line.categoryId}
						<tr
							id={drilldown ? categoryRowId(drilldown.direction, line.categoryId) : undefined}
							class="border-b border-border align-top"
						>
							<th scope="row" class="px-2 py-2 text-left font-normal">{line.name}</th>
							<td class="px-2 py-2 text-right whitespace-nowrap">{formatRupiah(line.total)}</td>
							<td class="px-2 py-2">
								{#if !line.mayDrillDown}
									<span class="text-muted-foreground">
										{m.reports_categories_drilldownNotShown()}
									</span>
								{:else if !drilldown}
									<span class="text-muted-foreground">
										{m.reports_categories_previewAvailableAfterPublish()}
									</span>
								{:else if isOpen}
									{@render closeLinkFor(drilldown, line, ROW_LINK_CLASS)}
								{:else}
									<a
										id={drilldownOpenLinkId(drilldown.direction, line.categoryId)}
										class={ROW_LINK_CLASS}
										href={resolve(
											`/reports/${drilldown.period}?${openQuery(drilldown, line.categoryId)}#${categoryRowId(drilldown.direction, line.categoryId)}`
										)}
										data-sveltekit-noscroll
										data-sveltekit-keepfocus
									>
										{m.reports_categories_drilldownLink()}
									</a>
								{/if}
							</td>
						</tr>
						{#if isOpen && openDetail && drilldown}
							<tr class="border-b border-border">
								<td colspan={COLUMN_COUNT} class="px-2 py-2">
									<CategoryDrilldown
										detail={openDetail}
										headingId={drilldownHeadingId(openDetail.direction, openDetail.categoryId)}
									>
										{#snippet closeLink()}
											{@render closeLinkFor(drilldown, line, END_LINK_CLASS)}
										{/snippet}
									</CategoryDrilldown>
								</td>
							</tr>
						{/if}
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
