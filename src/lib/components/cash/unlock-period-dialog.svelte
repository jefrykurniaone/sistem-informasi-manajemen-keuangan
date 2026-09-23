<script lang="ts" module>
	/**
	 * The locked month being reopened, already written the way a person reads it.
	 *
	 * `year` and `month` travel separately from `period` because the form posts the two integers the
	 * service is keyed on, while the heading shows the `YYYY-MM` label the page already built. One
	 * place turns a Periode into text, and it is the page — two places that format the same month are
	 * two places that can disagree about it.
	 */
	export interface UnlockablePeriod {
		readonly year: number;
		readonly month: number;
		/** The month as `YYYY-MM`, for the heading. */
		readonly period: string;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The dialog a superuser writes the alasan in, used by
	 * `src/routes/(app)/admin/periods/+page.svelte`.
	 *
	 * There is **one** of these on the page rather than one per row: the page keeps which month is
	 * being reopened in a single piece of state and hands it over here, so the browser holds one
	 * dialog however many months the cash book has. The same shape `correction-dialog.svelte`
	 * settled, and for the same reasons — a native `<dialog>` opened with `showModal()` leaves focus
	 * trapping, the backdrop and closing on Escape to the browser.
	 *
	 * The only field is the reason, because everything else about the request is the month that was
	 * clicked. It is `required` here and required again in
	 * `src/lib/server/services/cash/period.ts`: the attribute is a courtesy that keeps an empty form
	 * from being posted, and the service is what makes "dengan alasan wajib" true.
	 */
	interface Props {
		/** Where the unlock form posts. */
		readonly action: string;
		/** The month being reopened; absent means the dialog is closed. */
		readonly period?: UnlockablePeriod;
		/** Called when the dialog closes, however it was closed, so the page can clear its state. */
		readonly onClose: () => void;
	}

	let { action, period, onClose }: Readonly<Props> = $props();

	const uid = $props.id();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) {
			return;
		}
		if (period && !dialog.open) {
			dialog.showModal();
		} else if (!period && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	onclose={onClose}
	aria-labelledby="period-unlock-heading-{uid}"
	class="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
>
	{#if period}
		<form method="POST" {action} class="flex flex-col gap-4 p-4">
			<input type="hidden" name="year" value={period.year} />
			<input type="hidden" name="month" value={period.month} />

			<h2 id="period-unlock-heading-{uid}" class="text-lg font-semibold">
				{m.adminPeriods_unlockHeading({ period: period.period })}
			</h2>

			<p class="text-sm text-muted-foreground">{m.adminPeriods_unlockExplain()}</p>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="period-unlock-reason-{uid}">
					{m.adminPeriods_unlockReasonLabel()}
				</label>
				<textarea
					id="period-unlock-reason-{uid}"
					name="reason"
					rows="3"
					required
					placeholder={m.adminPeriods_unlockReasonPlaceholder()}
					aria-describedby="period-unlock-reason-hint-{uid}"
					class="rounded-md border border-border bg-background px-3 py-2 text-sm"></textarea>
				<p id="period-unlock-reason-hint-{uid}" class="text-sm text-muted-foreground">
					{m.adminPeriods_unlockReasonHint()}
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<Button type="submit" class="h-11 min-w-24">{m.adminPeriods_unlockSubmit()}</Button>
				<Button type="button" variant="outline" class="h-11 min-w-24" onclick={onClose}>
					{m.adminPeriods_unlockCancel()}
				</Button>
			</div>
		</form>
	{/if}
</dialog>
