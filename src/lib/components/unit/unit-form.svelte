<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The "add a unit" form on `src/routes/(app)/admin/units/+page.svelte`. It posts to that route's
	 * own `?/create` action — this component holds no logic of its own, only the two fields the
	 * action reads (`block`, `number`) and the message that action's last result carried, if any.
	 */
	interface Props {
		/** The message from the last `?/create` submission, shown as a status line above the fields. */
		readonly formMessage?: string;
	}

	let { formMessage }: Readonly<Props> = $props();

	const uid = $props.id();
</script>

<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
	<h2 class="text-lg font-semibold">{m.adminUnits_addHeading()}</h2>

	{#if formMessage}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{formMessage}</p>
	{/if}

	<form method="POST" action="?/create" class="flex flex-col gap-3 sm:flex-row sm:items-end">
		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="unit-form-block-{uid}">
				{m.adminUnits_blockLabel()}
			</label>
			<input
				id="unit-form-block-{uid}"
				name="block"
				type="text"
				required
				placeholder={m.adminUnits_blockPlaceholder()}
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>
		<div class="flex flex-1 flex-col gap-1">
			<label class="text-sm font-medium" for="unit-form-number-{uid}">
				{m.adminUnits_numberLabel()}
			</label>
			<input
				id="unit-form-number-{uid}"
				name="number"
				type="text"
				required
				placeholder={m.adminUnits_numberPlaceholder()}
				class="h-9 rounded-md border border-border bg-background px-3 text-sm"
			/>
		</div>
		<Button type="submit">{m.adminUnits_addSubmit()}</Button>
	</form>
</section>
