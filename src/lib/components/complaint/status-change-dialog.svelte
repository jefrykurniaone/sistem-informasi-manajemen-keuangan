<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';

	/**
	 * The one status this dialog treats specially, as the value itself rather than as a type: it
	 * cannot be imported from `$lib/server/db/schema/complaint` here, because that module is
	 * server-only and this component ships to the browser. `'rejected'` is not a guess — it is the
	 * literal `COMPLAINT_STATUS.rejected` already names in that schema.
	 */
	const REJECTED_STATUS: ComplaintStatus = 'rejected';

	/**
	 * The one dialog an admin moves a Keluhan's status through. It offers **only** the statuses
	 * `allowedTransitions` names — computed server-side in `+page.server.ts` from
	 * `complaintTransitionActor`/`isAllowedComplaintTransition` in
	 * `src/lib/server/services/complaint/state-machine.ts` — so the state machine is never
	 * duplicated here: this component has no status list of its own to drift from that table.
	 *
	 * A move to `rejected` asks for a reason and will not submit without one — the client-side half
	 * of story 16's "alasan wajib"; `changeComplaintStatus` refuses an empty one all the same, so a
	 * request built outside this dialog is refused too.
	 */
	interface Props {
		readonly complaintId: string;
		readonly allowedTransitions: readonly ComplaintStatus[];
	}

	let { complaintId, allowedTransitions }: Readonly<Props> = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let selected: ComplaintStatus | '' = $state('');

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

	function open(): void {
		selected = allowedTransitions[0] ?? '';
		dialog?.showModal();
	}
</script>

{#if allowedTransitions.length > 0}
	<Button type="button" class="h-11 min-w-24" onclick={open}>
		{m.adminComplaintDetail_changeStatusButton()}
	</Button>

	<dialog bind:this={dialog} class="w-full max-w-sm rounded-lg border border-border p-4">
		<form method="POST" action="?/changeStatus" class="flex flex-col gap-3">
			<input type="hidden" name="complaintId" value={complaintId} />

			<div class="flex flex-col gap-1">
				<label class="text-sm font-medium" for="complaint-status-to-{uid}">
					{m.adminComplaintDetail_newStatusLabel()}
				</label>
				<select
					id="complaint-status-to-{uid}"
					name="to"
					bind:value={selected}
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					{#each allowedTransitions as status (status)}
						<option value={status}>{STATUS_LABEL[status]?.() ?? status}</option>
					{/each}
				</select>
			</div>

			{#if selected === REJECTED_STATUS}
				<div class="flex flex-col gap-1">
					<label class="text-sm font-medium" for="complaint-rejection-reason-{uid}">
						{m.adminComplaintDetail_rejectionReasonLabel()}
					</label>
					<textarea
						id="complaint-rejection-reason-{uid}"
						name="rejectionReason"
						required
						placeholder={m.adminComplaintDetail_rejectionReasonPlaceholder()}
						class="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
					></textarea>
				</div>
			{/if}

			<div class="flex flex-col gap-1">
				<label class="text-sm font-medium" for="complaint-status-note-{uid}">
					{m.adminComplaintDetail_noteLabel()}
				</label>
				<textarea
					id="complaint-status-note-{uid}"
					name="note"
					placeholder={m.adminComplaintDetail_notePlaceholder()}
					class="min-h-16 rounded-md border border-border bg-background px-3 py-2 text-sm"
				></textarea>
			</div>

			<div class="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					class="h-11 min-w-24"
					onclick={() => dialog?.close()}
				>
					{m.adminComplaintDetail_cancelButton()}
				</Button>
				<Button type="submit" class="h-11 min-w-24">
					{m.adminComplaintDetail_confirmButton()}
				</Button>
			</div>
		</form>
	</dialog>
{/if}
