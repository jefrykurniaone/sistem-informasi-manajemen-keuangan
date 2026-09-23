<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Asking for another email only makes sense while the address is still unverified.
	let canResend = $derived(data.state !== 'verified');
</script>

<svelte:head>
	<title>{pageTitle(m.verify_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">Verifikasi email</h1>

	{#if data.state === 'verified'}
		<p class="rounded-md border border-border px-3 py-2 text-sm">
			Alamat email Anda sudah terverifikasi. Sekarang Anda bisa masuk dengan email dan kata sandi
			Anda.
		</p>
		<Button href={resolve('/login')}>Masuk</Button>
	{:else if data.state === 'sent'}
		<p class="text-sm">
			Kalau alamat yang Anda isi belum terdaftar, email verifikasinya sudah kami kirim ke sana. Buka
			tautan di dalam email itu untuk mengaktifkan akun Anda.
		</p>
	{:else if data.state === 'expired'}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			Tautan verifikasi ini sudah kedaluwarsa. Minta email yang baru di bawah ini.
		</p>
	{:else if data.state === 'invalid'}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			Tautan verifikasi ini tidak bisa dipakai. Biasanya tautannya terpotong saat disalin dari
			email. Minta email yang baru di bawah ini.
		</p>
	{:else}
		<p class="text-sm">
			Akun baru harus diverifikasi lebih dulu lewat tautan yang kami kirim ke alamat emailnya. Belum
			menerima emailnya? Isi alamat email Anda di bawah ini dan kami kirim ulang.
		</p>
	{/if}

	{#if canResend}
		{#if form}
			<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
				{form.message}
			</p>
		{/if}

		<form method="POST" action="?/resend" class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="email">Alamat email</label>
				<input
					class="h-9 rounded-md border border-border bg-background px-3 text-sm"
					id="email"
					name="email"
					type="email"
					autocomplete="email"
					required
				/>
			</div>

			<Button type="submit" variant="outline">Kirim ulang email verifikasi</Button>
		</form>

		<p class="text-sm text-muted-foreground">
			<a class="underline underline-offset-4" href={resolve('/login')}>Kembali ke halaman masuk</a>
		</p>
	{/if}
</main>
