<script lang="ts" module>
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The label a person reads for a Post's type, status and category.
	 *
	 * These live here, in a module script, rather than being copied into each screen the way
	 * `(app)/profile/notifications/+page.svelte` copies its `KIND_LABEL`: this ticket's three screens
	 * and its preview component all need the same three maps, and four copies of the same five rows
	 * is four places to forget a category. The stored value stays exactly what
	 * `$lib/server/services/post` and `$lib/server/db/schema/post` name it — only the sentence
	 * changes here.
	 */
	export const POST_TYPE_LABEL: Record<string, () => string> = {
		event: m.adminPosts_type_event,
		announcement: m.adminPosts_type_announcement
	};

	/** The label for one of the three statuses. */
	export const POST_STATUS_LABEL: Record<string, () => string> = {
		draft: m.adminPosts_status_draft,
		published: m.adminPosts_status_published,
		archived: m.adminPosts_status_archived
	};

	/** The label for one of the five categories. */
	export const POST_CATEGORY_LABEL: Record<string, () => string> = {
		posyandu: m.adminPosts_category_posyandu,
		'kerja-bakti': m.adminPosts_category_kerjaBakti,
		perayaan: m.adminPosts_category_perayaan,
		rapat: m.adminPosts_category_rapat,
		umum: m.adminPosts_category_umum
	};

	/**
	 * What the write form holds, as the strings a form really carries.
	 *
	 * Every field is a string, including the two instants: a `datetime-local` input reads and writes
	 * `YYYY-MM-DDTHH:mm`, and turning that into a `Date` is the server's job, next to the code that
	 * knows which zone it means.
	 */
	export interface PostFormValues {
		readonly type: string;
		readonly title: string;
		readonly summary: string;
		readonly bodyHtml: string;
		readonly category: string;
		readonly startsAt: string;
		readonly endsAt: string;
		readonly location: string;
	}

	/**
	 * The `type` value that means a kegiatan, as `$lib/server/db/schema/post` stores it.
	 *
	 * Written out rather than imported: everything under `src/lib/server/` is server-only and
	 * SvelteKit refuses to pull it into a component. `tests/unit/post-service.test.ts` walks the same
	 * values from the schema itself, so a rename there fails there rather than silently here.
	 */
	const EVENT_TYPE = 'event';

	/** An empty form, for the "write a new post" screen. */
	export const EMPTY_POST_FORM_VALUES: PostFormValues = {
		type: EVENT_TYPE,
		title: '',
		summary: '',
		bodyHtml: '',
		category: 'umum',
		startsAt: '',
		endsAt: '',
		location: ''
	};
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * The write form for a Post, shared by `(app)/admin/posts/new` and `(app)/admin/posts/[id]`. It
	 * holds no logic of its own beyond showing and hiding the three fields only a kegiatan has: the
	 * rules about which type may carry which field are enforced in
	 * `$lib/server/services/post`, and this form hiding them is a convenience, never the check.
	 *
	 * It posts to whichever action the screen around it names, so the same component serves "save a
	 * draft" and "save changes".
	 */
	interface Props {
		/** The action this form posts to, e.g. `?/create`. */
		readonly action: string;
		/** What the fields start out holding. */
		readonly values: PostFormValues;
		/** Every category the service accepts, in the order it lists them. */
		readonly categories: readonly string[];
		/** Every type there is. */
		readonly types: readonly string[];
		/** The label on the submit button. */
		readonly submitLabel: string;
	}

	let { action, values, categories, types, submitLabel }: Readonly<Props> = $props();

	const uid = $props.id();

	/**
	 * Which type the person has picked since this form was rendered, or `undefined` while they have
	 * picked nothing and the stored value still stands.
	 *
	 * Kept separately from `values.type` rather than seeded from it: a `$state` seeded from a prop
	 * captures that prop's first value and then stops following it, so a rejected submission — which
	 * hands back new `values` — would show the old type with the new fields.
	 */
	let chosenType: string | undefined = $state();

	/** The type the three kegiatan-only fields follow. */
	const type = $derived(chosenType ?? values.type);

	const isEvent = $derived(type === EVENT_TYPE);
</script>

<form method="POST" {action} class="flex flex-col gap-5">
	{#key uid}
		<!--
			#119: `uid` never changes, so this `{#key}` never tears the field down — it exists purely to
			give the `Tipe` `<select>` its own compiled `template_effect`.

			Without it, Svelte 5 folds every top-level attribute update in this template into one
			`template_effect` per block, and that effect re-runs in full whenever any signal it reads
			changes. `value={type}` below reads `type`, which is `$derived` from `chosenType`, so
			picking a different `Tipe` reran the *whole* effect — including the unrelated
			`$.set_value(input, $$props.values.title)` for `Judul` a few lines down, writing the
			untouched, still-empty `values.title` prop back over whatever the person had typed. `Judul`
			is `required`, so the browser then held back `Simpan draf` and no Post was ever created
			through that path. Confirmed by comparing the compiled output (`svelte/compiler`, `generate:
			'client'`) before and after this block: before, `$.set_value(input, $$props.values.title)`
			sat inside the same `template_effect` as the `<select>`'s `value={type}` write; after,
			`type` is read only inside this `{#key}` block's own effect, and the form-level effect that
			writes `Judul`, `Ringkasan`, `Kategori`, `Isi` no longer reads `type` or `chosenType` at all.

			`values.title` (and `values.category`, `values.startsAt`, `values.endsAt`,
			`values.location`) still get written back on every render, unconditionally — that part is
			untouched by this `{#key}`, and it has to stay: see the comment on `chosenType` above.
			Neither `(app)/admin/posts/new/+page.svelte` nor `(app)/admin/posts/[id]/+page.svelte` uses
			`use:enhance`, so this form posts natively and a rejected submission is a full document
			render with the action's `values` handed back as fresh props. A `$state` seeded from a prop
			captures that prop's first value and stops following it, so seeding these fields from
			`values` the same way `chosenType` is kept separate from `values.type` would freeze them at
			whatever `values` held on the very first render, and a rejected submission's returned
			`values` would never reach the DOM.
		-->
		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="post-form-type-{uid}">
				{m.adminPosts_form_typeLabel()}
			</label>
			<select
				id="post-form-type-{uid}"
				name="type"
				value={type}
				onchange={(event) => (chosenType = event.currentTarget.value)}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			>
				{#each types as option (option)}
					<option value={option}>{POST_TYPE_LABEL[option]?.() ?? option}</option>
				{/each}
			</select>
		</div>
	{/key}

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="post-form-title-{uid}">
			{m.adminPosts_form_titleLabel()}
		</label>
		<input
			id="post-form-title-{uid}"
			name="title"
			type="text"
			required
			value={values.title}
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		/>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="post-form-summary-{uid}">
			{m.adminPosts_form_summaryLabel()}
		</label>
		<textarea
			id="post-form-summary-{uid}"
			name="summary"
			rows="2"
			required
			aria-describedby="post-form-summary-hint-{uid}"
			class="rounded-md border border-border bg-background px-3 py-2 text-sm"
			>{values.summary}</textarea
		>
		<p class="text-xs text-muted-foreground" id="post-form-summary-hint-{uid}">
			{m.adminPosts_form_summaryHint()}
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="post-form-category-{uid}">
			{m.adminPosts_form_categoryLabel()}
		</label>
		<select
			id="post-form-category-{uid}"
			name="category"
			value={values.category}
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		>
			{#each categories as option (option)}
				<option value={option}>{POST_CATEGORY_LABEL[option]?.() ?? option}</option>
			{/each}
		</select>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="post-form-body-{uid}">
			{m.adminPosts_form_bodyLabel()}
		</label>
		<textarea
			id="post-form-body-{uid}"
			name="bodyHtml"
			rows="12"
			required
			aria-describedby="post-form-body-hint-{uid}"
			class="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
			>{values.bodyHtml}</textarea
		>
		<p class="text-xs text-muted-foreground" id="post-form-body-hint-{uid}">
			{m.adminPosts_form_bodyHint()}
		</p>
	</div>

	{#if isEvent}
		<fieldset class="flex flex-col gap-4 rounded-lg border border-border p-4">
			<legend class="px-1 text-sm font-medium">{m.adminPosts_form_eventHeading()}</legend>
			<p class="text-xs text-muted-foreground">{m.adminPosts_form_eventHint()}</p>

			<div class="flex flex-col gap-4 sm:flex-row">
				<div class="flex flex-1 flex-col gap-1.5">
					<label class="text-sm font-medium" for="post-form-starts-at-{uid}">
						{m.adminPosts_form_startsAtLabel()}
					</label>
					<input
						id="post-form-starts-at-{uid}"
						name="startsAt"
						type="datetime-local"
						value={values.startsAt}
						class="h-11 rounded-md border border-border bg-background px-3 text-sm"
					/>
				</div>
				<div class="flex flex-1 flex-col gap-1.5">
					<label class="text-sm font-medium" for="post-form-ends-at-{uid}">
						{m.adminPosts_form_endsAtLabel()}
					</label>
					<input
						id="post-form-ends-at-{uid}"
						name="endsAt"
						type="datetime-local"
						value={values.endsAt}
						class="h-11 rounded-md border border-border bg-background px-3 text-sm"
					/>
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="post-form-location-{uid}">
					{m.adminPosts_form_locationLabel()}
				</label>
				<input
					id="post-form-location-{uid}"
					name="location"
					type="text"
					value={values.location}
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>
		</fieldset>
	{/if}

	<Button type="submit" class="h-11 w-full sm:w-auto sm:self-start">{submitLabel}</Button>
</form>
