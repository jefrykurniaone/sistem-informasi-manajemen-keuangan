<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{pageTitle(m.login_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">Masuk</h1>

	{#if data.passwordChanged}
		<p class="rounded-md border border-border px-3 py-2 text-sm">
			Kata sandi Anda sudah diganti. Silakan masuk dengan kata sandi yang baru.
		</p>
	{/if}

	{#if form}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
			{#if form.unverified}
				<a class="underline underline-offset-4" href={resolve('/verify')}>
					Kirim ulang email verifikasinya
				</a>.
			{/if}
		</p>
	{/if}

	<form method="POST" class="flex flex-col gap-4">
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
				autocomplete="current-password"
				required
			/>
		</div>

		<Button type="submit">Masuk</Button>
	</form>

	<p class="text-sm text-muted-foreground">
		<a class="underline underline-offset-4" href={resolve('/forgot-password')}>Lupa kata sandi?</a>
		&middot;
		<a class="underline underline-offset-4" href={resolve('/register')}>Daftar akun baru</a>
	</p>
</main>
