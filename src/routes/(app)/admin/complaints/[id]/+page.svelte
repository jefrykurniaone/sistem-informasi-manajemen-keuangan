<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import StatusChangeDialog from '$lib/components/complaint/status-change-dialog.svelte';
	import StatusHistory from '$lib/components/complaint/status-history.svelte';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** The label for one of the six statuses. */
	const STATUS_LABEL: Record<ComplaintStatus, () => string> = {
		new: m.adminComplaints_status_new,
		reviewing: m.adminComplaints_status_reviewing,
		working: m.adminComplaints_status_working,
		resolved: m.adminComplaints_status_resolved,
		rejected: m.adminComplaints_status_rejected,
		withdrawn: m.adminComplaints_status_withdrawn
	};
</script>

<svelte:head>
	<title>{pageTitle(data.complaint.title)}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<span class="text-xs text-muted-foreground">
			{STATUS_LABEL[data.complaint.status]?.() ?? data.complaint.status}
			· {data.complaint.category}
		</span>
		<h1 class="text-2xl font-bold tracking-tight">{data.complaint.title}</h1>
		{#if data.complaint.stale}
			<span class="w-fit rounded-md border border-destructive px-2 py-1 text-sm text-destructive">
				{m.adminComplaints_staleBadge()}
			</span>
		{/if}
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
		<p class="text-sm whitespace-pre-line">{data.complaint.description}</p>
		{#if data.complaint.rejectionReason}
			<p class="text-sm text-destructive">
				{m.adminComplaintDetail_rejectionReasonShown({ reason: data.complaint.rejectionReason })}
			</p>
		{/if}
	</section>

	<StatusChangeDialog
		complaintId={data.complaint.id}
		allowedTransitions={data.allowedTransitions}
	/>

	<section class="flex flex-col gap-2">
		<h2 class="font-medium">{m.adminComplaintDetail_historyHeading()}</h2>
		<StatusHistory rows={data.history} />
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.adminComplaintDetail_repliesHeading()}</h2>

		<ul class="flex flex-col gap-2">
			{#each data.replies as reply (reply.id)}
				<li class="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
					<span class="font-medium">{reply.authorName}</span>
					<p>{reply.content}</p>
					<span class="text-xs text-muted-foreground">{reply.createdAtLabel}</span>
				</li>
			{/each}

			{#if data.replies.length === 0}
				<p class="text-sm text-muted-foreground">{m.adminComplaintDetail_repliesEmpty()}</p>
			{/if}
		</ul>

		<form method="POST" action="?/reply" class="flex flex-col gap-2">
			<label class="text-sm font-medium" for="complaint-reply-content-{uid}">
				{m.adminComplaintDetail_replyLabel()}
			</label>
			<textarea
				id="complaint-reply-content-{uid}"
				name="content"
				required
				placeholder={m.adminComplaintDetail_replyPlaceholder()}
				class="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
			<Button type="submit" class="h-11 min-w-24 self-start">
				{m.adminComplaintDetail_replySubmit()}
			</Button>
		</form>
	</section>
</main>
