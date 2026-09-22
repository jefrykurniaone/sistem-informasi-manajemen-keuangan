<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { AppSidebar } from '$lib/components/app-shell/index.js';
	import { complexName } from '$lib/complex-name';
	import type { LayoutProps } from './$types';

	// The app shell every page of the application sits inside: a sidebar on the left carrying the
	// role-aware menu, and a thin header over the page holding the control that collapses it and the
	// complex's name. It lives in this group, not in the root layout, so the sign-in pages and the
	// public announcement board carry no sidebar, no collapse control and no menu (#170). The menu
	// and the remembered width come from this group's `+layout.server.ts`; `viewer` comes from the
	// root one.
	let { data, children }: LayoutProps = $props();

	/**
	 * Turns off the sidebar's own `Ctrl+B` / `Cmd+B` shortcut, which collides with bold in the Post
	 * editor (spec `post-editor`).
	 *
	 * `Sidebar.Provider` listens on `window` and exposes no way to switch that off, and
	 * `src/lib/components/ui/sidebar/` is generated code this repository does not edit. Listening one
	 * node lower, on `document`, is what makes this work: a keydown bubbles through `document`
	 * before it ever reaches `window`, so stopping it here reaches the sidebar's listener and
	 * nothing else. Every handler on the element itself has already run, and the browser's own bold
	 * is left alone because nothing here calls `preventDefault`. The Post editor is an `(app)` page,
	 * so the listener moved here with the shell.
	 */
	function suppressSidebarShortcut(event: KeyboardEvent): void {
		if (event.key === 'b' && (event.ctrlKey || event.metaKey)) {
			event.stopPropagation();
		}
	}
</script>

<svelte:document onkeydown={suppressSidebarShortcut} />

<Sidebar.Provider open={data.sidebarOpen}>
	<AppSidebar signedIn={data.viewer !== null} menu={data.menu} />
	<Sidebar.Inset>
		<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
			<Sidebar.Trigger
				aria-label={m.appShell_toggleSidebar()}
				class="size-11 md:size-8"
				title={m.appShell_toggleSidebar()}
			/>
			<span class="min-w-0 truncate text-sm font-semibold tracking-tight">{complexName}</span>
		</header>
		{@render children()}
	</Sidebar.Inset>
</Sidebar.Provider>
