<script lang="ts" module>
	import type { Rupiah } from '$lib/money';

	/** One line of the cash book as the table renders it. */
	export interface CashBookRow {
		readonly id: string;
		/** The day money moved, as `YYYY-MM-DD`. */
		readonly occurredOn: string;
		/** `income` or `expense`, which decides the column the amount lands in. */
		readonly type: string;
		readonly categoryName: string;
		/** The keterangan — or, on a Koreksi, the alasan. */
		readonly description: string;
		readonly amount: Rupiah;
		/** The running balance of the view this row belongs to, up to and including it. */
		readonly balance: Rupiah;
		/** True when this row reverses an earlier one. */
		readonly isCorrection: boolean;
		/** True when a Koreksi already reverses this row, which is also why it refuses a second. */
		readonly isCorrected: boolean;
		/** A short-lived signed link to the receipt photo, or null when the row has none. */
		readonly receiptUrl: string | null;
		readonly recordedByName: string;
	}
</script>

<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import type { CorrectableCashTransaction } from '$lib/components/cash/correction-dialog.svelte';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The buku kas itself: every line in date order with its running balance, used by
	 * `src/routes/(app)/admin/cash/+page.svelte`.
	 *
	 * What the balance column *means* depends on the filter, and saying so is the page's job — it
	 * prints the sentence above this table. This component only renders the number it was handed;
	 * the arithmetic is `src/lib/server/services/cash/balance.ts`, and it happens on every read
	 * because no balance is ever stored.
	 *
	 * A Koreksi is an ordinary row here, marked but never hidden: "koreksi yang tidak terlihat sama
	 * saja dengan penghapusan" (`docs/spec-kas-laporan-v1.md`). The row it corrects stays in place
	 * too, marked as corrected, which is also why it no longer offers a correction button — the
	 * service refuses a second one whether or not the button was drawn.
	 *
	 * The receipt is a link and nothing more. It is a short-lived signed link minted by the
	 * `FileStore` port on this admin-guarded page, so the way a receipt stays out of a resident's
	 * hands is that the link is never rendered anywhere a resident can reach.
	 */
	interface Props {
		readonly rows: readonly CashBookRow[];
		/** Called with the line a person pressed "koreksi" on, already formatted for the dialog. */
		readonly onCorrect: (transaction: CorrectableCashTransaction) => void;
	}

	let { rows, onCorrect }: Readonly<Props> = $props();

	/**
	 * Days are shown in UTC, the zone `occurredOn` is stored and compared in — the same reasoning as
	 * `src/routes/(app)/admin/opening-balance/+page.svelte`'s copy of this constant: the alternative
	 * is the zone of whichever machine renders the page, which differs between the first server
	 * render and the browser after hydration, and would move the date by a day either side of
	 * midnight.
	 */
	const DAY_FORMAT = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'UTC' });

	/** The stored value that means money coming in, as `cash_categories.type` writes it. */
	const INCOME = 'income';

	/** A stored `YYYY-MM-DD` as a day a person reads. */
	function asDay(day: string): string {
		return DAY_FORMAT.format(new Date(`${day}T00:00:00.000Z`));
	}

	/** What the dialog needs about the line whose button was pressed. */
	function correctable(row: CashBookRow): CorrectableCashTransaction {
		return {
			id: row.id,
			date: asDay(row.occurredOn),
			category: row.categoryName,
			amount: formatRupiah(row.amount)
		};
	}
</script>

<div class="overflow-x-auto">
	<table class="w-full border-collapse text-sm">
		<caption class="pb-2 text-left text-sm text-muted-foreground">
			{m.adminCash_tableCaption()}
		</caption>
		<thead>
			<tr class="border-b border-border text-left">
				<th scope="col" class="px-2 py-2 font-medium">{m.adminCash_columnDate()}</th>
				<th scope="col" class="px-2 py-2 font-medium">{m.adminCash_columnCategory()}</th>
				<th scope="col" class="px-2 py-2 font-medium">{m.adminCash_columnDescription()}</th>
				<th scope="col" class="px-2 py-2 text-right font-medium">{m.adminCash_columnIn()}</th>
				<th scope="col" class="px-2 py-2 text-right font-medium">{m.adminCash_columnOut()}</th>
				<th scope="col" class="px-2 py-2 text-right font-medium">{m.adminCash_columnBalance()}</th>
				<th scope="col" class="px-2 py-2 font-medium">{m.adminCash_columnReceipt()}</th>
				<th scope="col" class="px-2 py-2 font-medium">{m.adminCash_columnAction()}</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.id)}
				<tr class="border-b border-border align-top">
					<td class="px-2 py-2 whitespace-nowrap">{asDay(row.occurredOn)}</td>
					<td class="px-2 py-2">{row.categoryName}</td>
					<td class="px-2 py-2">
						<span>{row.description}</span>
						<span class="block text-xs text-muted-foreground">
							{m.adminCash_recordedBy({ name: row.recordedByName })}
						</span>
						{#if row.isCorrection}
							<span class="block text-xs font-medium">{m.adminCash_correctionBadge()}</span>
						{/if}
						{#if row.isCorrected}
							<span class="block text-xs font-medium">{m.adminCash_correctedBadge()}</span>
						{/if}
					</td>
					<td class="px-2 py-2 text-right whitespace-nowrap">
						{row.type === INCOME ? formatRupiah(row.amount) : ''}
					</td>
					<td class="px-2 py-2 text-right whitespace-nowrap">
						{row.type === INCOME ? '' : formatRupiah(row.amount)}
					</td>
					<td class="px-2 py-2 text-right font-medium whitespace-nowrap">
						{formatRupiah(row.balance)}
					</td>
					<td class="px-2 py-2">
						{#if row.receiptUrl}
							<!--
								`rel="external"` rather than `resolve()`: this href is a signed link the
								`FileStore` port minted, `/files/<key>?expires=…&signature=…`, and it is served by
								a file endpoint rather than by a SvelteKit page — so there is no route id to
								resolve, and a client-side navigation to it would be the wrong thing anyway.
							-->
							<a
								class="underline underline-offset-4"
								href={row.receiptUrl}
								target="_blank"
								rel="external noopener"
							>
								{m.adminCash_receiptLink()}
							</a>
						{:else}
							<span class="text-muted-foreground">{m.adminCash_receiptNone()}</span>
						{/if}
					</td>
					<td class="px-2 py-2">
						{#if !row.isCorrected}
							<Button
								type="button"
								variant="outline"
								class="h-9"
								onclick={() => onCorrect(correctable(row))}
							>
								{m.adminCash_correctOpen()}
							</Button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
