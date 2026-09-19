<script lang="ts">
	import UnlockPeriodDialog, {
		type UnlockablePeriod
	} from '$lib/components/cash/unlock-period-dialog.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	/**
	 * Every Periode of the buku kas with its status and the Laporan Bulanan published inside it, and
	 * one action: reopening a locked month. The status is what decides whether a Transaksi Kas dated
	 * inside the month may be recorded at all, so this screen is where an admin finds out why a
	 * recording was refused, and where a superuser puts that right.
	 *
	 * A month that has transactions but no `periods` row yet is on the list, marked as such and open.
	 * That is not a gap in the data: a month's row is created by the first write dated inside it, so
	 * "no row" is a fact about a month nothing has ever locked. Leaving those months off would hide
	 * the ones an admin is most likely to be looking for.
	 *
	 * The unlock button is only drawn for a superuser, and only on a locked month. Drawing it is not
	 * the authorization — `unlockPeriod` refuses an admin whoever posts the form — it only keeps the
	 * screen from offering something the next click would refuse.
	 */

	let { data, form }: PageProps = $props();

	/** When a timestamp is shown, it is shown whole: a publication instant is read against a clock. */
	const PUBLISHED_AT_FORMAT = new Intl.DateTimeFormat('id-ID', {
		dateStyle: 'long',
		timeStyle: 'short'
	});

	/** The month whose unlock dialog is open, or `undefined` when none is. */
	let unlocking: UnlockablePeriod | undefined = $state();
</script>

<svelte:head>
	<title>{m.adminPeriods_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminPeriods_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminPeriods_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-4">
		<h2 class="text-lg font-semibold">{m.adminPeriods_listHeading()}</h2>

		{#each data.periods as summary (summary.period)}
			<article class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h3 class="text-base font-medium">{summary.period}</h3>
					<span class="rounded-md border border-border px-2 py-1 text-xs font-medium">
						{summary.isLocked ? m.adminPeriods_statusLocked() : m.adminPeriods_statusOpen()}
					</span>
				</div>

				<p class="text-sm text-muted-foreground">
					{m.adminPeriods_transactionCount({ count: summary.transactionCount })}
				</p>

				{#if !summary.hasRow}
					<p class="text-sm text-muted-foreground">{m.adminPeriods_notYetCreated()}</p>
				{/if}

				<h4 class="text-sm font-medium">{m.adminPeriods_reportsHeading()}</h4>
				{#if summary.reports.length === 0}
					<p class="text-sm text-muted-foreground">{m.adminPeriods_noReports()}</p>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each summary.reports as report (report.id)}
							<li class="text-sm">
								{m.adminPeriods_reportRevision({
									revision: report.revision,
									date: PUBLISHED_AT_FORMAT.format(report.publishedAt)
								})}
								{#if report.revisionReason !== null}
									<span class="text-muted-foreground">
										{m.adminPeriods_reportRevisionReason({ reason: report.revisionReason })}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if data.mayUnlock && summary.isLocked}
					<Button
						type="button"
						variant="outline"
						class="h-11 min-w-24 self-start"
						onclick={() =>
							(unlocking = {
								year: summary.year,
								month: summary.month,
								period: summary.period
							})}
					>
						{m.adminPeriods_unlockButton()}
					</Button>
				{/if}
			</article>
		{/each}

		{#if data.periods.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminPeriods_empty()}</p>
		{/if}
	</section>
</main>

<UnlockPeriodDialog
	action="?/unlock"
	period={unlocking}
	onClose={() => {
		unlocking = undefined;
	}}
/>
