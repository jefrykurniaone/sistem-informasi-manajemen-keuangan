<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatRupiah, type Rupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import type { PaymentMethod } from '$lib/server/db/schema/payment';

	/**
	 * The verification queue: every pending Pembayaran, each with the two decisions an admin can
	 * make about it — verify, optionally naming the Tagihan to serve first, or reject with a reason.
	 * Rendering only; every refusal is the service's, answered by the page's actions.
	 */

	/** One open Tagihan the verify form offers as an explicit choice. */
	interface QueueInvoice {
		readonly invoiceId: string;
		/** The calendar month it is for, as `YYYY-MM`. */
		readonly period: string;
		readonly remainingAmount: Rupiah;
		/** The day it falls due, as `YYYY-MM-DD`. */
		readonly dueDate: string;
	}

	/** One pending Pembayaran, its proof already signed for by the page that loaded it. */
	interface QueueRow {
		readonly paymentId: string;
		readonly block: string;
		readonly number: string;
		readonly recordedByName: string;
		readonly amount: Rupiah;
		/** The day the money changed hands, as `YYYY-MM-DD`. */
		readonly receivedOn: string;
		readonly method: PaymentMethod;
		/** A short-lived signed link to the proof, or null when the payment carries none. */
		readonly proofUrl: string | null;
		readonly openInvoices: readonly QueueInvoice[];
	}

	interface Props {
		readonly rows: readonly QueueRow[];
	}

	let { rows }: Readonly<Props> = $props();

	const uid = $props.id();

	/** The label for each of the two ways money arrives. */
	const METHOD_LABEL: Record<PaymentMethod, () => string> = {
		transfer: m.adminPayments_method_transfer,
		cash: m.adminPayments_method_cash
	};
</script>

{#if rows.length === 0}
	<p class="text-sm text-muted-foreground">{m.adminPayments_empty()}</p>
{:else}
	<div class="flex flex-col gap-4">
		{#each rows as row (row.paymentId)}
			<article class="flex flex-col gap-4 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-start justify-between gap-2">
					<div class="flex flex-col gap-1">
						<h2 class="font-medium">
							{m.adminPayments_unitName({ block: row.block, number: row.number })}
						</h2>
						<p class="text-sm text-muted-foreground">
							{m.adminPayments_recordedBy({ name: row.recordedByName })}
						</p>
						<p class="text-sm text-muted-foreground">
							{m.adminPayments_receivedOn({ date: row.receivedOn })}
							· {METHOD_LABEL[row.method]()}
						</p>
					</div>
					<div class="flex flex-col items-end gap-1">
						<span class="text-lg font-bold">{formatRupiah(row.amount)}</span>
						{#if row.proofUrl}
							<!--
								`rel="external"` rather than `resolve()`: this href is a signed link the
								`FileStore` port minted, `/files/<key>?expires=…&signature=…`, and it is served by
								a file endpoint rather than by a SvelteKit page — so there is no route id to
								resolve, and a client-side navigation to it would be the wrong thing anyway. The
								same reading `cash-book-table.svelte` already makes of its receipt link.
							-->
							<a
								href={row.proofUrl}
								target="_blank"
								rel="external noopener"
								class="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
							>
								{m.adminPayments_proofLink()}
							</a>
						{:else}
							<span class="text-sm text-muted-foreground">{m.adminPayments_proofNone()}</span>
						{/if}
					</div>
				</div>

				<form method="POST" action="?/verify" class="flex flex-col gap-3">
					<input type="hidden" name="paymentId" value={row.paymentId} />
					{#if row.openInvoices.length === 0}
						<p class="text-sm text-muted-foreground">{m.adminPayments_noOpenInvoices()}</p>
					{:else}
						<fieldset class="flex flex-col gap-2">
							<legend class="text-sm font-medium">{m.adminPayments_invoicesLegend()}</legend>
							<p class="text-sm text-muted-foreground">{m.adminPayments_invoicesHint()}</p>
							{#each row.openInvoices as invoice (invoice.invoiceId)}
								<label
									class="flex min-h-11 items-center gap-2 text-sm"
									for="invoice-{row.paymentId}-{invoice.invoiceId}-{uid}"
								>
									<input
										id="invoice-{row.paymentId}-{invoice.invoiceId}-{uid}"
										type="checkbox"
										name="invoiceIds"
										value={invoice.invoiceId}
										class="size-4"
									/>
									{m.adminPayments_invoiceOption({
										period: invoice.period,
										remaining: formatRupiah(invoice.remainingAmount),
										dueDate: invoice.dueDate
									})}
								</label>
							{/each}
						</fieldset>
					{/if}
					<Button class="min-h-11 self-start" type="submit">
						{m.adminPayments_verifySubmit()}
					</Button>
				</form>

				<form method="POST" action="?/reject" class="flex flex-col gap-3 sm:flex-row sm:items-end">
					<input type="hidden" name="paymentId" value={row.paymentId} />
					<div class="flex flex-1 flex-col gap-1.5">
						<label class="text-sm font-medium" for="reason-{row.paymentId}-{uid}">
							{m.adminPayments_rejectReasonLabel()}
						</label>
						<input
							id="reason-{row.paymentId}-{uid}"
							name="reason"
							type="text"
							required
							class="min-h-11 rounded-md border border-border bg-background px-3 text-sm"
						/>
					</div>
					<Button class="min-h-11" type="submit" variant="outline">
						{m.adminPayments_rejectSubmit()}
					</Button>
				</form>
			</article>
		{/each}
	</div>
{/if}
