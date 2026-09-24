<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<!--
	A `<div>`, not a `<main>`. Each `(app)` page renders its own `<main>` around its content, the same
	per-page convention the `(public)` layout follows, so a `<main>` here would nest a second landmark
	inside the first, violating `landmark-no-duplicate-main`.
-->
<div
	bind:this={ref}
	data-slot="sidebar-inset"
	class={cn(
		'relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
