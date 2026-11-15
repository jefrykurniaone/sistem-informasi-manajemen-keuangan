<script lang="ts" module>
	/**
	 * The verified Pembayaran whose verification is being undone, with its amount already formatted
	 * by the page: the same format-once argument `ReversibleRefund` and `VoidableInvoice` record.
	 */
	export interface UnverifiablePayment {
		readonly id: string;
		/** The payment's amount, formatted. */
		readonly amount: string;
		/** The day the money was said to change hands, as `YYYY-MM-DD`: the day the Koreksi carries. */
		readonly receivedOn: string;
		/** Who recorded it: the person the rejection email goes to. */
		readonly recordedByName: string;
	}
</script>

<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';

	/**
	 * The dialog a superuser undoes a Pembayaran's verification in (Pembatalan verifikasi, #331), used
	 * by `src/routes/(app)/admin/units/[id]/finance/+page.svelte`.
	 *
	 * One instance on the page, fed by page state; the only field is the reason, because
	 * `unverifyPayment` in `src/lib/server/services/dues/dues-correction.ts` reads everything else off
	 * the payment, its Alokasi and its verification record under its own locks, and refuses by name a
	 * payment that is no longer verified or still has a Pengembalian in force. A native `<dialog>`
	 * opened with `showModal()`, per `src/lib/components/dues/reverse-refund-dialog.svelte`.
	 */
	interface Props {
		/** Where the form posts. */
		readonly action: string;
		/** The Pembayaran being unverified; absent means the dialog is closed. */
		readonly payment?: UnverifiablePayment;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, payment, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (payment && !dialog.open) {
			dialog.showModal();
		} else if (!payment && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="unverify-payment-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if payment}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<input type="hidden" name="paymentId" value={payment.id} />

			<h2 id="unverify-payment-heading-{uid}" class="text-lg font-semibold">
				{m.unverifyPayment_heading()}
			</h2>

			<p class="text-sm font-medium break-words">
				{m.unverifyPayment_summary({
					amount: payment.amount,
					date: payment.receivedOn,
					name: payment.recordedByName
				})}
			</p>
			<p class="text-sm text-muted-foreground">{m.unverifyPayment_explain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="unverify-payment-reason-{uid}">
					{m.unverifyPayment_reasonLabel()}
				</label>
				<textarea
					id="unverify-payment-reason-{uid}"
					name="reason"
					rows="3"
					required
					placeholder={m.unverifyPayment_reasonPlaceholder()}
					aria-describedby="unverify-payment-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="unverify-payment-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.unverifyPayment_reasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11">{m.unverifyPayment_submit()}</Button>
				<Button type="button" variant="outline" class="h-11" onclick={onClose}>
					{m.unverifyPayment_cancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
