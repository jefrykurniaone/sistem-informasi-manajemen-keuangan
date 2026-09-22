<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { complexName } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { LayoutProps } from './$types';

	/**
	 * The frame the pages anyone may open without an account sit in: the announcement board
	 * (`posts/+page.svelte`, `posts/[id]/+page.svelte`) and the unsubscribe confirmation.
	 *
	 * **A light header, not the app shell.** A visitor here has no menu to open, so since #170 there
	 * is no sidebar and no collapse control, only the complex's name on the left and one way onward
	 * on the right: "Masuk" for a visitor with no session, or their name and a link back to Beranda
	 * for a resident who followed a shared link while signed in. `viewer` comes from the root
	 * `+layout.server.ts`, which carries the display name and nothing else, so this group still needs
	 * no `+layout.server.ts` of its own.
	 *
	 * The two words reuse the sidebar's `appShell_navLogin` and `appShell_navHome`: the same
	 * destination under the same name wherever it is offered.
	 *
	 * `max-w-3xl` matches `(app)/admin/posts/+page.svelte`'s own column, so a Post reads at the same
	 * width whether the admin is looking at it or a visitor is, and the header keeps to that column so
	 * its two ends line up with the text below them. Both ends truncate rather than wrap, so a long
	 * complex name or display name never pushes the page wider than 390 pixels.
	 */
	let { data, children }: LayoutProps = $props();
</script>

<header class="border-b border-border">
	<div class="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
		<a
			href={resolve('/posts')}
			class="min-w-0 truncate text-sm font-semibold tracking-tight hover:underline"
		>
			{complexName}
		</a>
		{#if data.viewer}
			<div class="flex min-w-0 items-center gap-3">
				<span class="min-w-0 truncate text-sm text-muted-foreground">{data.viewer.name}</span>
				<Button href={resolve('/')} variant="outline" class="min-h-11 md:min-h-0">
					{m.appShell_navHome()}
				</Button>
			</div>
		{:else}
			<Button href={resolve('/login')} class="min-h-11 md:min-h-0">{m.appShell_navLogin()}</Button>
		{/if}
	</div>
</header>

<!-- A `<div>`, not a `<main>`: `unsubscribe/[token]/+page.svelte` already renders its own. -->
<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	{@render children()}
</div>
