<script lang="ts">
	import { resolve } from '$app/paths';
	import RefundDialog from '$lib/components/dues/refund-dialog.svelte';
	import ReleaseAllocationDialog, {
		type ReleasableAllocation
	} from '$lib/components/dues/release-allocation-dialog.svelte';
	import VoidInvoiceDialog, {
		type VoidableInvoice
	} from '$lib/components/dues/void-invoice-dialog.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatRupiah } from '$lib/money';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDateTime } from '$lib/time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** The Tagihan a cancellation is being written for, or nothing while that dialog is closed. */
	let voiding = $state<VoidableInvoice | undefined>(undefined);

	/** The Alokasi a release is being written for, or nothing while that dialog is closed. */
	let releasing = $state<ReleasableAllocation | undefined>(undefined);

	/** Whether the refund dialog is open. It names no row — the Unit comes from the route. */
	let refunding = $state(false);

	/** The heading sentence for one history entry, by which of the three actions it records. */
	const HISTORY_LABELS: Record<(typeof data.history)[number]['action'], () => string> = {
		invoice_voided: m.unitFinance_actionVoided,
		allocation_released: m.unitFinance_actionReleased,
		credit_refunded: m.unitFinance_actionRefunded
	};

	/**
	 * A standing Tagihan's label from its allocated sum against its amount — lunas, sebagian, or
	 * belum lunas. Deliberately not `invoiceStatus` from `queries.ts`: menunggak needs "today" in
	 * the complex's zone, and this screen is about correcting money, not about chasing it.
	 */
	function allocationLabel(invoice: (typeof data.finance.invoices)[number]): string {
		if (invoice.allocatedAmount >= invoice.amount) {
			return m.unitFinance_statusPaid();
		}
		return invoice.allocatedAmount > 0
			? m.unitFinance_statusPartial()
			: m.unitFinance_statusUnpaid();
	}
</script>

<svelte:head>
	<title>
		{pageTitle(m.unitFinance_heading({ block: data.finance.block, number: data.finance.number }))}
	</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<a
		class="inline-flex min-h-11 items-center text-sm text-muted-foreground underline underline-offset-2"
		href={resolve(`/admin/units/${data.finance.unitId}`)}
	>
		{m.unitFinance_back()}
	</a>

	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">
			{m.unitFinance_heading({ block: data.finance.block, number: data.finance.number })}
		</h1>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="font-medium">{m.unitFinance_creditBalanceLabel()}</h2>
		<p class="text-2xl font-bold">{formatRupiah(data.finance.creditBalance)}</p>
		<p class="text-sm text-muted-foreground">{m.unitFinance_creditBalanceNote()}</p>
		<div>
			<Button
				type="button"
				class="h-11"
				onclick={() => {
					refunding = true;
				}}
			>
				{m.unitFinance_refundButton()}
			</Button>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.unitFinance_invoicesHeading()}</h2>

		{#if data.finance.invoices.length === 0}
			<p class="text-sm text-muted-foreground">{m.unitFinance_invoicesEmpty()}</p>
		{:else}
			<ul class="flex flex-col gap-3">
				{#each data.finance.invoices as invoice (invoice.invoiceId)}
					<li class="flex flex-col gap-2 rounded-lg border border-border p-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div class="flex flex-col gap-0.5">
								<p class="font-medium">
									{m.unitFinance_invoiceLine({
										period: invoice.period,
										amount: formatRupiah(invoice.amount)
									})}
								</p>
								<p class="text-sm text-muted-foreground">
									{m.unitFinance_invoiceDue({ date: invoice.dueDate })}
									·
									{invoice.voidedAt !== null
										? m.unitFinance_statusVoid()
										: allocationLabel(invoice)}
								</p>
							</div>
							{#if invoice.voidedAt === null}
								<Button
									type="button"
									variant="outline"
									class="h-11"
									onclick={() => {
										voiding = {
											id: invoice.invoiceId,
											period: invoice.period,
											amount: formatRupiah(invoice.amount)
										};
									}}
								>
									{m.unitFinance_voidButton()}
								</Button>
							{/if}
						</div>

						{#if invoice.voidReason !== null}
							<p class="text-sm text-muted-foreground">
								{m.unitFinance_voidedNote({ reason: invoice.voidReason })}
							</p>
						{/if}

						<div class="flex flex-col gap-1.5">
							<h3 class="text-sm font-medium">{m.unitFinance_allocationsLabel()}</h3>
							{#if invoice.allocations.length === 0}
								<p class="text-sm text-muted-foreground">{m.unitFinance_allocationsEmpty()}</p>
							{:else}
								<ul class="flex flex-col gap-1.5">
									{#each invoice.allocations as allocation (allocation.allocationId)}
										<li class="flex flex-wrap items-center justify-between gap-2 text-sm">
											<span>
												{m.unitFinance_allocationLine({
													amount: formatRupiah(allocation.amount),
													paymentId: allocation.paymentId
												})}
											</span>
											<Button
												type="button"
												variant="outline"
												class="h-11"
												onclick={() => {
													releasing = {
														id: allocation.allocationId,
														paymentId: allocation.paymentId,
														period: invoice.period,
														amount: formatRupiah(allocation.amount)
													};
												}}
											>
												{m.unitFinance_releaseButton()}
											</Button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.unitFinance_historyHeading()}</h2>

		{#if data.history.length === 0}
			<p class="text-sm text-muted-foreground">{m.unitFinance_historyEmpty()}</p>
		{:else}
			<ul class="flex flex-col gap-3">
				{#each data.history as entry (entry.id)}
					<li class="flex flex-col gap-1 rounded-lg border border-border p-4 text-sm">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span class="font-medium">{HISTORY_LABELS[entry.action]()}</span>
							<span class="text-muted-foreground">
								{formatDateTime(entry.occurredAt)}
							</span>
						</div>
						<p class="text-muted-foreground">
							{#if entry.amount !== null}
								{formatRupiah(entry.amount)}
								·
							{/if}
							{#if entry.period !== null}
								{m.unitFinance_historyPeriod({ period: entry.period })}
								·
							{/if}
							{m.unitFinance_historyBy({ name: entry.actorName })}
						</p>
						<p>{m.unitFinance_historyReason({ reason: entry.reason })}</p>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>

<VoidInvoiceDialog
	action="?/void"
	invoice={voiding}
	onClose={() => {
		voiding = undefined;
	}}
/>

<ReleaseAllocationDialog
	action="?/release"
	allocation={releasing}
	onClose={() => {
		releasing = undefined;
	}}
/>

<RefundDialog
	action="?/refund"
	balance={formatRupiah(data.finance.creditBalance)}
	open={refunding}
	onClose={() => {
		refunding = false;
	}}
/>
