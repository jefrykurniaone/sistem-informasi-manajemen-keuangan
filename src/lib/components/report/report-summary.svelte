<script lang="ts" module>
	import type { Rupiah } from '$lib/money';

	/** The four headline figures of a Laporan Bulanan, as the summary renders them. */
	export interface ReportSummaryFigures {
		readonly openingBalance: Rupiah;
		readonly totalIncome: Rupiah;
		readonly totalExpense: Rupiah;
		readonly closingBalance: Rupiah;
	}

	/** The iuran summary: the spec's two different figures, and the two counts of houses. */
	export interface ReportSummaryDues {
		/** Iuran allocated to this Periode's Tagihan, whenever the money arrived. */
		readonly collected: Rupiah;
		/** Kas masuk in the iuran category dated inside this month. A different number. */
		readonly cashIn: Rupiah;
		readonly unitsPaid: number;
		readonly unitsUnpaid: number;
	}

	/** Which revision this is, or `null` on the admin preview, which is not a publication. */
	export interface ReportSummaryRevision {
		readonly revision: number;
		readonly publishedAt: Date;
		readonly revisionReason: string | null;
		/** False when a newer revision of the same Periode exists. */
		readonly isLatest: boolean;
	}
</script>

<script lang="ts">
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The headline of a Laporan Bulanan: which revision it is, the four cash figures user story 18
	 * asks for, and the iuran summary of user story 19.
	 *
	 * Used by both the report a warga opens and the preview an admin publishes from, which is the
	 * point of it being a component: what an admin looked at before pressing the button is rendered
	 * by the same code as what a warga reads afterwards. The preview passes `revision: null`, and the
	 * revision banner simply is not drawn — a preview has no revision number because it has not been
	 * published.
	 *
	 * **The two iuran figures are always both shown, each with its own sentence.**
	 * `docs/spec-kas-laporan-v1.md` forbids picking one: "iuran terkumpul untuk periode Januari" and
	 * "kas masuk bulan Januari" are different numbers on a cash basis, and a warga who adds the
	 * report up themselves and finds a difference nobody explained is the problem this whole spec
	 * opens with.
	 *
	 * **The tunggakan surface here is two counts.** There is no name and no house number in this
	 * component because there is none in the payload it is handed — see
	 * `src/lib/server/services/report/resident-payload.ts`, which is where that is actually enforced.
	 */
	interface Props {
		readonly period: string;
		readonly figures: ReportSummaryFigures;
		readonly dues: ReportSummaryDues;
		/** The published revision, or null for the admin preview. */
		readonly revision: ReportSummaryRevision | null;
	}

	let { period, figures, dues, revision }: Readonly<Props> = $props();

	/** A publication instant is read against a clock, so it is shown whole. */
	const PUBLISHED_AT_FORMAT = new Intl.DateTimeFormat('id-ID', {
		dateStyle: 'long',
		timeStyle: 'short'
	});

	/** The four cash figures, in the order user story 18 lists them. */
	const cashRows = $derived([
		{ label: m.reports_summary_openingBalance(), amount: figures.openingBalance },
		{ label: m.reports_summary_totalIncome(), amount: figures.totalIncome },
		{ label: m.reports_summary_totalExpense(), amount: figures.totalExpense },
		{ label: m.reports_summary_closingBalance(), amount: figures.closingBalance }
	]);
</script>

<section class="flex flex-col gap-4" aria-label={period}>
	{#if revision}
		<div class="flex flex-col gap-1 rounded-lg border border-border p-4">
			<p class="text-sm font-medium">
				{m.reports_summary_revision({
					revision: revision.revision,
					date: PUBLISHED_AT_FORMAT.format(revision.publishedAt)
				})}
			</p>
			{#if revision.revisionReason !== null}
				<p class="text-sm text-muted-foreground">
					{m.reports_summary_revisionReason({ reason: revision.revisionReason })}
				</p>
			{/if}
			{#if !revision.isLatest}
				<p class="text-sm font-medium" role="status">{m.reports_summary_notLatest()}</p>
			{/if}
		</div>
	{/if}

	<div class="flex flex-col gap-2">
		<h2 class="text-lg font-semibold">{m.reports_summary_figuresHeading()}</h2>
		<dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{#each cashRows as row (row.label)}
				<div class="flex flex-col gap-1 rounded-lg border border-border p-3">
					<dt class="text-sm text-muted-foreground">{row.label}</dt>
					<dd class="text-base font-semibold break-words">{formatRupiah(row.amount)}</dd>
				</div>
			{/each}
		</dl>
	</div>

	<div class="flex flex-col gap-2">
		<h2 class="text-lg font-semibold">{m.reports_summary_duesHeading()}</h2>
		<dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
			<div class="flex flex-col gap-1 rounded-lg border border-border p-3">
				<dt class="text-sm text-muted-foreground">{m.reports_summary_duesCollected()}</dt>
				<dd class="text-base font-semibold break-words">{formatRupiah(dues.collected)}</dd>
				<p class="text-xs text-muted-foreground">{m.reports_summary_duesCollectedHint()}</p>
			</div>
			<div class="flex flex-col gap-1 rounded-lg border border-border p-3">
				<dt class="text-sm text-muted-foreground">{m.reports_summary_duesCashIn()}</dt>
				<dd class="text-base font-semibold break-words">{formatRupiah(dues.cashIn)}</dd>
				<p class="text-xs text-muted-foreground">{m.reports_summary_duesCashInHint()}</p>
			</div>
			<div class="flex flex-col gap-1 rounded-lg border border-border p-3">
				<dt class="text-sm text-muted-foreground">{m.reports_summary_duesUnitsPaid()}</dt>
				<dd class="text-base font-semibold">{dues.unitsPaid}</dd>
			</div>
			<div class="flex flex-col gap-1 rounded-lg border border-border p-3">
				<dt class="text-sm text-muted-foreground">{m.reports_summary_duesUnitsUnpaid()}</dt>
				<dd class="text-base font-semibold">{dues.unitsUnpaid}</dd>
			</div>
		</dl>
		<p class="text-xs text-muted-foreground">{m.reports_summary_duesPrivacy()}</p>
	</div>
</section>
