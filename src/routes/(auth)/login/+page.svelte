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
	<h1 class="text-2xl font-bold tracking-tight">{m.login_heading()}</h1>

	{#if data.passwordChanged}
		<p class="rounded-md border border-border px-3 py-2 text-sm">
			{m.login_passwordChangedNotice()}
		</p>
	{/if}

	{#if form}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
			{#if form.unverified}
				<a class="underline underline-offset-4" href={resolve('/verify')}>
					{m.login_resendVerificationLink()}
				</a>.
			{/if}
		</p>
	{/if}

	<form method="POST" class="flex flex-col gap-4">
		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="email">{m.login_emailLabel()}</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="email"
				name="email"
				type="email"
				autocomplete="email"
				value={form?.email ?? ''}
				placeholder={m.login_emailPlaceholder()}
				required
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="password">{m.login_passwordLabel()}</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="password"
				name="password"
				type="password"
				autocomplete="current-password"
				required
			/>
		</div>

		<Button type="submit">{m.login_submit()}</Button>
	</form>

	<p class="text-sm text-muted-foreground">
		<a class="underline underline-offset-4" href={resolve('/forgot-password')}
			>{m.login_forgotPasswordLink()}</a
		>
		&middot;
		<a class="underline underline-offset-4" href={resolve('/register')}>{m.login_registerLink()}</a>
	</p>
</main>
