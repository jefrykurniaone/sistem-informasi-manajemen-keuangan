<script lang="ts">
	import { complexName } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import BrandIllustration from './brand-illustration.svelte';

	/**
	 * Who this installation belongs to, shown beside every page of the sign-in flow
	 * (`src/routes/(auth)/+layout.svelte`): the complex name from `PUBLIC_COMPLEX_NAME` and one
	 * sentence saying what the application is for.
	 *
	 * **One element, two shapes.** From 768 pixels up it is the left column of the two-column layout,
	 * with the name at the top, the illustration in the middle and the sentence at the bottom. Below
	 * 768 pixels it is a thin strip above the form holding only the name and the sentence: the drawing
	 * is `hidden` there, because on a phone it would push the form below the fold for no information.
	 *
	 * An `<aside>`, not a `<header>` or a `<main>`: each `(auth)` page renders its own `<main>`, and
	 * this panel is complementary to it rather than part of it.
	 */
</script>

<aside
	class="flex min-w-0 flex-col gap-1 border-b border-border bg-muted px-4 py-3 md:justify-between md:gap-8 md:border-r md:border-b-0 md:p-10"
>
	<p class="truncate text-sm font-semibold tracking-tight md:text-lg">{complexName}</p>

	<div class="hidden flex-1 items-center justify-center md:flex">
		<BrandIllustration />
	</div>

	<p
		class="text-sm text-muted-foreground md:text-xl md:font-medium md:text-balance md:text-foreground"
	>
		{m.auth_tagline()}
	</p>
</aside>
