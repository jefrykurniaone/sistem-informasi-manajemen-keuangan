<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let name = $derived(form?.name ?? data.profile?.name ?? '');
	let phone = $derived(form?.phone ?? data.profile?.phone ?? '');
</script>

<svelte:head>
	<title>{m.profile_pageTitle()} — Komplek</title>
</svelte:head>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.profile_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.profile_subheading()}</p>
	</header>

	{#if !data.profile}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.profile_noRecordTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.profile_noRecordBody()}</p>
		</section>
	{:else}
		{#if form?.message}
			<p
				class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
				role="alert"
			>
				{form.message}
			</p>
		{:else if form?.saved}
			<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
				{m.profile_savedMessage()}
			</p>
		{/if}

		<form method="POST" class="flex flex-col gap-4">
			<input type="hidden" name="residentId" value={data.profile.residentId} />

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="name">{m.profile_nameLabel()}</label>
				<input
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
					id="name"
					name="name"
					type="text"
					autocomplete="name"
					value={name}
					required
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="phone">{m.profile_phoneLabel()}</label>
				<input
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
					id="phone"
					name="phone"
					type="tel"
					autocomplete="tel"
					value={phone}
					aria-describedby="phone-hint"
				/>
				<p class="text-xs text-muted-foreground" id="phone-hint">{m.profile_phoneHint()}</p>
			</div>

			<Button type="submit" class="h-11">{m.profile_saveButton()}</Button>
		</form>

		<a class="text-sm underline underline-offset-4" href={resolve('/profile/notifications')}>
			{m.profile_notificationsLink()}
		</a>
	{/if}
</main>
