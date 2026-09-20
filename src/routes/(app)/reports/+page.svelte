<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDateTime } from '$lib/time';
	import type { PageProps } from './$types';

	/**
	 * The list of published Laporan Bulanan. One row per Periode, carrying its newest revision, so
	 * the answer to "which figures apply now" is the row itself rather than something a reader has
	 * to work out from four of them.
	 *
	 * `resolve` is called directly at each `href={…}` for `eslint-plugin-svelte`'s
	 * `no-navigation-without-resolve` to see it, exactly as the admin list screens do.
	 */

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.reports_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.reports_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.reports_description()}</p>
	</header>

	<section class="flex flex-col gap-4">
		<h2 class="text-lg font-semibold">{m.reports_listHeading()}</h2>

		{#each data.reports as report (report.id)}
			<article class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<h3 class="text-base font-medium">{report.period}</h3>
				<p class="text-sm text-muted-foreground">
					{m.reports_revisionLabel({ revision: report.revision })} ·
					{m.reports_publishedAt({ date: formatDateTime(report.publishedAt) })}
				</p>
				{#if report.revisionReason !== null}
					<p class="text-sm text-muted-foreground">
						{m.reports_revisionReason({ reason: report.revisionReason })}
					</p>
				{/if}
				<a
					class="inline-flex min-h-11 items-center self-start underline underline-offset-4"
					href={resolve(`/reports/${report.period}`)}
				>
					{m.reports_openLink({ period: report.period })}
				</a>
			</article>
		{/each}

		{#if data.reports.length === 0}
			<p class="text-sm text-muted-foreground">{m.reports_empty()}</p>
		{/if}
	</section>
</main>
