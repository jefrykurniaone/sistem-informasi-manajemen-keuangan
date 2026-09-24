<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{pageTitle(m.setPassword_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.setPassword_heading()}</h1>

	{#if form}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
		</p>
	{/if}

	{#if data.token === ''}
		<p class="text-sm">
			{m.setPassword_noTokenIntro()}
			<a class="underline underline-offset-4" href={resolve('/forgot-password')}>
				{m.setPassword_forgotPasswordLinkText()}
			</a>.
		</p>
	{:else}
		<p class="text-sm text-muted-foreground">
			{m.setPassword_sessionsRevokedNotice()}
		</p>

		<form method="POST" class="flex flex-col gap-4">
			<input name="token" type="hidden" value={data.token} />

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="password">{m.setPassword_passwordLabel()}</label>
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
					{m.setPassword_passwordHint({ min: data.minimumPasswordLength })}
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="passwordAgain">
					{m.setPassword_passwordAgainLabel()}
				</label>
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

			<Button type="submit">{m.setPassword_submit()}</Button>
		</form>
	{/if}
</main>
