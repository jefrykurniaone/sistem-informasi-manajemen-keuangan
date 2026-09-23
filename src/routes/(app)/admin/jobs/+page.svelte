<script lang="ts">
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDateTime } from '$lib/time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** How a run's status reads in Indonesian, on this page only — the name in code stays English. */
	const STATUS_LABEL: Record<string, string> = {
		running: 'Sedang berjalan',
		succeeded: 'Berhasil',
		failed: 'Gagal'
	};

	/** Instants are shown in the complex's own zone — `$lib/time`'s `formatDateTime`. */
	function formatInstant(instant: Date): string {
		return formatDateTime(instant);
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminJobs_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">Pekerjaan terjadwal</h1>
		<p class="text-sm text-muted-foreground">
			Setiap pekerjaan berkala beserta eksekusi terakhirnya. Menjalankan sekarang memakai kunci yang
			sama dengan jadwal, jadi periode yang sudah pernah dijalankan akan dilewati, bukan diulang.
		</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<div class="flex flex-col gap-4">
		{#each data.jobs as job (job.name)}
			<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
				<div class="flex flex-col">
					<span class="font-medium">{job.name}</span>
					<span class="text-sm text-muted-foreground">Periode saat ini: {job.currentPeriod}</span>
				</div>

				{#if job.lastRun}
					<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
						<dt class="text-muted-foreground">Periode terakhir</dt>
						<dd>{job.lastRun.period}</dd>
						<dt class="text-muted-foreground">Hasil</dt>
						<dd>{STATUS_LABEL[job.lastRun.status] ?? job.lastRun.status}</dd>
						<dt class="text-muted-foreground">Mulai</dt>
						<dd>{formatInstant(job.lastRun.startedAt)}</dd>
						<dt class="text-muted-foreground">Selesai</dt>
						<dd>
							{job.lastRun.finishedAt ? formatInstant(job.lastRun.finishedAt) : 'Belum selesai'}
						</dd>
						{#if job.lastRun.error}
							<dt class="text-muted-foreground">Pesan galat</dt>
							<dd>{job.lastRun.error}</dd>
						{/if}
					</dl>
				{:else}
					<p class="text-sm text-muted-foreground">Belum pernah dijalankan.</p>
				{/if}

				<form method="POST" action="?/trigger">
					<input type="hidden" name="jobName" value={job.name} />
					<Button type="submit" size="sm">Jalankan sekarang</Button>
				</form>
			</section>
		{/each}

		{#if data.jobs.length === 0}
			<p class="text-sm text-muted-foreground">
				Belum ada pekerjaan terjadwal yang terdaftar. Spec berikutnya mendaftarkan pekerjaannya
				sendiri, dan pekerjaan itu muncul di sini.
			</p>
		{/if}
	</div>
</main>
