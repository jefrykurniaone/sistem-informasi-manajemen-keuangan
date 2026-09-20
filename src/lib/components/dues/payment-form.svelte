<script lang="ts" module>
	import type { Rupiah } from '$lib/money';

	/**
	 * What the recording form holds, as the strings a form really carries.
	 *
	 * The amount stays a string and is parsed on the server by `parseRupiah`, which refuses a
	 * fraction rather than rounding it — see `src/lib/money.ts`. Turning it into a number in the
	 * browser would be a second, more forgiving parser sitting in front of the strict one.
	 */
	export interface PaymentFormValues {
		/** The house the money is for. */
		readonly unitId: string;
		/** As typed. Whole rupiah, with or without thousands separators. */
		readonly amount: string;
		/** `YYYY-MM-DD`, as a `date` input reads and writes one. */
		readonly receivedOn: string;
	}

	/** An empty form, for the screen before anything has been typed. */
	export const EMPTY_PAYMENT_FORM_VALUES: PaymentFormValues = {
		unitId: '',
		amount: '',
		receivedOn: ''
	};

	/** One Tagihan the picker offers. Carries no paid-or-unpaid figure; that is #27's screen. */
	export interface PaymentFormInvoice {
		readonly invoiceId: string;
		readonly period: string;
		readonly amount: Rupiah;
		readonly dueDate: string;
	}

	/** One house the resident may record a payment for. */
	export interface PaymentFormUnit {
		readonly unitId: string;
		readonly block: string;
		readonly number: string;
		readonly invoices: readonly PaymentFormInvoice[];
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import RupiahInput from '$lib/components/rupiah-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import ProofUpload from '$lib/components/dues/proof-upload.svelte';
	import { formatRupiah, rupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The form a Warga records one Pembayaran on, used by
	 * `src/routes/(app)/payments/new/+page.svelte`. It posts to that route's own action and holds no
	 * rule of its own: every one of them is refused again by
	 * `src/lib/server/services/dues/payment.ts`, which is the layer the acceptance criteria name.
	 *
	 * ## The Tagihan picker fills the amount in and is not posted
	 *
	 * Ticking months is how a resident says "these are the ones I paid", and what it does is add
	 * their amounts up into the nominal field, which stays editable. It is **not** submitted, because
	 * there is nowhere for it to be recorded: the only table that maps a Pembayaran to a Tagihan is
	 * `allocations`, and writing one before anybody has checked that the money arrived is exactly
	 * what the spec's "sampai diverifikasi, belum ada uang yang masuk ke kas mana pun" forbids. The
	 * pengurus decides the allocation at verification, oldest Tagihan first, and the hint under the
	 * picker says so rather than letting the resident believe they have chosen it.
	 *
	 * ## The nominal field needs JavaScript
	 *
	 * It is a `RupiahInput`, which shows the amount grouped as `1.500.000` and posts the plain digits
	 * from a hidden field beside it — so an amount typed with JavaScript off reaches no hidden field and
	 * is not posted. That is a change from the ordinary input this form used to carry, and it is the
	 * price of the formatting: see `src/lib/components/rupiah-input.svelte`. The picker's addition
	 * writes through the same binding, so ticking a Tagihan still fills the field in and the hidden
	 * value follows it.
	 */
	interface Props {
		/** Where to post. */
		readonly action: string;
		/** What the fields hold: the last rejected submission, or an empty form. */
		readonly values: PaymentFormValues;
		/** The houses on offer — every one the resident is living in today, resolved by the route. */
		readonly units: readonly PaymentFormUnit[];
		/** The content types the proof field accepts, as the `FileStore` caller names them. */
		readonly acceptedProofTypes: readonly string[];
		/** The largest proof the service accepts, in bytes. */
		readonly maximumProofBytes: number;
	}

	let { action, values, units, acceptedProofTypes, maximumProofBytes }: Readonly<Props> = $props();

	const uid = $props.id();

	/**
	 * The house the form is about, and the nominal — both seeded from the props once and then owned
	 * by the fields.
	 *
	 * `untrack` says that deliberately. This form posts without `use:enhance`, so a rejected
	 * submission is a full page load and the component is built again with the values the server sent
	 * back; re-seeding a field from a prop *while somebody is typing in it* is the behaviour that
	 * would be wrong, which is what the warning without `untrack` is about.
	 */
	let unitId = $state(
		untrack(() => (values.unitId === '' ? (units[0]?.unitId ?? '') : values.unitId))
	);
	let amount = $state(untrack(() => values.amount));

	/** Which Tagihan are ticked. Client-side only — see this component's doc comment. */
	let ticked = $state<readonly string[]>([]);

	const selectedUnit = $derived(units.find((unit) => unit.unitId === unitId));

	function toggle(invoiceId: string, isTicked: boolean): void {
		ticked = isTicked
			? [...ticked, invoiceId]
			: ticked.filter((candidate) => candidate !== invoiceId);
		// Unticking the last box leaves the nominal alone rather than clearing it. Somebody paying in
		// advance types an amount first and may tick a Tagihan to see what a month costs; wiping what
		// they typed when they untick it again would throw away the only field they had filled in.
		if (ticked.length > 0) {
			amount = String(tickedTotal());
		}
	}

	/** What the ticked Tagihan of the chosen house come to, in whole rupiah. */
	function tickedTotal(): number {
		const offered = selectedUnit?.invoices ?? [];
		return offered
			.filter((invoice) => ticked.includes(invoice.invoiceId))
			.reduce((total, invoice) => total + invoice.amount, 0);
	}

	/** Changing house clears a selection that belonged to the other one's Tagihan. */
	function onUnitChange(): void {
		ticked = [];
	}

	/** One Tagihan as the checkbox beside it reads. */
	function invoiceLabel(invoice: PaymentFormInvoice): string {
		return m.payments_form_invoiceOption({
			period: invoice.period,
			amount: formatRupiah(invoice.amount),
			dueDate: invoice.dueDate
		});
	}
</script>

<form
	method="POST"
	{action}
	enctype="multipart/form-data"
	class="flex flex-col gap-4 rounded-lg border border-border p-4"
>
	{#if units.length > 1}
		<div class="flex flex-col gap-1.5">
			<label class="text-sm font-medium" for="payment-unit-{uid}">
				{m.payments_form_unitLabel()}
			</label>
			<select
				id="payment-unit-{uid}"
				name="unitId"
				required
				bind:value={unitId}
				onchange={onUnitChange}
				class="h-11 rounded-md border border-border bg-background px-3 text-sm"
			>
				{#each units as unit (unit.unitId)}
					<option value={unit.unitId}>
						{m.payments_unitName({ block: unit.block, number: unit.number })}
					</option>
				{/each}
			</select>
		</div>
	{:else}
		<input type="hidden" name="unitId" value={unitId} />
		<p class="text-sm text-muted-foreground">
			{m.payments_form_unitFixed({
				unit: m.payments_unitName({
					block: selectedUnit?.block ?? '',
					number: selectedUnit?.number ?? ''
				})
			})}
		</p>
	{/if}

	<fieldset class="flex flex-col gap-2">
		<legend class="text-sm font-medium">{m.payments_form_invoicesLabel()}</legend>
		{#if selectedUnit && selectedUnit.invoices.length > 0}
			{#each selectedUnit.invoices as invoice (invoice.invoiceId)}
				<label class="flex min-h-11 items-center gap-3 text-sm">
					<input
						type="checkbox"
						class="size-5 shrink-0"
						checked={ticked.includes(invoice.invoiceId)}
						onchange={(event) => toggle(invoice.invoiceId, event.currentTarget.checked)}
					/>
					<span>{invoiceLabel(invoice)}</span>
				</label>
			{/each}
		{:else}
			<p class="text-sm text-muted-foreground">{m.payments_form_invoicesEmpty()}</p>
		{/if}
		<p class="text-sm text-muted-foreground">{m.payments_form_invoicesHint()}</p>
	</fieldset>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="payment-amount-{uid}">
			{m.payments_form_amountLabel()}
		</label>
		<RupiahInput
			id="payment-amount-{uid}"
			name="amount"
			required
			bind:value={amount}
			aria-describedby="payment-amount-hint-{uid}"
			class="w-full"
		/>
		<p id="payment-amount-hint-{uid}" class="text-sm text-muted-foreground">
			{m.payments_form_amountHint({ example: formatRupiah(rupiah(150_000)) })}
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="text-sm font-medium" for="payment-received-on-{uid}">
			{m.payments_form_receivedOnLabel()}
		</label>
		<input
			id="payment-received-on-{uid}"
			name="receivedOn"
			type="date"
			required
			value={values.receivedOn}
			aria-describedby="payment-received-on-hint-{uid}"
			class="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
		/>
		<p id="payment-received-on-hint-{uid}" class="text-sm text-muted-foreground">
			{m.payments_form_receivedOnHint()}
		</p>
	</div>

	<ProofUpload name="proof" acceptedTypes={acceptedProofTypes} maximumBytes={maximumProofBytes} />

	<div>
		<Button type="submit" class="h-11 w-full sm:w-auto">{m.payments_form_submit()}</Button>
	</div>
</form>
