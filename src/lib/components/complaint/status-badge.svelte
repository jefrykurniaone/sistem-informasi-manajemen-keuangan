<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';

	/**
	 * One Keluhan's status, as a small badge — the resident-facing screens' equivalent of the label
	 * `worklist-table.svelte` and `status-history.svelte` already render for the admin queue.
	 *
	 * `type ComplaintStatus` is imported for its type only, the same reading `payments/+page.svelte`
	 * already makes of `type PaymentStatus`: everything under `$lib/server/` is server-only, and this
	 * component also runs in the browser, so only the type — erased at build time — crosses that line.
	 *
	 * Its own `complaints_status_*` message keys rather than the admin screens'
	 * `adminComplaints_status_*` ones: message catalogues are add-and-add per ticket, and this ticket
	 * adds its own namespace instead of reaching into one #45 already owns.
	 */
	interface Props {
		readonly status: ComplaintStatus;
	}

	let { status }: Readonly<Props> = $props();

	/** The label for one of the six statuses, exhaustive over `ComplaintStatus`. */
	const STATUS_LABEL: Readonly<Record<ComplaintStatus, () => string>> = {
		new: m.complaints_status_new,
		reviewing: m.complaints_status_reviewing,
		working: m.complaints_status_working,
		resolved: m.complaints_status_resolved,
		rejected: m.complaints_status_rejected,
		withdrawn: m.complaints_status_withdrawn
	};
</script>

<span
	class="inline-flex w-fit items-center rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
>
	{STATUS_LABEL[status]()}
</span>
