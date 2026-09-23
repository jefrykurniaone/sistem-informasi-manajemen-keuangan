<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** The refusal each dead-token state renders. The `valid` case renders the form instead. */
	function refusalFor(status: 'unknown' | 'used' | 'expired'): string {
		if (status === 'used') {
			return m.invitationAccept_used();
		}
		return status === 'expired' ? m.invitationAccept_expired() : m.invitationAccept_unknown();
	}
</script>

<svelte:head>
	<title>{pageTitle(m.invitationAccept_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.invitationAccept_heading()}</h1>

	{#if form}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
		</p>
	{/if}

	{#if data.inspection.status !== 'valid'}
		<p class="text-sm">{refusalFor(data.inspection.status)}</p>
		<a class="text-sm underline underline-offset-4" href={resolve('/login')}>
			{m.invitationAccept_goToLogin()}
		</a>
	{:else}
		<div class="flex flex-col gap-1">
			<p class="text-sm">{m.invitationAccept_intro({ email: data.inspection.email })}</p>
			<p class="text-sm text-muted-foreground">
				{m.invitationAccept_unitInfo({
					block: data.inspection.block,
					number: data.inspection.number
				})}
			</p>
		</div>

		<form method="POST" class="flex flex-col gap-4">
			<input name="token" type="hidden" value={data.token} />

			{#if data.inspection.requiresName}
				<div class="flex flex-col gap-1.5">
					<label class="text-sm font-medium" for="name">{m.invitationAccept_nameLabel()}</label>
					<input
						class="h-9 rounded-md border border-border bg-background px-3 text-sm"
						id="name"
						name="name"
						type="text"
						autocomplete="name"
						placeholder={m.register_namePlaceholder()}
						required
					/>
				</div>
			{:else}
				<!-- The account already has its name from the resident register; the service keeps it. -->
				<input name="name" type="hidden" value="-" />
			{/if}

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="password"
					>{m.invitationAccept_passwordLabel()}</label
				>
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
					{m.invitationAccept_passwordHint({ min: data.minimumPasswordLength })}
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="passwordAgain">
					{m.invitationAccept_passwordAgainLabel()}
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

			<Button type="submit">{m.invitationAccept_submit()}</Button>
		</form>
	{/if}
</main>
