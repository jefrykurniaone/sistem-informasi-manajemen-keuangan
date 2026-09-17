<script lang="ts">
	import type { Snippet } from 'svelte';

	// The shell every page of the sign-in flow sits in: one narrow column that is comfortable at
	// 390 pixels and does not stretch on a laptop. The route segments are English because a route
	// directory is a file name; every word below is Indonesian because a resident reads it.
	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-h-svh flex-col items-center justify-center px-4 py-10">
	<div class="flex w-full max-w-sm flex-col gap-6">
		<header class="flex flex-col gap-1">
			<p class="text-xs font-medium tracking-widest text-muted-foreground uppercase">Komplek</p>
			<p class="text-sm text-muted-foreground">Sistem Informasi dan Manajemen Keuangan Komplek</p>
		</header>

		{@render children()}
	</div>
</div>
