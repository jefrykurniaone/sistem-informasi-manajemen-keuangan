<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * What the page says right now: the POST's answer once there is one, otherwise the GET's.
	 * `done` only ever comes from the POST — a GET never changes anything, see `+page.server.ts`.
	 */
	const status = $derived(form?.status ?? data.status);
</script>

<svelte:head>
	<title>{m.unsubscribe_pageTitle()}</title>
</svelte:head>

<main class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.unsubscribe_heading()}</h1>

	{#if status === 'done'}
		<p class="text-sm" role="status">{m.unsubscribe_done()}</p>
	{:else if status === 'invalid'}
		<p class="text-sm" role="alert">{m.unsubscribe_invalid()}</p>
	{:else if status === 'mandatory'}
		<p class="text-sm" role="alert">{m.unsubscribe_mandatory()}</p>
	{:else}
		<p class="text-sm">{m.unsubscribe_intro()}</p>

		<!--
			The action is named, so the address has to name it too: a form posting to a page that has
			only named actions and no `default` answers 404 with no gate anywhere catching it.
		-->
		<form method="POST" action="?/unsubscribe">
			<Button class="h-11 w-full sm:w-auto" type="submit">{m.unsubscribe_submit()}</Button>
		</form>
	{/if}

	<!--
		`min-h-11` with `inline-flex items-center` rather than the bare text link this started as: a
		44 px tap target is the rule, and an anchor styled as text is 20 px tall however long its
		label is. `self-start` keeps it from stretching across the column the way a flex child
		otherwise would.
	-->
	<a
		class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
		href={resolve('/')}
	>
		{m.unsubscribe_homeLink()}
	</a>
</main>
