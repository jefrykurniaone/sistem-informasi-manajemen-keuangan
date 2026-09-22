<script lang="ts">
	import BrandPanel from '$lib/components/auth/brand-panel.svelte';
	import type { LayoutProps } from './$types';

	/**
	 * The frame every page of the sign-in flow sits in: masuk, daftar, lupa kata sandi, setel kata
	 * sandi, verifikasi and undangan. The route segments are English because a route directory is a
	 * file name; every word a resident reads comes from the message catalogue or the pages themselves.
	 *
	 * **Two columns from 768 pixels up, one below.** `md:grid-cols-[9fr_11fr]` gives the brand panel
	 * 45 percent of the width and the form the rest, with the form centred vertically in its column.
	 * Below `md` the panel collapses into a strip above the form (`brand-panel.svelte` decides its own
	 * two shapes), and the form fills the width inside a 16 pixel gutter (`px-4`) up to `max-w-sm`.
	 * Both grid items carry `min-w-0`, so a long complex name truncates instead of widening the page
	 * past 390 pixels.
	 *
	 * **Submit buttons are at least 44 pixels tall below `md`.** The pages render the shared `Button`
	 * at its default 36 pixels, and a thumb needs 44. The rule is set here, once, as a descendant
	 * selector on the form column, rather than in six forms: the same `min-h-11 md:min-h-0` pair the
	 * `(public)` header uses, applied to every `button[type=submit]` in the group.
	 *
	 * A `<div>`, not a `<main>`: each page of this group renders its own `<main>`.
	 */
	let { children }: LayoutProps = $props();
</script>

<div class="grid min-h-svh grid-rows-[auto_1fr] md:grid-cols-[9fr_11fr] md:grid-rows-1">
	<BrandPanel />

	<div
		class="flex min-w-0 items-center justify-center px-4 py-10 md:px-10 [&_button[type=submit]]:min-h-11 md:[&_button[type=submit]]:min-h-0"
	>
		<div class="w-full max-w-sm">
			{@render children()}
		</div>
	</div>
</div>
