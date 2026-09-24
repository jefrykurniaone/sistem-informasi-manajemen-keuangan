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
	 * branch, the viewer's display name.** At 390 pixels the row has 343 pixels to give the complex
	 * name link, the viewer's name, the switcher and the Beranda button between them, which is not
	 * enough for all four at their natural size, so the two names share the squeeze rather than one
	 * of them taking all of it:
	 *
	 * - The complex name link is `shrink-0` with `max-w-[35%]` (lifted at `sm:` and up, where the row
	 *   is wide enough that the cap would only clip names it does not need to): it renders at its
	 *   natural width when that is under the cap (the seed name `BCIR` never reaches it) and
	 *   truncates at exactly 35 percent of the row when it is not. It never collapses to nothing,
	 *   because the cap, not the flex shrink algorithm, decides its width.
	 * - The switcher and the Beranda button are each `shrink-0`; a control is either fully visible or
	 *   not shown, never half-clipped.
	 * - The signed-in name span is the only element with a plain `shrink-1` (the default): with
	 *   `min-w-0` it absorbs whatever space is left after the link, the switcher and the button take
	 *   theirs, and truncates there. The wrapping group is `min-w-0` too, so the outer flex layout can
	 *   push it below its own content size instead of the automatic minimum stopping it early.
	 *
	 * The result: the complex name is always shown (truncated past 35 percent of the row), the
	 * viewer's name truncates to whatever is left, and neither ever pushes the page wider than its
	 * own viewport.
	 */
	let { data, children }: LayoutProps = $props();
</script>

<header class="border-b border-border">
	<div class="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
		<a
			href={resolve('/posts')}
			class="max-w-[35%] min-w-0 shrink-0 truncate text-sm font-semibold tracking-tight hover:underline sm:max-w-none"
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
