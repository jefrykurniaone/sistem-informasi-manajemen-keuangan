<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import type { Rupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';

	/** The rate an edit form starts from. */
	interface DuesRateFormValues {
		/** The row being changed, carried back to the action as a hidden field. */
		readonly id: string;
		/** Its current amount, in whole rupiah. */
		readonly amount: Rupiah;
		/** Its current start date, as `YYYY-MM-DD`. */
		readonly effectiveFrom: string;
	}

	/**
	 * The Tarif form on `src/routes/(app)/admin/dues-rates/+page.svelte`, in both of the shapes that
	 * screen needs. It posts to that route's own actions and holds no logic of its own — only the two
	 * fields they read (`amount`, `effectiveFrom`) and, when editing, the id of the row.
	 *
	 * With no `rate` it is the "set a new rate" form and posts to `?/create`. With one it is the edit
	 * form of that row, posts to `?/update`, and offers `?/delete` beside it. The page renders an edit
	 * form only for a rate the service reported as still changeable, so nothing here decides whether a
	 * rate may be touched — see `$lib/server/services/dues/rate`.
	 *
	 * The message from the last submission is deliberately not a prop: a screen showing several of
	 * these at once has one result to report, and the page prints it once above them all rather than
	 * repeating it in every row.
	 */
	interface Props {
		/** The rate being changed. Absent means this form sets a new one. */
		readonly rate?: DuesRateFormValues;
	}

	let { rate }: Readonly<Props> = $props();

	const uid = $props.id();

	const formAction = $derived(rate ? '?/update' : '?/create');
	const submitLabel = $derived(rate ? m.adminDuesRates_editSubmit() : m.adminDuesRates_setSubmit());
</script>

<form
	method="POST"
	action={formAction}
	aria-label={rate ? m.adminDuesRates_editHeading() : m.adminDuesRates_setHeading()}
	class="flex flex-col gap-3 sm:flex-row sm:items-end"
>
	{#if rate}
		<input type="hidden" name="duesRateId" value={rate.id} />
	{/if}

	<div class="flex flex-1 flex-col gap-1">
		<label class="text-sm font-medium" for="dues-rate-amount-{uid}">
			{m.adminDuesRates_amountLabel()}
		</label>
		<input
			id="dues-rate-amount-{uid}"
			name="amount"
			type="text"
			inputmode="numeric"
			required
			value={rate ? String(rate.amount) : ''}
			placeholder={m.adminDuesRates_amountPlaceholder()}
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		/>
	</div>

	<div class="flex flex-1 flex-col gap-1">
		<label class="text-sm font-medium" for="dues-rate-effective-from-{uid}">
			{m.adminDuesRates_effectiveFromLabel()}
		</label>
		<input
			id="dues-rate-effective-from-{uid}"
			name="effectiveFrom"
			type="date"
			required
			value={rate ? rate.effectiveFrom : ''}
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		/>
	</div>

	<div class="flex flex-wrap gap-2">
		<Button type="submit" class="h-11">{submitLabel}</Button>
		{#if rate}
			<Button type="submit" variant="destructive" class="h-11" formaction="?/delete" formnovalidate>
				{m.adminDuesRates_deleteSubmit()}
			</Button>
		{/if}
	</div>
</form>
