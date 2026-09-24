<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Asking for another email only makes sense while the address is still unverified. `used` means
	// the address is verified too, just not by this visit, so it is excluded the same way.
	let canResend = $derived(data.state !== 'verified' && data.state !== 'used');
</script>

<svelte:head>
	<title>{pageTitle(m.verify_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.verify_heading()}</h1>

	{#if data.state === 'verified'}
		<p class="rounded-md border border-border px-3 py-2 text-sm">
			{m.verify_verifiedBody()}
		</p>
		<Button href={resolve('/login')}>{m.verify_loginButton()}</Button>
	{:else if data.state === 'used'}
		<p class="rounded-md border border-border px-3 py-2 text-sm">
			{m.verify_usedBody()}
		</p>
		<Button href={resolve('/login')}>{m.verify_loginButton()}</Button>
	{:else if data.state === 'sent'}
		<p class="text-sm">
			{m.verify_sentBody()}
		</p>
	{:else if data.state === 'expired'}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{m.verify_expiredBody()}
		</p>
	{:else if data.state === 'invalid'}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{m.verify_invalidBody()}
		</p>
	{:else}
		<p class="text-sm">
			{m.verify_idleBody()}
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
				<label class="text-sm font-medium" for="email">{m.verify_emailLabel()}</label>
				<input
					class="h-9 rounded-md border border-border bg-background px-3 text-sm"
					id="email"
					name="email"
					type="email"
					autocomplete="email"
					placeholder={m.verify_emailPlaceholder()}
					required
				/>
			</div>

			<Button type="submit" variant="outline">{m.verify_resendSubmit()}</Button>
		</form>

		<p class="text-sm text-muted-foreground">
			<a class="underline underline-offset-4" href={resolve('/login')}
				>{m.verify_backToLoginLink()}</a
			>
		</p>
	{/if}
</main>
