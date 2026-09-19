<script lang="ts" module>
	/**
	 * The line being corrected, with its date and amount already written the way a person reads
	 * them.
	 *
	 * Formatting happens once, in the page that already formats the table, rather than a second time
	 * here: two places that turn a `Rupiah` into text are two places that can disagree about it, and
	 * the dialog's whole job is to show the admin the same line they clicked on.
	 */
	export interface CorrectableCashTransaction {
		readonly id: string;
		/** The transaction's `occurredOn`, formatted. */
		readonly date: string;
		readonly category: string;
		/** The transaction's amount, formatted. */
		readonly amount: string;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The dialog an admin writes a Koreksi in, used by `src/routes/(app)/admin/cash/+page.svelte`.
	 *
	 * There is **one** of these on the page rather than one per row: the page keeps which line is
	 * being corrected in a single piece of state and hands it over here, so the browser holds one
	 * dialog however long the cash book is.
	 *
	 * The only field is the reason, because a Koreksi's date, amount, category and direction are all
	 * read off the transaction being corrected by
	 * `src/lib/server/services/cash/correction.ts` — there is nothing else for a person to get
	 * wrong. A native `<dialog>` opened with `showModal()` is used rather than a hand-built overlay
	 * so that focus trapping, the backdrop and closing on Escape are the browser's job.
	 */
	interface Props {
		/** Where the correction form posts. */
		readonly action: string;
		/** The line being corrected; absent means the dialog is closed. */
		readonly transaction?: CorrectableCashTransaction;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, transaction, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (transaction && !dialog.open) {
			dialog.showModal();
		} else if (!transaction && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="cash-correction-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if transaction}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<input type="hidden" name="transactionId" value={transaction.id} />

			<h2 id="cash-correction-heading-{uid}" class="text-lg font-semibold">
				{m.adminCash_correctionHeading()}
			</h2>

			<p class="text-sm font-medium">
				{m.adminCash_correctionSummary({
					date: transaction.date,
					category: transaction.category,
					amount: transaction.amount
				})}
			</p>
			<p class="text-sm text-muted-foreground">{m.adminCash_correctionExplain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="cash-correction-reason-{uid}">
					{m.adminCash_correctionReasonLabel()}
				</label>
				<textarea
					id="cash-correction-reason-{uid}"
					name="reason"
					rows="3"
					required
					aria-describedby="cash-correction-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="cash-correction-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.adminCash_correctionReasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11">{m.adminCash_correctionSubmit()}</Button>
				<Button type="button" variant="outline" class="h-11" onclick={onClose}>
					{m.adminCash_correctionCancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
