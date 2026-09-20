<script lang="ts">
	/**
	 * A pair of boxes for one instant: a native date picker and an `HH:mm` text box that always means
	 * WIB, whatever the browser's own locale or clock format is. `docs/spec-post-editor-v1.md` and
	 * `docs/research-ui-ux-v1.md` §4 settle on this shape over a single `datetime-local` control —
	 * `datetime-local`'s displayed clock format follows the browser's locale (12-hour with AM/PM in
	 * `en-US`), which is exactly the ambiguity a kegiatan's WIB start and end must not carry.
	 *
	 * Posts as two fields, `{name}Date` and `{name}Time`, so a route reading `form.get('startsAtDate')`
	 * and `form.get('startsAtTime')` needs nothing from this component beyond the `name` it was given —
	 * see `src/lib/server/services/post/time.ts`'s `combineCivilDateTime`, which is the other half of
	 * this component's contract: its `TIME_PATTERN` is the same regular expression as this file's own
	 * `pattern` attribute, so a value the browser's own validation would already refuse is refused again
	 * on the server rather than trusted because it arrived as a POST body.
	 *
	 * Holds no state of its own: `dateValue` and `timeValue` are written into the two inputs on every
	 * render, exactly the way every other field on `post-form.svelte` is — see that file's own doc
	 * comment on the `{#key uid}` block for why a field seeded once from a prop and then left alone
	 * would not survive a rejected submission handing back what was typed.
	 */
	interface Props {
		/** Posted as `{name}Date` and `{name}Time`. */
		readonly name: string;
		/** Unique per instance on the page — becomes the two inputs' and the hint's `id`s. */
		readonly id: string;
		/** The label on the date box. */
		readonly dateLabel: string;
		/** The label on the `HH:mm` box. */
		readonly timeLabel: string;
		/** Explains the format and the zone. Shared by both boxes' `aria-describedby`. */
		readonly hint: string;
		/** `YYYY-MM-DD`, or `''` for an empty date box. */
		readonly dateValue: string;
		/** `HH:mm`, or `''` for an empty time box. */
		readonly timeValue: string;
	}

	let { name, id, dateLabel, timeLabel, hint, dateValue, timeValue }: Readonly<Props> = $props();
</script>

<div class="flex flex-1 flex-col gap-1.5">
	<div class="flex gap-2">
		<div class="flex flex-1 flex-col gap-1.5">
			<label class="text-sm font-medium" for="{id}-date">{dateLabel}</label>
			<input
				id="{id}-date"
				name="{name}Date"
				type="date"
				value={dateValue}
				aria-describedby="{id}-hint"
				class="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>
		<div class="flex w-28 flex-col gap-1.5">
			<label class="text-sm font-medium" for="{id}-time">{timeLabel}</label>
			<input
				id="{id}-time"
				name="{name}Time"
				type="text"
				inputmode="numeric"
				placeholder="HH:mm"
				maxlength="5"
				pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
				value={timeValue}
				aria-describedby="{id}-hint"
				class="h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>
	</div>
	<p class="text-xs text-muted-foreground" id="{id}-hint">{hint}</p>
</div>
