<script lang="ts">
	import '../app.css';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { AppSidebar } from '$lib/components/app-shell/index.js';
	import type { LayoutProps } from './$types';

	// The app shell every route sits inside: a sidebar on the left carrying the role-aware menu, and
	// a thin header over the page holding the control that collapses it. `(auth)/+layout.svelte` and
	// `(public)/+layout.svelte` nest their own narrow columns inside this `<main>`, exactly as they
	// did under the old header navigation; that division is unchanged here.
	let { data, children }: LayoutProps = $props();

	/**
	 * Turns off the sidebar's own `Ctrl+B` / `Cmd+B` shortcut, which collides with bold in the Post
	 * editor (spec `post-editor`).
	 *
	 * `Sidebar.Provider` listens on `window` and exposes no way to switch that off, and
	 * `src/lib/components/ui/sidebar/` is generated code this ticket does not edit. Listening one
	 * node lower, on `document`, is what makes this work: a keydown bubbles through `document`
	 * before it ever reaches `window`, so stopping it here reaches the sidebar's listener and
	 * nothing else. Every handler on the element itself has already run, and the browser's own bold
	 * is left alone because nothing here calls `preventDefault`.
	 */
	function suppressSidebarShortcut(event: KeyboardEvent): void {
		if (event.key === 'b' && (event.ctrlKey || event.metaKey)) {
			event.stopPropagation();
		}
	}
</script>

<svelte:document onkeydown={suppressSidebarShortcut} />

<Sidebar.Provider open={data.sidebarOpen}>
	<AppSidebar signedIn={data.signedIn} menu={data.menu} />
	<Sidebar.Inset>
		<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
			<Sidebar.Trigger
				aria-label={m.appShell_toggleSidebar()}
				class="size-11 md:size-8"
				title={m.appShell_toggleSidebar()}
			/>
			<span class="text-sm font-semibold tracking-tight">{m.appShell_brand()}</span>
		</header>
		{@render children()}
	</Sidebar.Inset>
</Sidebar.Provider>
