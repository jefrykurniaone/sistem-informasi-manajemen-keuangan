<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The "grant an exemption" form on `src/routes/(app)/admin/exemptions/+page.svelte`. It posts to
	 * that route's own `?/grant` action and holds no logic of its own — only the fields that action
	 * reads. Same shape as `src/lib/components/dues/dues-rate-form.svelte`: the page above it prints
	 * the last submission's message once, rather than this component repeating it.
	 *
	 * **The unit list comes in as a prop.** Nothing under `$lib/server` may be imported from a
	 * component — that boundary is SvelteKit's own — so the picker's options are read in
	 * `+page.server.ts` and handed down.
	 */
	interface Props {
		/** Every unit the picker offers, already ordered by block then number. */
		readonly units: readonly { id: string; block: string; number: string }[];
	}

	let { units }: Readonly<Props> = $props();

	const uid = $props.id();
</script>

<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
	<h2 class="text-lg font-semibold">{m.adminExemptions_grantHeading()}</h2>

	{#if units.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminExemptions_noUnits()}</p>
	{:else}
		<form method="POST" action="?/grant" class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="exemption-form-unit-{uid}">
					{m.adminExemptions_unitLabel()}
				</label>
				<select
					id="exemption-form-unit-{uid}"
					name="unitId"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					<option value="">{m.adminExemptions_unitPlaceholder()}</option>
					{#each units as unit (unit.id)}
						<option value={unit.id}>{unit.block} — {unit.number}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="exemption-form-started-on-{uid}">
					{m.adminExemptions_startedOnLabel()}
				</label>
				<input
					id="exemption-form-started-on-{uid}"
					name="startedOn"
					type="date"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="exemption-form-ended-on-{uid}">
					{m.adminExemptions_endedOnLabel()}
				</label>
				<input
					id="exemption-form-ended-on-{uid}"
					name="endedOn"
					type="date"
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="exemption-form-reason-{uid}">
					{m.adminExemptions_reasonLabel()}
				</label>
				<textarea
					id="exemption-form-reason-{uid}"
					name="reason"
					required
					placeholder={m.adminExemptions_reasonPlaceholder()}
					class="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
				></textarea>
			</div>

			<Button type="submit" class="h-11 self-start">{m.adminExemptions_grantSubmit()}</Button>
		</form>
	{/if}
</section>
