<script lang="ts">
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	// Every string on this page, dates and periods included, is made in `+page.server.ts` in the
	// active language; this component only lays it out.
	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{pageTitle(m.adminJobs_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminJobs_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminJobs_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm break-words" role="status">
			{form.message}
		</p>
	{/if}

	<div class="flex flex-col gap-4">
		{#each data.jobs as job (job.name)}
			<section
				class="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4"
				aria-labelledby="job-{job.name}"
			>
				<div class="flex min-w-0 flex-col gap-1">
					<h2 id="job-{job.name}" class="font-medium">{job.title}</h2>
					<code class="text-xs break-all text-muted-foreground">{job.name}</code>
					{#if job.purpose}
						<p class="text-sm text-muted-foreground">{job.purpose}</p>
					{/if}
				</div>

				<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
					<dt class="text-muted-foreground">{m.adminJobs_currentPeriodLabel()}</dt>
					<dd>{job.currentPeriod}</dd>
					{#if job.lastRun}
						<dt class="text-muted-foreground">{m.adminJobs_lastRunPeriodLabel()}</dt>
						<dd>{job.lastRun.period}</dd>
						<dt class="text-muted-foreground">{m.adminJobs_resultLabel()}</dt>
						<dd>{job.lastRun.status}</dd>
						<dt class="text-muted-foreground">{m.adminJobs_startedLabel()}</dt>
						<dd>{job.lastRun.startedAt}</dd>
						<dt class="text-muted-foreground">{m.adminJobs_finishedLabel()}</dt>
						<dd>{job.lastRun.finishedAt}</dd>
						{#if job.lastRun.error}
							<dt class="text-muted-foreground">{m.adminJobs_errorLabel()}</dt>
							<dd class="break-words">{job.lastRun.error}</dd>
						{/if}
					{/if}
				</dl>

				{#if !job.lastRun}
					<p class="text-sm text-muted-foreground">{m.adminJobs_neverRun()}</p>
				{/if}

				{#if job.failure}
					<p class="rounded-md border border-border px-3 py-2 text-sm">
						{job.failure.count}
						{job.failure.nextAttempt}
					</p>
				{/if}

				<form method="POST" action="?/trigger">
					<input type="hidden" name="jobName" value={job.name} />
					<Button type="submit" size="sm">{m.adminJobs_runNow()}</Button>
				</form>
			</section>
		{/each}

		{#if data.jobs.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminJobs_empty()}</p>
		{/if}
	</div>
</main>
