<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The category `<select>` on the public board, `postPublic_filterCategoryLabel` and all — meant to
	 * sit inside the `<form method="GET">` on `(public)/posts/+page.svelte` so choosing a category
	 * submits the page's own filter form and lands in the query string, per this ticket's decision
	 * that filters live in `?category=…` rather than in a new route.
	 *
	 * The label map is its own small copy rather than an import from
	 * `$lib/components/post/post-form.svelte`: that module is not part of this ticket's `reads:`, and
	 * `post-form.svelte`'s own doc comment already points at
	 * `(app)/profile/notifications/+page.svelte` copying its `KIND_LABEL` as the precedent for a
	 * screen holding its own copy rather than growing a cross-file dependency. The values read from
	 * `m.adminPosts_category_*` are not copied text — they are the same message functions
	 * `post-form.svelte` calls, so the Indonesian and English words exist in `messages/*.json` exactly
	 * once.
	 */
	interface Props {
		/** Every category there is, in the order `POST_CATEGORIES` lists them. */
		readonly categories: readonly string[];
		/** The category currently selected, or `''` for "every category". */
		readonly selected: string;
	}

	let { categories, selected }: Readonly<Props> = $props();

	const uid = $props.id();

	/** The label for one of the five categories. Read from the same functions `post-form.svelte` uses. */
	const CATEGORY_LABEL: Record<string, () => string> = {
		posyandu: m.adminPosts_category_posyandu,
		'kerja-bakti': m.adminPosts_category_kerjaBakti,
		perayaan: m.adminPosts_category_perayaan,
		rapat: m.adminPosts_category_rapat,
		umum: m.adminPosts_category_umum
	};
</script>

<div class="flex flex-1 flex-col gap-1">
	<label class="text-sm font-medium" for="post-public-category-{uid}">
		{m.postPublic_filterCategoryLabel()}
	</label>
	<select
		id="post-public-category-{uid}"
		name="category"
		value={selected}
		class="h-11 rounded-md border border-border bg-background px-3 text-sm"
	>
		<option value="">{m.postPublic_filterAllCategories()}</option>
		{#each categories as category (category)}
			<option value={category}>{CATEGORY_LABEL[category]?.() ?? category}</option>
		{/each}
	</select>
</div>
