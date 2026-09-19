<script lang="ts" module>
	/** How many bytes are in a mebibyte, for turning a limit in bytes into the text beside the field. */
	const BYTES_PER_MEBIBYTE = 1024 * 1024;

	/**
	 * A byte count as the megabytes a person reads, to one decimal place and without a trailing `.0`
	 * — the same helper `dues/proof-upload.svelte` exports for its own field, copied rather than
	 * imported for the reason `../../server/services/complaint/attachment.ts` copies its byte
	 * signatures from `dues/payment.ts`: two components with nothing else in common should not share
	 * a dependency that ties their formatting together.
	 */
	export function megabytes(bytes: number): string {
		return String(Number((bytes / BYTES_PER_MEBIBYTE).toFixed(1)));
	}
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The Lampiran field of the "lapor keluhan" form: up to `maxCount` photographs, picked from one
	 * file input with `multiple` set so the browser's own picker offers the camera and the gallery
	 * together — the same choice `dues/proof-upload.svelte` makes and for the same reason, restated
	 * here since three photos rather than one is what "unggah dari kamera ponsel bekerja" has to hold
	 * for.
	 *
	 * **Every check here is a courtesy, never the guarantee.** The count, the size and the format are
	 * all refused again by `storeComplaintAttachments` in
	 * `src/lib/server/services/complaint/attachment.ts`, which reads each file's first bytes rather
	 * than believing the type the browser attached — the whole point being that everything this
	 * component can see arrives from the sender.
	 */
	interface Props {
		/** The form field name every chosen file is posted under, via `FormData.getAll`. */
		readonly name: string;
		/** The content types the service accepts, as it names them. */
		readonly acceptedTypes: readonly string[];
		/** The largest single file the service accepts, in bytes. */
		readonly maximumBytes: number;
		/** How many files the service accepts in one report. */
		readonly maxCount: number;
	}

	let { name, acceptedTypes, maximumBytes, maxCount }: Readonly<Props> = $props();

	const uid = $props.id();

	/** The files the resident picked, so the page can say what they are before anything is sent. */
	let chosen: File[] = $state([]);

	/** Whether more files were picked than the service will accept. */
	const isTooMany = $derived(chosen.length > maxCount);

	function onFileChange(event: Event & { currentTarget: HTMLInputElement }): void {
		chosen = Array.from(event.currentTarget.files ?? []);
	}
</script>

<div class="flex flex-col gap-1.5">
	<label class="text-sm font-medium" for="complaint-attachments-{uid}">
		{m.complaintsNew_attachmentsLabel()}
	</label>
	<input
		id="complaint-attachments-{uid}"
		{name}
		type="file"
		multiple
		accept={acceptedTypes.join(',')}
		aria-describedby="complaint-attachments-hint-{uid}"
		onchange={onFileChange}
		class="min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
	/>
	<p id="complaint-attachments-hint-{uid}" class="text-sm text-muted-foreground">
		{m.complaintsNew_attachmentsHint({ maximumSize: megabytes(maximumBytes), maxCount })}
	</p>

	{#if chosen.length > 0}
		<ul class="flex flex-col gap-1">
			{#each chosen as file, index (index)}
				{@const tooLarge = file.size > maximumBytes}
				<li class="text-sm {tooLarge ? 'font-medium text-destructive' : 'text-muted-foreground'}">
					{#if tooLarge}
						{m.complaintsNew_attachmentTooLarge({
							size: megabytes(file.size),
							maximumSize: megabytes(maximumBytes)
						})}
					{:else}
						{m.complaintsNew_attachmentChosen({ name: file.name, size: megabytes(file.size) })}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if isTooMany}
		<p class="text-sm font-medium text-destructive">
			{m.complaintsNew_attachmentTooMany({ count: chosen.length, max: maxCount })}
		</p>
	{/if}
</div>
