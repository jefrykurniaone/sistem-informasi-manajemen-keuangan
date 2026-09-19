<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { InvoiceStatus } from '$lib/server/services/dues/queries';

	/**
	 * One Tagihan's computed status, read either way: `warga` sees `paid`, `partial`, `unpaid` or
	 * `overdue` on their own list, and admin's unit history additionally sees `void`. The status
	 * itself is decided once, in `$lib/server/services/dues/queries.ts`'s `invoiceStatus` — this
	 * component only ever renders the answer.
	 */
	interface Props {
		readonly status: InvoiceStatus;
	}

	let { status }: Readonly<Props> = $props();

	/** The label for one of the five statuses `invoiceStatus` can answer. */
	const STATUS_LABEL: Record<InvoiceStatus, () => string> = {
		paid: m.invoiceStatus_paid,
		partial: m.invoiceStatus_partial,
		unpaid: m.invoiceStatus_unpaid,
		overdue: m.invoiceStatus_overdue,
		void: m.invoiceStatus_void
	};
</script>

<span
	class="rounded-md border px-2 py-1 text-xs font-medium {status === 'overdue'
		? 'border-destructive text-destructive'
		: 'border-border text-muted-foreground'}"
>
	{STATUS_LABEL[status]()}
</span>
