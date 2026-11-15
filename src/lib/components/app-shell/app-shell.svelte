<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { complexName } from '#lib/complex-name.ts';
	import AppSidebar from './app-sidebar.svelte';
	import type { MenuGroup } from './menu.js';

	/**
	 * The app shell: a sidebar on the left carrying the role-aware menu, and a thin header over the
	 * page holding the control that collapses it and the complex's name.
	 *
	 * Two layouts render it, `src/routes/(app)/+layout.svelte` for every page of the application and
	 * `src/routes/(public)/posts/+layout.svelte` for the announcement board and a Post when the
	 * viewer is signed in and let in (#319), so the two are one component and cannot drift. The sign-in
	 * pages, the unsubscribe page and the board for everyone else carry no sidebar, no collapse control
	 * and no menu (#170). The menu and the remembered width come from `src/lib/server/app-shell.ts`
	 * through each layout's `+layout.server.ts`.
	 *
	 * `Sidebar.Inset` is a `<div>`, not a `<main>`: each page renders its own `<main>`, so a shell
	 * around it adds no second landmark.
	 */
	interface Props {
		readonly sidebarOpen: boolean;
		/** The visible menu, already filtered by permission on the server. */
		readonly menu: readonly MenuGroup[];
		readonly signedIn: boolean;
		readonly children: Snippet;
	}

	let { sidebarOpen, menu, signedIn, children }: Props = $props();

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
	 * so the listener lives with the shell.
	 */
	function suppressSidebarShortcut(event: KeyboardEvent): void {
		if (event.key === 'b' && (event.ctrlKey || event.metaKey)) {
			event.stopPropagation();
		}
	}
</script>

<svelte:document onkeydown={suppressSidebarShortcut} />

<Sidebar.Provider open={sidebarOpen}>
	<AppSidebar {signedIn} {menu} />
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
