<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ReportDirection } from '$lib/components/report/category-drilldown.svelte';
	import CategoryTable, {
		drilldownHeadingId,
		drilldownOpenLinkId
	} from '$lib/components/report/category-table.svelte';
	import ReportSummary from '$lib/components/report/report-summary.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDateTime } from '$lib/time';
	import type { PageProps } from './$types';

	/**
	 * One published Laporan Bulanan: the revision banner, the four cash figures, the iuran summary,
	 * and the two per-category breakdowns, with — when a reader opens one — the transactions inside
	 * one category line, drawn directly under that line by `CategoryTable`.
	 *
	 * Everything on this page except that opened detail is the frozen document. The detail is the
	 * live buku kas, because a published report holds per-category *totals* and no list of rows;
	 * `src/lib/server/services/report/composition.ts` records why that split is forced. When the two
	 * disagree the detail says so rather than hiding it — a month that changed after its report went
	 * out is a real fact about the complex's books, and the next revision is where it lands.
	 *
	 * There is no name anywhere on this page, and that is not because the markup leaves one out: the
	 * payload has no field that could hold one. See
	 * `src/lib/server/services/report/resident-payload.ts`.
	 */

	let { data }: PageProps = $props();

	/** The two directions a category line moves in, as `cash_categories.type` stores them. */
	const INCOME: ReportDirection = 'income';
	const EXPENSE: ReportDirection = 'expense';

	/** Which category line is open on which revision, as far as moving focus is concerned. */
	interface OpenState {
		readonly period: string;
		readonly revision: number;
		readonly opened: { readonly direction: ReportDirection; readonly categoryId: string } | null;
	}

	/**
	 * What was open when the previous navigation finished. Plain state, not `$state`: nothing renders
	 * from it, it only lets the next `afterNavigate` tell an open from a close.
	 */
	let previous: OpenState | undefined;

	/** The state `data` describes right now. */
	function openState(): OpenState {
		const detail = data.drilldown;
		return {
			period: data.report.period,
			revision: data.report.revision,
			opened: detail ? { direction: detail.direction, categoryId: detail.categoryId } : null
		};
	}

	/**
	 * Focus follows what just opened or closed, because the links that open and close a detail carry
	 * `data-sveltekit-keepfocus` and SvelteKit leaves focus alone; `category-table.svelte` records why.
	 * Without this, the clicked link is replaced by the render and focus falls to the `<body>`.
	 *
	 * `afterNavigate` runs once the new DOM is in place and after SvelteKit's own scroll handling,
	 * so the element to focus exists and nothing scrolls after it. `focus()` is called without
	 * `preventScroll` on purpose: when a detail higher up collapses as another opens, the new heading
	 * can end up off screen, and focusing it scrolls it back in; when it is already visible, nothing
	 * moves.
	 *
	 * It acts only on a link navigation that stays on the same report and revision and changes what
	 * is open. The first load (`enter`, and no `previous` yet), a revision or period change, and the
	 * back and forward buttons, which restore their own scroll, are all left as SvelteKit does them.
	 */
	afterNavigate(({ type }) => {
		const before = previous;
		const after = openState();
		previous = after;
		if (type !== 'link' || !before || !isSameReport(before, after)) {
			return;
		}
		moveFocus(before.opened, after.opened);
	});

	/** Whether two states are the same revision of the same Periode. */
	function isSameReport(a: OpenState, b: OpenState): boolean {
		return a.period === b.period && a.revision === b.revision;
	}

	/**
	 * To the heading of a detail that is newly open, including one opened from another; back to the
	 * "Lihat transaksi" of the row whose detail just closed.
	 */
	function moveFocus(before: OpenState['opened'], after: OpenState['opened']): void {
		if (after && !isSameLine(before, after)) {
			document.getElementById(drilldownHeadingId(after.direction, after.categoryId))?.focus();
			return;
		}
		if (!after && before) {
			document.getElementById(drilldownOpenLinkId(before.direction, before.categoryId))?.focus();
		}
	}

	/** Whether two opened lines are the same category in the same direction. */
	function isSameLine(a: OpenState['opened'], b: OpenState['opened']): boolean {
		return a?.direction === b?.direction && a?.categoryId === b?.categoryId;
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
		drilldown={{ period: data.report.period, revision: data.report.revision, direction: INCOME }}
		detail={data.drilldown}
	/>

	<CategoryTable
		heading={m.reports_categories_expenseHeading()}
		lines={data.report.expense}
		emptyMessage={m.reports_categories_expenseEmpty()}
		drilldown={{ period: data.report.period, revision: data.report.revision, direction: EXPENSE }}
		detail={data.drilldown}
	/>

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
