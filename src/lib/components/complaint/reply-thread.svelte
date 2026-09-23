<script lang="ts" module>
	/** One reply this component renders — already formatted by the server load. */
	export interface ReplyThreadRow {
		readonly id: string;
		readonly authorName: string;
		readonly content: string;
		readonly createdAtLabel: string;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The Tanggapan thread on a resident's own Keluhan detail screen — stories 6 and 7 — reading
	 * `addComplaintReply` and `listComplaintReplies` from `src/lib/server/services/complaint/reply.ts`
	 * (#45's contract; this component neither calls nor re-derives it, only renders what the page's
	 * `load` already fetched with them).
	 *
	 * Bundles the list and the compose box in one component, unlike the admin detail screen's own copy
	 * of this UI: `docs/spec-keluhan-v1.md`'s "warga dapat membaca daftar keluhan yang ditandai umum,
	 * tanpa bisa mengubah apa pun" means a neighbour reading somebody else's `public` Keluhan gets the
	 * thread with no compose box at all, which `canReply` decides once here rather than at every call
	 * site that would otherwise have to remember to hide the form.
	 */
	interface Props {
		readonly rows: readonly ReplyThreadRow[];
		/** Whether to render the compose box at all — `true` only for the complaint's own reporter. */
		readonly canReply: boolean;
	}

	let { rows, canReply }: Readonly<Props> = $props();

	const uid = $props.id();
</script>

<section class="flex flex-col gap-3">
	<h2 class="font-medium">{m.complaintDetail_repliesHeading()}</h2>

	<ul class="flex flex-col gap-2">
		{#each rows as row (row.id)}
			<li class="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
				<span class="font-medium">{row.authorName}</span>
				<p>{row.content}</p>
				<span class="text-xs text-muted-foreground">{row.createdAtLabel}</span>
			</li>
		{/each}

		{#if rows.length === 0}
			<p class="text-sm text-muted-foreground">{m.complaintDetail_repliesEmpty()}</p>
		{/if}
	</ul>

	{#if canReply}
		<form method="POST" action="?/reply" class="flex flex-col gap-2">
			<label class="text-sm font-medium" for="complaint-reply-content-{uid}">
				{m.complaintDetail_replyLabel()}
			</label>
			<textarea
				id="complaint-reply-content-{uid}"
				name="content"
				required
				placeholder={m.complaintDetail_replyPlaceholder()}
				class="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
			<Button type="submit" class="h-11 min-w-24 self-start">
				{m.complaintDetail_replySubmit()}
			</Button>
		</form>
	{/if}
</section>
