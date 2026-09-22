<script lang="ts">
	import '../app.css';
	import type { LayoutProps } from './$types';

	// Deliberately thin: the global stylesheet (and the Inter font it imports) and nothing else. The
	// interface language is already on `<html lang>` by the time this renders, set by
	// `src/hooks.server.ts`. Each route group brings its own frame: `(app)/+layout.svelte` the
	// sidebar shell, `(public)/+layout.svelte` a light header, `(auth)/+layout.svelte` one narrow
	// column. A sidebar here would put a menu on the sign-in page of someone who has no menu yet.
	let { children }: LayoutProps = $props();
</script>

{@render children()}
