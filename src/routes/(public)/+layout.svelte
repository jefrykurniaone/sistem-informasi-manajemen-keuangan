<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The shell the announcement board's two public pages sit in — `posts/+page.svelte` and
	 * `posts/[id]/+page.svelte`. It only sets the width and the spacing they'd otherwise both repeat,
	 * the same role `(auth)/+layout.svelte` plays for the sign-in flow; it holds no data of its own,
	 * so unlike that layout it needs no `+layout.server.ts`.
	 *
	 * `max-w-3xl` matches `(app)/admin/posts/+page.svelte`'s own column, so a Post reads at the same
	 * width whether the admin is looking at it or a visitor is. The `(app)` route group has no layout
	 * of its own and repeats this per page instead; this group has two pages that both need it, so it
	 * is written once here.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	{@render children()}
</div>
