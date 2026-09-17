<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Daftar — Komplek</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">Daftar</h1>
	<p class="text-sm text-muted-foreground">
		Setelah mendaftar, kami mengirim satu email verifikasi. Akun baru bisa dipakai setelah tautan di
		dalam email itu Anda buka.
	</p>

	{#if form}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
		</p>
	{/if}

	<form method="POST" class="flex flex-col gap-4">
		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="name">Nama</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="name"
				name="name"
				type="text"
				autocomplete="name"
				value={form?.name ?? ''}
				required
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="email">Alamat email</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="email"
				name="email"
				type="email"
				autocomplete="email"
				value={form?.email ?? ''}
				required
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="password">Kata sandi</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="password"
				name="password"
				type="password"
				autocomplete="new-password"
				minlength={data.minimumPasswordLength}
				aria-describedby="password-hint"
				required
			/>
			<p class="text-xs text-muted-foreground" id="password-hint">
				Sedikitnya {data.minimumPasswordLength} karakter. Kalimat pendek yang mudah Anda ingat lebih aman
				daripada satu kata dengan angka di belakangnya.
			</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="passwordAgain">Ulangi kata sandi</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="passwordAgain"
				name="passwordAgain"
				type="password"
				autocomplete="new-password"
				minlength={data.minimumPasswordLength}
				required
			/>
		</div>

		<Button type="submit">Daftar</Button>
	</form>

	<p class="text-sm text-muted-foreground">
		Sudah punya akun?
		<a class="underline underline-offset-4" href={resolve('/login')}>Masuk</a>
	</p>
</main>
