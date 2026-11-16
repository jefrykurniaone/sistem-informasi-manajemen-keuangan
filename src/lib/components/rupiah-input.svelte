<script lang="ts">
	import { untrack } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import * as m from '#lib/paraglide/messages.js';
	import {
		caretAfterDigits,
		countDigits,
		editRupiahField,
		readRupiahField
	} from '#lib/rupiah-field.ts';
	import { cn } from '#lib/utils.ts';

	/**
	 * A nominal field: an amount is typed as digits and read back with thousands separators, so
	 * `1500000` is on screen as `1.500.000` behind an `Rp` the person never has to type.
	 *
	 * ## It never turns text into a different number (#340)
	 *
	 * What the field makes of its text is `src/lib/rupiah-field.ts`, which reads it with the grammar
	 * of `parseRupiah` (`matchRupiahText` in `src/lib/money.ts`) minus the minus sign:
	 *
	 * - **An amount** (`1500000`, `150.000`, `1 500 000`, `Rp 1.500.000`) is shown grouped and posted
	 *   as plain digits.
	 * - **Anything else** (`12,5`, `1.500.000,00`, `12.5`, `150rb`, `-150.000`) is left on screen
	 *   exactly as typed, posted exactly as typed, and refused: the shared sentence
	 *   `rupiahInput_invalid` under the field and the browser's own validation stopping the form. This
	 *   field used to keep the digits and drop the rest, which recorded `12,5` as Rp 125.
	 * - **Nothing** stays nothing rather than becoming `0`, so `required` still means "fill this in".
	 *
	 * ## What the server receives
	 *
	 * A hidden field named `name`. For an amount it holds plain digits with no separator, so no server
	 * action has to learn about separators: every one of them turns the field into money through
	 * `parseRupiah`. For refused text it holds that text untouched, so a form whose browser check was
	 * skipped (`novalidate`, a script) reaches `parseRupiah` with the very text the person saw, is
	 * refused there with the route's own sentence, and comes back refilled with that text, not with
	 * the digits of it. The visible input deliberately has **no** `name`.
	 *
	 * With JavaScript turned off the visible input cannot change what is posted, because nothing
	 * copies it into the hidden field. A form using this component therefore needs JavaScript to accept
	 * a *new* amount; the amount it was rendered with still posts.
	 *
	 * ## When the sentence shows, and what stops the form
	 *
	 * Two things follow the text, and they are deliberately not the same thing:
	 *
	 * - **`setCustomValidity`** follows it at once. Refused text makes the visible input invalid in the
	 *   browser's constraint validation, so the form does not submit while it holds one, whichever
	 *   button or key submits it.
	 * - **The sentence** (and `aria-invalid="true"`, and the red border) shows when the field is left
	 *   (`blur`) or when a submission is stopped on it (`invalid`), and goes away as soon as the text
	 *   is an amount again or is emptied. It does not show while somebody is typing, because typing
	 *   `150.000` by hand passes through `150.` and `150.00`, which are not amounts yet: a sentence that
	 *   flickered at every keystroke would scold a person typing a perfectly good number. Once it
	 *   shows, it stays until the text is put right, rather than vanishing at the next keystroke.
	 * - **Text the server sent back** (a rejected submission refilling the field) shows the sentence
	 *   straight away when it is refused text. Nobody is typing it.
	 *
	 * The sentence sits under the field, after the bordered box, and its id joins whatever
	 * `aria-describedby` the form passed (a hint under the field) rather than replacing it.
	 *
	 * ## Why `type="text"`
	 *
	 * Not a style preference. `setSelectionRange()` works only on `text`, `password`, `search`, `tel`
	 * and `url` inputs and throws `InvalidStateError` on `type="number"`, so caret restoration is not
	 * merely awkward there but impossible, and a `number` input also changes a money amount when the
	 * mouse wheel turns over it. See `docs/research-ui-ux-v1.md` §5. `inputmode="numeric"` is what asks
	 * a phone for the numeric keyboard instead.
	 *
	 * ## Typing, pasting, and the caret
	 *
	 * Every `input` event (a keystroke, a paste, a drop, an undo) is read the same way, by
	 * `editRupiahField`. When the result is an amount, it is regrouped and the caret goes back where
	 * the same number of digits stand to its left, so typing `0` with the caret after the third digit
	 * of `1.500` leaves the caret after the fourth digit of `15.000`. When the result is refused text,
	 * neither the text nor the caret is touched.
	 *
	 * One behaviour follows from that and is deliberate: pressing Backspace with the caret directly
	 * after a separator removes the separator, which is then put straight back, so the value does not
	 * change and the caret stays before it. Pressing Backspace once more deletes a digit. Reaching past
	 * the separator to delete the digit behind it would mean guessing at an intent the keystroke does
	 * not carry, and silently deleting a digit the person did not aim at is the worse of the two.
	 *
	 * Anything not named below (`autofocus`, `onfocus`, `data-*`) passes through to the visible input.
	 * `aria-invalid`, `aria-describedby`, `onblur` and `oninvalid` pass through too, merged with the
	 * field's own: a passed `aria-invalid` holds while the field has no refusal of its own to show, a
	 * passed description is kept beside the sentence's, and a passed handler runs after the field's.
	 * The attributes that make this control what it is (`type`, `inputmode`, `value`, `oninput`) are
	 * written after the spread and so cannot be overridden from outside.
	 */
	interface Props extends Omit<HTMLInputAttributes, 'name' | 'type' | 'value'> {
		/** The form field name. The hidden input carries it; the visible input has none. */
		readonly name: string;
		/**
		 * The amount, as whole rupiah or as text. Bindable: bind it when something other than typing
		 * sets the amount (ticking a Tagihan in `payment-form.svelte` does) and the field reformats and
		 * the hidden input follows. Read back, it is what the hidden input posts: plain digits for an
		 * amount, the text untouched for refused text, `''` for an empty field.
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
		'aria-invalid': passedAriaInvalid,
		onblur,
		oninvalid,
		class: className,
		...restProps
	}: Props = $props();

	const uid = $props.id();

	/** The id of the sentence under the field, unique to this instance. */
	const messageId = `${uid}-rupiah-invalid`;

	/** What the field makes of its current value: shown, posted, and whether it is refused. */
	const field = $derived(readRupiahField(String(value ?? '')));

	/**
	 * Whether the sentence has been asked for: by leaving the field, by a stopped submission, or by
	 * refused text arriving from the server. Read through `refusalShown`, never on its own.
	 */
	let messageRequested = $state(untrack(() => field.kind === 'invalid'));

	/** Whether the sentence, `aria-invalid` and the red border are on screen now. */
	const refusalShown = $derived(messageRequested && field.kind === 'invalid');

	/** The passed description, then the sentence's while it shows. */
	const describedByIds = $derived(
		[describedBy, refusalShown ? messageId : undefined].filter(Boolean).join(' ') || undefined
	);

	/** The visible input, for `setCustomValidity`. */
	let input = $state<HTMLInputElement>();

	// The browser's constraint validation follows the text at once, whether or not the sentence
	// shows yet: refused text stops the form from submitting, and an amount or an empty field (left
	// to `required`) clears the refusal.
	$effect(() => {
		input?.setCustomValidity(field.kind === 'invalid' ? m.rupiahInput_invalid() : '');
	});

	/**
	 * Reads the text after every change and, for an amount, writes the grouped result to the element
	 * itself rather than waiting for the render that `value` triggers.
	 *
	 * Both halves of that matter. Writing it here is what puts a dropped separator straight back
	 * (Backspace after a `.`), because the digits, and so `value`, are unchanged, and an unchanged
	 * value is a render Svelte correctly skips. And the caret has to be restored in the same
	 * synchronous turn as the write, or the browser has already put it at the end by the time
	 * anything else runs. Refused text is neither written nor has its caret moved: it is already
	 * exactly what the element shows.
	 */
	function onInput(event: Event & { currentTarget: HTMLInputElement }): void {
		const element = event.currentTarget;
		const typed = element.value;
		const caret = element.selectionStart ?? typed.length;

		const next = editRupiahField(field.display, typed);
		value = next.posted;
		if (next.kind === 'invalid') {
			return;
		}

		messageRequested = false;
		element.value = next.display;
		const nextCaret = caretAfterDigits(next.display, countDigits(typed.slice(0, caret)));
		element.setSelectionRange(nextCaret, nextCaret);
	}

	/** Leaving the field is when refused text is pointed at. */
	function onBlur(event: FocusEvent & { currentTarget: EventTarget & HTMLInputElement }): void {
		messageRequested = field.kind === 'invalid';
		onblur?.(event);
	}

	/** So is a submission the browser stopped on this field. */
	function onInvalid(event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
		messageRequested = field.kind === 'invalid';
		oninvalid?.(event);
	}
</script>

<div
	class={cn(
		'flex h-11 items-center rounded-md border border-border bg-background text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
		refusalShown &&
			'border-destructive focus-within:border-destructive focus-within:ring-destructive/20',
		className
	)}
>
	<span class="pr-1.5 pl-3 text-muted-foreground select-none">Rp</span>
	<input
		{...restProps}
		bind:this={input}
		{id}
		type="text"
		inputmode="numeric"
		autocomplete="off"
		{required}
		{disabled}
		{placeholder}
		aria-invalid={refusalShown ? 'true' : passedAriaInvalid}
		aria-describedby={describedByIds}
		value={field.display}
		oninput={onInput}
		onblur={onBlur}
		oninvalid={onInvalid}
		class="h-full w-full rounded-md bg-transparent pr-3 text-sm outline-none"
	/>
	<input type="hidden" {name} {disabled} value={field.posted} />
</div>
{#if refusalShown}
	<p id={messageId} class="text-sm font-medium text-destructive">{m.rupiahInput_invalid()}</p>
{/if}
