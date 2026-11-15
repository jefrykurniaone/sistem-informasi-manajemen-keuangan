<script lang="ts">
	import { AppShell } from '#lib/components/app-shell/index.js';
	import type { LayoutProps } from './$types';

	/**
	 * The announcement board and a Post, inside the app shell for a signed-in viewer who is let in
	 * and with the light header of `(public)/+layout.svelte` for everyone else (#319, spec
	 * `papan-pengumuman-v1`).
	 *
	 * `data.shell` comes from `+layout.server.ts`, which decides with the same rule the `(app)` group
	 * uses (`#lib/server/app-shell.ts`). When it is `null` this layout renders the page as it is and
	 * the parent layout draws the light header and the column around it; when it is set, the parent
	 * draws nothing, and this layout draws the shell and the same `max-w-3xl` column, so a Post reads
	 * at the same width in both shapes.
	 *
	 * Exactly one `<main>` either way: `Sidebar.Inset` is a `<div>`, and each page renders its own
	 * `<main>` (#187). The "Pengumuman" item lights up through `app-sidebar.svelte`'s prefix match,
	 * for `/posts` and every `/posts/<id>`.
	 */
	let { data, children }: LayoutProps = $props();
</script>

{#if data.shell}
	<AppShell sidebarOpen={data.shell.sidebarOpen} menu={data.shell.menu} signedIn={true}>
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
			{@render children()}
		</div>
	</AppShell>
{:else}
	{@render children()}
{/if}
