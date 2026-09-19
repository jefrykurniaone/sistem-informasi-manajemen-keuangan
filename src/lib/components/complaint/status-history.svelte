<script lang="ts" module>
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';

	/** One transition this component renders — already formatted by the server load. */
	export interface StatusHistoryRow {
		readonly id: string;
		readonly oldStatus: ComplaintStatus;
		readonly newStatus: ComplaintStatus;
		readonly actorName: string;
		readonly occurredAtLabel: string;
		readonly note: string | null;
	}
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The full Riwayat Status of one Keluhan — story 19's "siapa mengubah status apa dan kapan" —
	 * oldest first, exactly the order `complaintStatusHistory` in
	 * `src/lib/server/services/complaint/history.ts` already returns them in.
	 */
	interface Props {
		readonly rows: readonly StatusHistoryRow[];
	}

	let { rows }: Readonly<Props> = $props();

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

<ol class="flex flex-col gap-3">
	{#each rows as row (row.id)}
		<li class="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
			<span class="font-medium">
				{m.adminComplaintDetail_historyTransition({
					from: STATUS_LABEL[row.oldStatus]?.() ?? row.oldStatus,
					to: STATUS_LABEL[row.newStatus]?.() ?? row.newStatus
				})}
			</span>
			<span class="text-muted-foreground">
				{m.adminComplaintDetail_historyActorAndTime({
					actor: row.actorName,
					time: row.occurredAtLabel
				})}
			</span>
			{#if row.note}
				<p>{row.note}</p>
			{/if}
		</li>
	{/each}

	{#if rows.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminComplaintDetail_historyEmpty()}</p>
	{/if}
</ol>
