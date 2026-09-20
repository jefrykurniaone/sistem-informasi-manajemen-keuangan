<script lang="ts" module>
	/** Everything that is not a digit, dropped out of whatever was typed or pasted. */
	const NON_DIGIT_PATTERN = /\D/g;

	/** One digit, for walking a formatted string character by character. */
	const DIGIT_PATTERN = /^\d$/;

	/** The digits of `text`, with separators, currency prefix, spaces and letters all dropped. */
	function onlyDigits(text: string): string {
		return text.replaceAll(NON_DIGIT_PATTERN, '');
	}

	/**
	 * The position in `formatted` that has exactly `count` digits to its left.
	 *
	 * This is the whole caret-restoration rule. Counting digits is what makes it survive a separator
	 * appearing or disappearing in the middle of the value: comparing string lengths before and after
	 * formatting puts the caret one character out the moment `1.500` becomes `15.000`, and two out
	 * when a paste adds several separators at once.
	 */
	function caretAfterDigits(formatted: string, count: number): number {
		if (count === 0) {
			return 0;
		}
		let seen = 0;
		let index = 0;
		for (const character of formatted) {
			index += 1;
			if (DIGIT_PATTERN.test(character)) {
				seen += 1;
				if (seen === count) {
					return index;
				}
			}
		}
		return formatted.length;
	}
</script>

<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { groupThousands } from '$lib/money';
	import { cn } from '$lib/utils';

	/**
	 * A nominal field: the amount is typed as bare digits and read back with thousands separators, so
	 * `1500000` is on screen as `1.500.000` behind an `Rp` the person never has to type.
	 *
	 * ## What the server receives
	 *
	 * A hidden field named `name`, holding plain digits with no separator at all. The visible input
	 * deliberately has **no** `name`, so the formatted text is never posted and no server action has to
	 * learn about separators: every one of them already turns the field into money through `parseRupiah`
	 * and keeps doing exactly that. The two inputs are one control, and the hidden one is the value.
	 *
	 * The consequence, stated plainly: with JavaScript turned off the visible input cannot change what
	 * is posted, because nothing copies it into the hidden field. A form using this component therefore
	 * needs JavaScript to accept a *new* amount — the amount it was rendered with still posts. That is
	 * the price of formatting while typing, and `parseRupiah` still refuses anything malformed that
	 * reaches it by another route.
	 *
	 * ## Why `type="text"`
	 *
	 * Not a style preference. `setSelectionRange()` works only on `text`, `password`, `search`, `tel`
	 * and `url` inputs and throws `InvalidStateError` on `type="number"`, so caret restoration is not
	 * merely awkward there but impossible — and a `number` input also changes a money amount when the
	 * mouse wheel turns over it. See `docs/research-ui-ux-v1.md` §5. `inputmode="numeric"` is what asks
	 * a phone for the numeric keyboard instead.
	 *
	 * ## Typing, pasting, and the caret
	 *
	 * Every `input` event — a keystroke, a paste, a drop, an undo — is handled the same way: keep the
	 * digits, drop everything else, regroup, and put the caret back where the same number of digits
	 * stand to its left. So a paste of `Rp 1.500.000` or of ` 1 500 000 ` both settle as `1.500.000`,
	 * and typing `0` with the caret after the third digit of `1.500` leaves the caret after the fourth
	 * digit of `15.000`.
	 *
	 * One behaviour follows from that and is deliberate: pressing Backspace with the caret directly
	 * after a separator removes the separator, which is then put straight back, so the value does not
	 * change and the caret stays before it. Pressing Backspace once more deletes a digit. Reaching past
	 * the separator to delete the digit behind it would mean guessing at an intent the keystroke does
	 * not carry, and silently deleting a digit the person did not aim at is the worse of the two.
	 *
	 * An empty field stays empty rather than becoming `0`, so `required` still means "fill this in".
	 *
	 * Anything not named below — `aria-invalid`, `onblur`, `autofocus` — passes through to the visible
	 * input. The four attributes that make this control what it is (`type`, `inputmode`, `value`,
	 * `oninput`) are written after that spread and so cannot be overridden from outside.
	 */
	interface Props extends Omit<HTMLInputAttributes, 'name' | 'type' | 'value'> {
		/** The form field name. The hidden input carries it; the visible input has none. */
		readonly name: string;
		/**
		 * The amount, as whole rupiah or as the digits of one. Bindable: bind it when something other
		 * than typing sets the amount — ticking a Tagihan in `payment-form.svelte` does — and the field
		 * reformats and the hidden input follows. Read back, it is always plain digits.
		 */
		value?: number | string;
		/** The id the form's `<label for>` points at. Lands on the visible input, never the hidden one. */
		readonly id?: string;
		/** Classes for the bordered wrapper that holds the `Rp` and the input, merged over its own. */
		readonly class?: string;
	}

	let {
		name,
		value = $bindable(''),
		id,
		required,
		disabled,
		placeholder,
		'aria-describedby': describedBy,
		class: className,
		...restProps
	}: Props = $props();

	/** What the hidden field posts: the digits of whatever the value currently is, and nothing else. */
	const digits = $derived(onlyDigits(String(value ?? '')));

	/** What the visible input shows. Empty stays empty so that `required` keeps working. */
	const formatted = $derived(groupThousands(digits));

	/**
	 * Reformats in place after every change, writing the result to the element itself rather than
	 * waiting for the render that `value` triggers.
	 *
	 * Both halves of that matter. Writing it here is what removes a character the value does not
	 * accept — a letter, a comma — because dropping it leaves `formatted` unchanged, and an unchanged
	 * value is a render Svelte correctly skips, which would leave the rejected character on screen.
	 * And the caret has to be restored in the same synchronous turn as the write, or the browser has
	 * already put it at the end by the time anything else runs.
	 */
	function onInput(event: Event & { currentTarget: HTMLInputElement }): void {
		const element = event.currentTarget;
		const typed = element.value;
		const caret = element.selectionStart ?? typed.length;
		const digitsBeforeCaret = onlyDigits(typed.slice(0, caret)).length;

		const nextDigits = onlyDigits(typed);
		const nextFormatted = groupThousands(nextDigits);
		value = nextDigits;
		element.value = nextFormatted;

		const nextCaret = caretAfterDigits(nextFormatted, digitsBeforeCaret);
		element.setSelectionRange(nextCaret, nextCaret);
	}
</script>

<div
	class={cn(
		'flex h-11 items-center rounded-md border border-border bg-background text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
		className
	)}
>
	<span class="pr-1.5 pl-3 text-muted-foreground select-none">Rp</span>
	<input
		{...restProps}
		{id}
		type="text"
		inputmode="numeric"
		autocomplete="off"
		{required}
		{disabled}
		{placeholder}
		aria-describedby={describedBy}
		value={formatted}
		oninput={onInput}
		class="h-full w-full rounded-md bg-transparent pr-3 text-sm outline-none"
	/>
	<input type="hidden" {name} {disabled} value={digits} />
</div>
