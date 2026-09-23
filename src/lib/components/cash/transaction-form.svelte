<script lang="ts" module>
	/**
	 * What the recording form holds, as the strings a form really carries.
	 *
	 * The amount stays a string here and is parsed on the server by `parseRupiah`, which refuses a
	 * fraction rather than rounding it — see `src/lib/money.ts`. Turning it into a number in the
	 * browser would be a second, more forgiving parser sitting in front of the strict one.
	 */
	export interface CashTransactionFormValues {
		/** `YYYY-MM-DD`, as a `date` input reads and writes one. */
		readonly occurredOn: string;
		readonly categoryId: string;
		readonly amount: string;
		readonly description: string;
	}

	/** An empty form, for the "catat transaksi" screen before anything has been typed. */
	export const EMPTY_CASH_TRANSACTION_FORM_VALUES: CashTransactionFormValues = {
		occurredOn: '',
		categoryId: '',
		amount: '',
		description: ''
	};

	/** One Kategori Kas the form may file a transaction under. */
	export interface CashFormCategory {
		readonly id: string;
		readonly name: string;
		/** `income` or `expense`, shown beside the name so the direction is visible before saving. */
		readonly type: string;
	}
</script>

<script lang="ts">
	import RupiahInput from '$lib/components/rupiah-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The form an admin records one Transaksi Kas on, used by
	 * `src/routes/(app)/admin/cash/new/+page.svelte`. It posts to that route's own action and holds
	 * no logic of its own.
	 *
	 * There is deliberately no direction field. The chosen category's type is the row's direction —
	 * a rule `src/lib/server/services/cash/transaction.ts` makes true by never reading one from the
	 * caller — so the form shows each category's direction beside its name instead of asking for it
	 * a second time and letting the two disagree.
	 *
	 * The category list is the *active* one, with the system categories already taken out by the
	 * route. That is a courtesy, not the guarantee: the service refuses a system category whether or
	 * not an option for it was ever drawn.
	 */
	interface Props {
		/** Where to post. */
		readonly action: string;
		/** What the fields hold: the last rejected submission, or an empty form. */
		readonly values: CashTransactionFormValues;
		/** The categories on offer, already filtered and ordered by the route. */
		readonly categories: readonly CashFormCategory[];
		/** The content types the receipt field accepts, as the `FileStore` caller names them. */
		readonly acceptedReceiptTypes: readonly string[];
	}

	let { action, values, categories, acceptedReceiptTypes }: Readonly<Props> = $props();

	const uid = $props.id();

	/** The direction one category gives a transaction filed under it. */
	function typeLabel(type: string): string {
		if (type === 'income') {
			return m.adminCash_typeIncome();
		}
		return m.adminCash_typeExpense();
	}
</script>

<form
	method="POST"
	{action}
	enctype="multipart/form-data"
	class="flex flex-col gap-4 rounded-lg border border-border p-4"
>
	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="cash-transaction-date-{uid}">
			{m.adminCash_form_dateLabel()}
		</label>
		<input
			id="cash-transaction-date-{uid}"
			name="occurredOn"
			type="date"
			required
			value={values.occurredOn}
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		/>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="cash-transaction-category-{uid}">
			{m.adminCash_form_categoryLabel()}
		</label>
		<select
			id="cash-transaction-category-{uid}"
			name="categoryId"
			required
			aria-describedby="cash-transaction-category-hint-{uid}"
			class="h-11 rounded-md border border-border bg-background px-3 text-sm"
		>
			<option value="" disabled selected={values.categoryId === ''}>
				{m.adminCash_form_categoryPlaceholder()}
			</option>
			{#each categories as category (category.id)}
				<option value={category.id} selected={values.categoryId === category.id}>
					{category.name} ({typeLabel(category.type)})
				</option>
			{/each}
		</select>
		<p id="cash-transaction-category-hint-{uid}" class="text-sm text-muted-foreground">
			{m.adminCash_form_categoryHint()}
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="cash-transaction-amount-{uid}">
			{m.adminCash_form_amountLabel()}
		</label>
		<RupiahInput
			id="cash-transaction-amount-{uid}"
			name="amount"
			required
			value={values.amount}
			aria-describedby="cash-transaction-amount-hint-{uid}"
		/>
		<p id="cash-transaction-amount-hint-{uid}" class="text-sm text-muted-foreground">
			{m.adminCash_form_amountHint()}
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="cash-transaction-description-{uid}">
			{m.adminCash_form_descriptionLabel()}
		</label>
		<textarea
			id="cash-transaction-description-{uid}"
			name="description"
			rows="3"
			required
			aria-describedby="cash-transaction-description-hint-{uid}"
			class="rounded-md border border-border bg-background px-3 py-2 text-sm"
			>{values.description}</textarea
		>
		<p id="cash-transaction-description-hint-{uid}" class="text-sm text-muted-foreground">
			{m.adminCash_form_descriptionHint()}
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="cash-transaction-receipt-{uid}">
			{m.adminCash_form_receiptLabel()}
		</label>
		<input
			id="cash-transaction-receipt-{uid}"
			name="receipt"
			type="file"
			accept={acceptedReceiptTypes.join(',')}
			aria-describedby="cash-transaction-receipt-hint-{uid}"
			class="rounded-md border border-border bg-background px-3 py-2 text-sm"
		/>
		<p id="cash-transaction-receipt-hint-{uid}" class="text-sm text-muted-foreground">
			{m.adminCash_form_receiptHint()}
		</p>
	</div>

	<div>
		<Button type="submit" class="h-11">{m.adminCash_form_submit()}</Button>
	</div>
</form>
