<script lang="ts" module>
	/** How many bytes are in a mebibyte, for turning a limit in bytes into the text beside the field. */
	const BYTES_PER_MEBIBYTE = 1024 * 1024;

	/** A byte count as the megabytes a person reads, with one decimal place. */
	export function megabytes(bytes: number): string {
		return (bytes / BYTES_PER_MEBIBYTE).toFixed(1);
	}
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The proof-of-transfer field of the "catat pembayaran" form.
	 *
	 * Its own component rather than three lines inside `payment-form.svelte`, because the photograph
	 * is the part of this form that can go wrong on a phone: it is the only field a resident fills in
	 * from the camera, the only one with a size limit, and the only one whose failure is worth telling
	 * them about before they press save rather than after.
	 *
	 * **The check here is a courtesy and never the guarantee.** The size and the format are both
	 * refused again by `recordPayment` in `src/lib/server/services/dues/payment.ts`, which reads the
	 * file's first bytes rather than believing the type the browser attached — the whole point being
	 * that everything this component can see arrives from the sender.
	 *
	 * **There is no `capture` attribute, deliberately.** `capture="environment"` opens the camera and,
	 * in several mobile browsers, takes the gallery away with it. A resident who photographed the
	 * receipt an hour ago would then have no way to attach it. A plain file input restricted by
	 * `accept` offers the camera *and* the gallery in the phone's own picker, which is what "unggah
	 * dari kamera ponsel bekerja" asks for.
	 */
	interface Props {
		/** The form field name the file is posted under. */
		readonly name: string;
		/** The content types the service accepts, as it names them. */
		readonly acceptedTypes: readonly string[];
		/** The largest file the service accepts, in bytes. */
		readonly maximumBytes: number;
	}

	let { name, acceptedTypes, maximumBytes }: Readonly<Props> = $props();

	const uid = $props.id();

	/** The file the resident picked, so that the page can say what it is before anything is sent. */
	let chosen: File | undefined = $state();

	/** Whether that file is already past the limit — answered here so nobody waits for a round trip. */
	const isTooLarge = $derived(chosen !== undefined && chosen.size > maximumBytes);

	function onFileChange(event: Event & { currentTarget: HTMLInputElement }): void {
		chosen = event.currentTarget.files?.[0];
	}
</script>

<div class="flex flex-col gap-1.5">
	<label class="text-sm font-medium" for="payment-proof-{uid}">
		{m.payments_form_proofLabel()}
	</label>
	<input
		id="payment-proof-{uid}"
		{name}
		type="file"
		required
		accept={acceptedTypes.join(',')}
		aria-describedby="payment-proof-hint-{uid}"
		onchange={onFileChange}
		class="min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
	/>
	<p id="payment-proof-hint-{uid}" class="text-sm text-muted-foreground">
		{m.payments_form_proofHint({ maximumSize: megabytes(maximumBytes) })}
	</p>
	{#if chosen}
		<p class="text-sm {isTooLarge ? 'font-medium text-destructive' : 'text-muted-foreground'}">
			{#if isTooLarge}
				{m.payments_form_proofTooLarge({
					size: megabytes(chosen.size),
					maximumSize: megabytes(maximumBytes)
				})}
			{:else}
				{m.payments_form_proofChosen({ name: chosen.name, size: megabytes(chosen.size) })}
			{/if}
		</p>
	{/if}
</div>
