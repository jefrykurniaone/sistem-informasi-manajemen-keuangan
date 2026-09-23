<script lang="ts" module>
	/**
	 * The Tagihan being cancelled, with its amount already written the way a person reads it.
	 *
	 * Formatting happens once, in the page that already formats the invoice list, rather than a
	 * second time here — the same argument `CorrectableCashTransaction` records: two places that
	 * turn a `Rupiah` into text are two places that can disagree about it.
	 */
	export interface VoidableInvoice {
		readonly id: string;
		/** The calendar month it is for, as `YYYY-MM`. */
		readonly period: string;
		/** The invoice's amount, formatted. */
		readonly amount: string;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The dialog a superuser cancels a Tagihan in, used by
	 * `src/routes/(app)/admin/units/[id]/finance/+page.svelte`.
	 *
	 * There is **one** of these on the page rather than one per invoice: the page keeps which
	 * Tagihan is being cancelled in a single piece of state and hands it over here. The only field
	 * is the reason, because `src/lib/server/services/dues/invoice-void.ts` reads everything else
	 * off the row itself and refuses by name whatever else could be wrong. A native `<dialog>`
	 * opened with `showModal()` rather than a hand-built overlay, so focus trapping, the backdrop
	 * and closing on Escape are the browser's job — the shape
	 * `src/lib/components/cash/correction-dialog.svelte` settled.
	 */
	interface Props {
		/** Where the void form posts. */
		readonly action: string;
		/** The Tagihan being cancelled; absent means the dialog is closed. */
		readonly invoice?: VoidableInvoice;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, invoice, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (invoice && !dialog.open) {
			dialog.showModal();
		} else if (!invoice && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="void-invoice-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if invoice}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<input type="hidden" name="invoiceId" value={invoice.id} />

			<h2 id="void-invoice-heading-{uid}" class="text-lg font-semibold">
				{m.voidInvoice_heading()}
			</h2>

			<p class="text-sm font-medium">
				{m.voidInvoice_summary({ period: invoice.period, amount: invoice.amount })}
			</p>
			<p class="text-sm text-muted-foreground">{m.voidInvoice_explain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="void-invoice-reason-{uid}">
					{m.voidInvoice_reasonLabel()}
				</label>
				<textarea
					id="void-invoice-reason-{uid}"
					name="reason"
					rows="3"
					required
					placeholder={m.voidInvoice_reasonPlaceholder()}
					aria-describedby="void-invoice-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="void-invoice-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.voidInvoice_reasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11">{m.voidInvoice_submit()}</Button>
				<Button type="button" variant="outline" class="h-11" onclick={onClose}>
					{m.voidInvoice_cancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
