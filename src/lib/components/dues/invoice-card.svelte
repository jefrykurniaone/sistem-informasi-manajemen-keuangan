<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { formatRupiah, type Rupiah } from '$lib/money';
	import type { InvoiceStatus } from '$lib/server/services/dues/queries';
	import InvoiceStatusBadge from './invoice-status-badge.svelte';

	/**
	 * One Tagihan on a warga's own list — `(app)/invoices/+page.svelte`'s per-Periode card. Also
	 * reused, with `showUnit`, on admin's `/admin/overdue/[unitId]` history, where every row belongs
	 * to the same house so the block and number are shown once in the page heading instead.
	 */
	interface Props {
		readonly period: string;
		readonly block: string;
		readonly number: string;
		readonly amount: Rupiah;
		readonly remainingAmount: Rupiah;
		readonly dueDate: string;
		readonly status: InvoiceStatus;
		/** Shows which house this row belongs to — a warga who has occupied more than one. */
		readonly showUnit?: boolean;
	}

	let {
		period,
		block,
		number,
		amount,
		remainingAmount,
		dueDate,
		status,
		showUnit = false
	}: Readonly<Props> = $props();

	/** Whether there is still money owed on this Tagihan worth showing a separate figure for. */
	const owesSomething = $derived(status !== 'paid' && status !== 'void');
</script>

<article class="flex min-h-11 flex-col gap-2 rounded-lg border border-border p-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="font-medium">{m.duesInvoiceCard_periodHeading({ period })}</h2>
		<InvoiceStatusBadge {status} />
	</div>

	{#if showUnit}
		<p class="text-sm text-muted-foreground">
			{m.duesInvoiceCard_unitLabel({ block, number })}
		</p>
	{/if}

	<dl class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
		<div class="flex flex-col gap-0.5">
			<dt class="text-muted-foreground">{m.duesInvoiceCard_amountLabel()}</dt>
			<dd class="font-medium">{formatRupiah(amount)}</dd>
		</div>
		{#if owesSomething}
			<div class="flex flex-col gap-0.5">
				<dt class="text-muted-foreground">{m.duesInvoiceCard_remainingLabel()}</dt>
				<dd class="font-medium">{formatRupiah(remainingAmount)}</dd>
			</div>
		{/if}
		<div class="flex flex-col gap-0.5">
			<dt class="text-muted-foreground">{m.duesInvoiceCard_dueDateLabel()}</dt>
			<dd class="font-medium">{dueDate}</dd>
		</div>
	</dl>
</article>
