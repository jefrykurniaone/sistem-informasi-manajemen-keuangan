<script lang="ts">
	import { resolve } from '$app/paths';
	import { pageTitle } from '$lib/complex-name';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{pageTitle(m.register_pageTitle())}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.register_heading()}</h1>
	<p class="text-sm text-muted-foreground">
		{m.register_intro()}
	</p>
	<p class="text-sm text-muted-foreground">{m.register_reviewNotice()}</p>

	{#if form}
		<p class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
		</p>
	{/if}

	<form method="POST" class="flex flex-col gap-4">
		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="name">{m.register_nameLabel()}</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="name"
				name="name"
				type="text"
				autocomplete="name"
				value={form?.name ?? ''}
				placeholder={m.register_namePlaceholder()}
				required
			/>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="email">{m.register_emailLabel()}</label>
			<input
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				id="email"
				name="email"
				type="email"
				autocomplete="email"
				value={form?.email ?? ''}
				placeholder={m.register_emailPlaceholder()}
				required
			/>
		</div>

		<fieldset class="flex flex-col gap-1.5">
			<legend class="text-sm font-medium">{m.register_claimLegend()}</legend>
			<div class="flex flex-col gap-3 sm:flex-row">
				<div class="flex flex-1 flex-col gap-1.5">
					<label class="text-sm font-medium" for="claimedBlock">{m.register_blockLabel()}</label>
					<input
						class="h-9 rounded-md border border-border bg-background px-3 text-sm"
						id="claimedBlock"
						name="claimedBlock"
						type="text"
						aria-describedby="claim-hint"
						value={form?.claimedBlock ?? ''}
						placeholder={m.register_blockPlaceholder()}
						required
					/>
				</div>
				<div class="flex flex-1 flex-col gap-1.5">
					<label class="text-sm font-medium" for="claimedNumber">{m.register_numberLabel()}</label>
					<input
						class="h-9 rounded-md border border-border bg-background px-3 text-sm"
						id="claimedNumber"
						name="claimedNumber"
						type="text"
						aria-describedby="claim-hint"
						value={form?.claimedNumber ?? ''}
						placeholder={m.register_numberPlaceholder()}
						required
					/>
				</div>
			</div>
			<p class="text-xs text-muted-foreground" id="claim-hint">{m.register_claimHint()}</p>
		</fieldset>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="password">{m.register_passwordLabel()}</label>
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
				{m.register_passwordHint({ min: data.minimumPasswordLength })}
			</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="passwordAgain"
				>{m.register_passwordAgainLabel()}</label
			>
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

		<Button type="submit">{m.register_submit()}</Button>
	</form>

	<p class="text-sm text-muted-foreground">
		{m.register_hasAccountPrompt()}
		<a class="underline underline-offset-4" href={resolve('/login')}>{m.register_loginLink()}</a>
	</p>
</main>
