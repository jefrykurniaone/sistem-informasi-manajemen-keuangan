<script lang="ts" module>
	/**
	 * The Alokasi being released, with its amount already formatted by the page — the same
	 * format-once argument `CorrectableCashTransaction` and `VoidableInvoice` record.
	 */
	export interface ReleasableAllocation {
		readonly id: string;
		/** The Pembayaran whose money the Alokasi holds — where a release sends it back. */
		readonly paymentId: string;
		/** The Periode of the Tagihan the Alokasi answers, as `YYYY-MM`. */
		readonly period: string;
		/** The allocation's amount, formatted. */
		readonly amount: string;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The dialog a superuser releases an Alokasi in, used by
	 * `src/routes/(app)/admin/units/[id]/finance/+page.svelte`.
	 *
	 * One instance on the page, fed by page state; the only field is the reason, because
	 * `src/lib/server/services/dues/allocation-release.ts` re-reads the row under its own locks and
	 * everything else about the release is a fact of that row. A native `<dialog>` opened with
	 * `showModal()`, per `src/lib/components/cash/correction-dialog.svelte`.
	 */
	interface Props {
		/** Where the release form posts. */
		readonly action: string;
		/** The Alokasi being released; absent means the dialog is closed. */
		readonly allocation?: ReleasableAllocation;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, allocation, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (allocation && !dialog.open) {
			dialog.showModal();
		} else if (!allocation && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="release-allocation-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if allocation}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<input type="hidden" name="allocationId" value={allocation.id} />

			<h2 id="release-allocation-heading-{uid}" class="text-lg font-semibold">
				{m.releaseAllocation_heading()}
			</h2>

			<p class="text-sm font-medium">
				{m.releaseAllocation_summary({
					amount: allocation.amount,
					paymentId: allocation.paymentId,
					period: allocation.period
				})}
			</p>
			<p class="text-sm text-muted-foreground">{m.releaseAllocation_explain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="release-allocation-reason-{uid}">
					{m.releaseAllocation_reasonLabel()}
				</label>
				<textarea
					id="release-allocation-reason-{uid}"
					name="reason"
					rows="3"
					required
					aria-describedby="release-allocation-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="release-allocation-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.releaseAllocation_reasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11">{m.releaseAllocation_submit()}</Button>
				<Button type="button" variant="outline" class="h-11" onclick={onClose}>
					{m.releaseAllocation_cancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
