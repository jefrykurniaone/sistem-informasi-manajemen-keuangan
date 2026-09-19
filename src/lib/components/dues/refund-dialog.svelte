<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The dialog a superuser records a Pengembalian in, used by
	 * `src/routes/(app)/admin/units/[id]/finance/+page.svelte`.
	 *
	 * Unlike the void and release dialogs, it names no row: the Unit comes from the route, and the
	 * amount, day and reason are the superuser's to type —
	 * `src/lib/server/services/dues/credit-refund.ts` decides which Pembayaran the money comes out
	 * of, oldest first, under its own locks. The balance shown is the page's number at render time;
	 * a refund above whatever the balance really is at commit time is refused by name, so this
	 * dialog needs no client-side ceiling to be correct. A native `<dialog>` opened with
	 * `showModal()`, per `src/lib/components/cash/correction-dialog.svelte`.
	 */
	interface Props {
		/** Where the refund form posts. */
		readonly action: string;
		/** The Unit's saldo titipan, formatted — shown so the superuser types against a number. */
		readonly balance: string;
		/** Whether the dialog is open. */
		readonly open: boolean;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, balance, open, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (open && !dialog.open) {
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="refund-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if open}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<h2 id="refund-heading-{uid}" class="text-lg font-semibold">{m.refund_heading()}</h2>

			<p class="text-sm font-medium">{m.refund_balance({ balance })}</p>
			<p class="text-sm text-muted-foreground">{m.refund_explain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="refund-amount-{uid}">{m.refund_amountLabel()}</label
				>
				<input
					id="refund-amount-{uid}"
					name="amount"
					type="number"
					inputmode="numeric"
					min="1"
					step="1"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="refund-date-{uid}">{m.refund_dateLabel()}</label>
				<input
					id="refund-date-{uid}"
					name="occurredOn"
					type="date"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="refund-reason-{uid}">{m.refund_reasonLabel()}</label
				>
				<textarea
					id="refund-reason-{uid}"
					name="reason"
					rows="3"
					required
					aria-describedby="refund-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="refund-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.refund_reasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11">{m.refund_submit()}</Button>
				<Button type="button" variant="outline" class="h-11" onclick={onClose}>
					{m.refund_cancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
