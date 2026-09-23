<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>{pageTitle(m.forgotPassword_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">Lupa kata sandi</h1>
	<p class="text-sm text-muted-foreground">
		Isi alamat email akun Anda. Kami kirim satu tautan untuk memilih kata sandi baru.
	</p>

	{#if form}
		{#if form.sent}
			<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
		{:else}
			<p
				class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
				role="alert"
			>
				{form.message}
			</p>
		{/if}
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
				placeholder={m.forgotPassword_emailPlaceholder()}
				required
			/>
		</div>

		<Button type="submit">Kirim tautan</Button>
	</form>

	<p class="text-sm text-muted-foreground">
		<a class="underline underline-offset-4" href={resolve('/login')}>Kembali ke halaman masuk</a>
	</p>
</main>
