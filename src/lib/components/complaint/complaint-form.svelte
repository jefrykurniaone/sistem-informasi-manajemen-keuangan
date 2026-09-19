<script lang="ts" module>
	/** What the "lapor keluhan" form carries, and what it is repopulated with after a `fail()`. */
	export interface ComplaintFormValues {
		readonly title: string;
		readonly category: string;
		readonly description: string;
		/** Whether the "tampilkan ke semua warga" box is ticked. */
		readonly makePublic: boolean;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import AttachmentUpload from './attachment-upload.svelte';

	/**
	 * The whole "lapor keluhan" form — title, category, description, the visibility choice, and the
	 * attachment field — user stories 1 through 3 of `docs/spec-keluhan-v1.md`.
	 *
	 * Unlike `dues/payment.ts`'s screen, which has no `payment-form.svelte` of its own, this ticket's
	 * `writes:` names `complaint-form.svelte` directly, so the whole `<form>` — method, encoding,
	 * action and submit button included — lives here rather than in `+page.svelte`. `+page.svelte`
	 * renders the page's header and any submitted-form message, then this component, and nothing else.
	 *
	 * `enctype="multipart/form-data"` is required for the attachment field to post any bytes at all;
	 * without it a browser posts only the file names.
	 *
	 * **`action="?/create"` is required.** `+page.server.ts` exports only a named action, `create`,
	 * with no `default`; a `<form>` with no `action` posts to the page itself, which SvelteKit answers
	 * with a 404 because no action matches. `reply-thread.svelte`'s `action="?/reply"` and
	 * `[id]/+page.svelte`'s `action="?/withdraw"` already carry this the same way — this form is the
	 * one that was missing it.
	 */
	interface Props {
		/** What to show in each field — the values just posted, when this is a `fail()` re-render. */
		readonly values: ComplaintFormValues;
		readonly acceptedAttachmentTypes: readonly string[];
		readonly maximumAttachmentBytes: number;
		readonly maxAttachments: number;
	}

	let { values, acceptedAttachmentTypes, maximumAttachmentBytes, maxAttachments }: Readonly<Props> =
		$props();

	const uid = $props.id();
</script>

<form method="POST" action="?/create" enctype="multipart/form-data" class="flex flex-col gap-4">
	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="complaint-title-{uid}">
			{m.complaintsNew_titleLabel()}
		</label>
		<input
			id="complaint-title-{uid}"
			name="title"
			type="text"
			required
			value={values.title}
			class="min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
		/>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="complaint-category-{uid}">
			{m.complaintsNew_categoryLabel()}
		</label>
		<input
			id="complaint-category-{uid}"
			name="category"
			type="text"
			required
			value={values.category}
			aria-describedby="complaint-category-hint-{uid}"
			class="min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
		/>
		<p id="complaint-category-hint-{uid}" class="text-sm text-muted-foreground">
			{m.complaintsNew_categoryHint()}
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="complaint-description-{uid}">
			{m.complaintsNew_descriptionLabel()}
		</label>
		<textarea
			id="complaint-description-{uid}"
			name="description"
			required
			value={values.description}
			class="min-h-32 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
		></textarea>
	</div>

	<div class="flex items-start gap-2">
		<input
			id="complaint-makePublic-{uid}"
			name="makePublic"
			type="checkbox"
			value="1"
			checked={values.makePublic}
			class="mt-1 h-5 w-5 rounded border-border"
		/>
		<label class="flex flex-col gap-1 text-sm" for="complaint-makePublic-{uid}">
			<span class="font-medium">{m.complaintsNew_visibilityLabel()}</span>
			<span class="text-muted-foreground">{m.complaintsNew_visibilityHint()}</span>
		</label>
	</div>

	<AttachmentUpload
		name="attachments"
		acceptedTypes={acceptedAttachmentTypes}
		maximumBytes={maximumAttachmentBytes}
		maxCount={maxAttachments}
	/>

	<Button type="submit" class="h-11 min-w-32 self-start">
		{m.complaintsNew_submitButton()}
	</Button>
</form>
