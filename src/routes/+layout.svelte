<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';
	import { LanguageSwitcher, Navigation } from '$lib/components/app-shell/index.js';
	import type { LayoutProps } from './$types';

	// The app shell every route sits inside: a header carrying the role-aware navigation and the
	// language switcher, and a main area the route fills. `(auth)/+layout.svelte` nests its own
	// narrow centered column inside this `<main>` for the sign-in flow; it is a separate file and
	// is not touched here.
	let { data, children }: LayoutProps = $props();
</script>

<div class="flex min-h-svh flex-col">
	<header class="border-b border-border">
		<div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
			<a class="text-sm font-semibold tracking-tight" href={resolve('/')}>
				{m.appShell_brand()}
			</a>
			<Navigation signedIn={data.signedIn} canManageRoles={data.canManageRoles} />
			<div class="ml-auto">
				<LanguageSwitcher />
			</div>
		</div>
	</header>
	<main class="flex-1">
		{@render children()}
	</main>
</div>
