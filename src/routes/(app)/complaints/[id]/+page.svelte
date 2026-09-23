<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import ReplyThread from '$lib/components/complaint/reply-thread.svelte';
	import StatusBadge from '$lib/components/complaint/status-badge.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * The label for one of the six statuses, for the Riwayat Status entries below — the same labels
	 * `StatusBadge` renders, spelled out again here because a history row needs the bare sentence
	 * ("Baru → Ditinjau"), not a badge.
	 */
	const STATUS_LABEL: Readonly<Record<ComplaintStatus, () => string>> = {
		new: m.complaints_status_new,
		reviewing: m.complaints_status_reviewing,
		working: m.complaints_status_working,
		resolved: m.complaints_status_resolved,
		rejected: m.complaints_status_rejected,
		withdrawn: m.complaints_status_withdrawn
	};
</script>

<svelte:head>
	<title>{pageTitle(data.complaint.title)}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<a
		class="flex h-11 items-center text-sm underline underline-offset-4"
		href={resolve('/complaints')}
	>
		{m.complaints_heading()}
	</a>

	<header class="flex flex-col gap-2">
		<div class="flex flex-wrap items-center gap-2">
			<StatusBadge status={data.complaint.status} />
			<span class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
				{data.complaint.category}
			</span>
		</div>
		<h1 class="text-2xl font-bold tracking-tight">{data.complaint.title}</h1>
	</header>

	{#if data.justCreated}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
			{m.complaintDetail_createdMessage()}
		</p>
	{/if}

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
		<p class="text-sm whitespace-pre-line">{data.complaint.description}</p>
		{#if data.complaint.rejectionReason}
			<p class="text-sm text-destructive">
				{m.complaintDetail_rejectionReasonShown({ reason: data.complaint.rejectionReason })}
			</p>
		{/if}
	</section>

	{#if data.attachments.length > 0}
		<section class="flex flex-col gap-2">
			<h2 class="font-medium">{m.complaintDetail_attachmentsHeading()}</h2>
			<ul class="flex flex-wrap gap-3">
				{#each data.attachments as attachment, index (attachment.id)}
					<li>
						<!--
							`rel="external"` rather than `resolve()`: this href is a signed link the `FileStore`
							port minted, `/files/<key>?expires=…&signature=…`, served by a file endpoint rather
							than a SvelteKit page — the same reading `payments/+page.svelte` already makes of its
							own proof link.
						-->
						<a
							href={attachment.url}
							target="_blank"
							rel="external noopener"
							class="flex h-11 items-center rounded-md border border-border px-3 text-sm underline underline-offset-4"
						>
							{m.complaintDetail_attachmentLinkLabel({ number: index + 1 })}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.complaint.canWithdraw}
		<form method="POST" action="?/withdraw">
			<Button type="submit" variant="outline" class="h-11">
				{m.complaintDetail_withdrawButton()}
			</Button>
		</form>
	{/if}

	<section class="flex flex-col gap-2">
		<h2 class="font-medium">{m.complaintDetail_historyHeading()}</h2>
		<ol class="flex flex-col gap-3">
			{#each data.history as row (row.id)}
				<li class="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
					<span class="font-medium">
						{m.complaintDetail_historyTransition({
							from: STATUS_LABEL[row.oldStatus](),
							to: STATUS_LABEL[row.newStatus]()
						})}
					</span>
					<span class="text-muted-foreground">
						{m.complaintDetail_historyActorAndTime({
							actor: row.actorName,
							time: row.occurredAtLabel
						})}
					</span>
					{#if row.note}
						<p>{row.note}</p>
					{/if}
				</li>
			{/each}
			{#if data.history.length === 0}
				<p class="text-sm text-muted-foreground">{m.complaintDetail_historyEmpty()}</p>
			{/if}
		</ol>
	</section>

	<ReplyThread rows={data.replies} canReply={data.complaint.isOwner} />
</main>
