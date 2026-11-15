<script lang="ts">
	import { AppShell } from '#lib/components/app-shell/index.js';
	import type { LayoutProps } from './$types';

	// Every page of the application sits inside the app shell (`AppShell`): a sidebar with the
	// role-aware menu, a header holding the control that collapses it, and the complex's name. It
	// lives in this group, not in the root layout, so the sign-in pages carry no sidebar, no collapse
	// control and no menu (#170); the announcement board uses the same component for a signed-in
	// viewer in `(public)/posts/+layout.svelte` (#319). The menu and the remembered width come from
	// this group's `+layout.server.ts`; `viewer` comes from the root one.
	let { data, children }: LayoutProps = $props();
</script>

<AppShell sidebarOpen={data.sidebarOpen} menu={data.menu} signedIn={data.viewer !== null}>
	{@render children()}
</AppShell>
