<script lang="ts" module>
	/**
	 * The Pengembalian being reversed, with its amount already formatted by the page: the same
	 * format-once argument `ReleasableAllocation` and `VoidableInvoice` record.
	 */
	export interface ReversibleRefund {
		readonly id: string;
		/** The Pembayaran whose remainder the Pengembalian consumed, and gets back. */
		readonly paymentId: string;
		/** The day the money was handed back, as `YYYY-MM-DD`: the day the Koreksi will carry. */
		readonly occurredOn: string;
		/** The refund's amount, formatted. */
		readonly amount: string;
	}
</script>

<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';

	/**
	 * The dialog a superuser reverses a Pengembalian in (Pembatalan Pengembalian, #329), used by
	 * `src/routes/(app)/admin/units/[id]/finance/+page.svelte`.
	 *
	 * One instance on the page, fed by page state; the only field is the reason, because
	 * `reverseRefund` in `src/lib/server/services/dues/dues-correction.ts` reads everything else off
	 * the `refunds` row and its cash line under its own locks, and refuses one already reversed by
	 * name. A native `<dialog>` opened with `showModal()`, per
	 * `src/lib/components/dues/release-allocation-dialog.svelte`.
	 */
	interface Props {
		/** Where the reversal form posts. */
		readonly action: string;
		/** The Pengembalian being reversed; absent means the dialog is closed. */
		readonly refund?: ReversibleRefund;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, refund, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (refund && !dialog.open) {
			dialog.showModal();
		} else if (!refund && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="reverse-refund-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if refund}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<input type="hidden" name="refundId" value={refund.id} />

			<h2 id="reverse-refund-heading-{uid}" class="text-lg font-semibold">
				{m.reverseRefund_heading()}
			</h2>

			<p class="text-sm font-medium break-words">
				{m.reverseRefund_summary({
					amount: refund.amount,
					date: refund.occurredOn,
					paymentId: refund.paymentId
				})}
			</p>
			<p class="text-sm text-muted-foreground">{m.reverseRefund_explain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="reverse-refund-reason-{uid}">
					{m.reverseRefund_reasonLabel()}
				</label>
				<textarea
					id="reverse-refund-reason-{uid}"
					name="reason"
					rows="3"
					required
					placeholder={m.reverseRefund_reasonPlaceholder()}
					aria-describedby="reverse-refund-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="reverse-refund-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.reverseRefund_reasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11">{m.reverseRefund_submit()}</Button>
				<Button type="button" variant="outline" class="h-11" onclick={onClose}>
					{m.reverseRefund_cancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
