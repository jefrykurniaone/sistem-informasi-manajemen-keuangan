<script lang="ts">
	import { resolve } from '$app/paths';
	import LanguageSwitcher from '$lib/components/app-shell/language-switcher.svelte';
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
	 * Since #189, `LanguageSwitcher` sits beside that button in both branches, so a visitor with no
	 * session can also switch the interface language here (the sidebar footer is not reachable
	 * without one). It renders with `hideLabel`, since this header has no room to spare for a
	 * caption the `<select>` itself already makes clear from its selected option.
	 *
	 * `max-w-3xl` matches `(app)/admin/posts/+page.svelte`'s own column, so a Post reads at the same
	 * width whether the admin is looking at it or a visitor is, and the header keeps to that column so
	 * its two ends line up with the text below them.
	 *
	 * **Two things can now be arbitrarily long at once: the complex name and, in the signed-in
	 * branch, the viewer's display name,** and neither may push the row wider than the viewport. The
	 * complex name link is `shrink-0`, so it needs an explicit cap at every breakpoint, not just a
	 * narrow one: `max-w-[35%]` below `sm:`, where the row is tight and the switcher, the Beranda
	 * button and their gaps need most of what is left; `sm:max-w-[50%]` from 640 pixels up, where even
	 * half the row still leaves that group its space. Either way the link renders at its natural width
	 * under the cap and truncates past it, never collapsing to nothing. The switcher and the button
	 * are `shrink-0` too, so a control is either fully visible or not shown. The signed-in name span is
	 * the one element left with a plain, default `shrink` (`min-w-0`, same as its wrapping group), so
	 * it absorbs whatever space the other three leave and truncates there.
	 */
	let { data, children }: LayoutProps = $props();
</script>

<header class="border-b border-border">
	<div class="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
		<a
			href={resolve('/posts')}
			class="max-w-[35%] min-w-0 shrink-0 truncate text-sm font-semibold tracking-tight hover:underline sm:max-w-[50%]"
		>
			{complexName}
		</a>
		{#if data.viewer}
			<div class="flex min-w-0 items-center gap-3">
				<span class="min-w-0 truncate text-sm text-muted-foreground">{data.viewer.name}</span>
				<div class="shrink-0">
					<LanguageSwitcher hideLabel />
				</div>
				<Button href={resolve('/')} variant="outline" class="min-h-11 shrink-0 md:min-h-0">
					{m.appShell_navHome()}
				</Button>
			</div>
		{:else}
			<div class="flex shrink-0 items-center gap-2">
				<LanguageSwitcher hideLabel />
				<Button href={resolve('/login')} class="min-h-11 md:min-h-0">{m.appShell_navLogin()}</Button
				>
			</div>
		{/if}
	</div>
</header>

<!--
	A `<div>`, not a `<main>`. Each page of this group renders its own `<main>` around its content,
	the same per-page convention the `(auth)` pages follow: `posts/+page.svelte`,
	`posts/[id]/+page.svelte` and `unsubscribe/[token]/+page.svelte` each carry one, so a `<main>`
	here would nest a second landmark inside the first.
-->
<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	{@render children()}
</div>
