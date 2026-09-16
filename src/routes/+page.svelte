<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';

	const rangka = [
		'SvelteKit di atas Bun, mode runes Svelte 5',
		'Tailwind CSS v4 lewat plugin Vite',
		'shadcn-svelte, komponen disalin ke dalam repositori',
		'Vitest untuk pengujian unit, Playwright untuk pengujian ujung ke ujung',
		'Docker Compose: aplikasi, PostgreSQL, dan Mailpit'
	];

	let terbuka = $state(false);
</script>

<svelte:head>
	<title>Sistem Informasi dan Manajemen Keuangan Komplek</title>
	<meta name="description" content="Rangka aplikasi untuk satu komplek perumahan." />
</svelte:head>

<div class="mx-auto flex min-h-svh max-w-2xl flex-col gap-8 px-4 py-12">
	<header class="flex flex-col gap-3">
		<p class="text-sm font-medium tracking-widest text-muted-foreground uppercase">Komplek</p>
		<h1 class="text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
			Sistem Informasi dan Manajemen Keuangan Komplek
		</h1>
		<p class="text-base text-muted-foreground">
			Rangka aplikasi sudah hidup di mesin lokal. Belum ada satu pun fitur.
		</p>
	</header>

	<main class="flex flex-col items-start gap-4">
		<Button
			variant="default"
			aria-expanded={terbuka}
			aria-controls="isi-rangka"
			onclick={() => (terbuka = !terbuka)}
		>
			{terbuka ? 'Sembunyikan isi rangka' : 'Lihat isi rangka'}
		</Button>

		{#if terbuka}
			<ul id="isi-rangka" class="w-full rounded-lg border border-border">
				{#each rangka as baris (baris)}
					<li class="border-b border-border px-4 py-3 text-sm last:border-b-0">{baris}</li>
				{/each}
			</ul>
		{/if}
	</main>
</div>
