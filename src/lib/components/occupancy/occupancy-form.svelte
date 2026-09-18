<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The "record a stay" form on `src/routes/(app)/admin/units/[id]/occupancies/+page.svelte`. It
	 * posts to that route's own `?/record` action — this component holds no logic of its own, only
	 * the four fields the action reads and the message its last result carried, if any. Same shape as
	 * `src/lib/components/unit/unit-form.svelte`, which #17 left behind.
	 *
	 * **The lists come in as props, including the occupancy roles.** Nothing under `$lib/server` may
	 * be imported from a component — that is the boundary SvelteKit enforces — so `OCCUPANCY_ROLES`
	 * is read in `+page.server.ts` and handed down, rather than the two role values being spelled a
	 * second time here where they could quietly drift from the check constraint.
	 *
	 * The controls are 44 pixels tall, not the 36 of the app shell: this is a screen a pengurus fills
	 * in on a phone while standing in front of the house.
	 */
	interface Props {
		/** Everyone who can be attached to a house, already ordered by name. */
		readonly residents: readonly { residentId: string; name: string; email: string }[];
		/** The occupancy roles the schema allows, in the order they should be offered. */
		readonly roles: readonly string[];
		/** The message from the last `?/record` submission, shown as a status line above the fields. */
		readonly formMessage?: string;
	}

	let { residents, roles, formMessage }: Readonly<Props> = $props();

	const uid = $props.id();

	/** Label per occupancy role, on the screen only — the value itself stays what the schema stores. */
	const ROLE_LABEL: Record<string, () => string> = {
		owner: m.adminOccupancies_roleOwner,
		tenant: m.adminOccupancies_roleTenant
	};
</script>

<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
	<h2 class="text-lg font-semibold">{m.adminOccupancies_addHeading()}</h2>

	{#if formMessage}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{formMessage}</p>
	{/if}

	{#if residents.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminOccupancies_noResidents()}</p>
	{:else}
		<form method="POST" action="?/record" class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="occupancy-form-resident-{uid}">
					{m.adminOccupancies_residentLabel()}
				</label>
				<select
					id="occupancy-form-resident-{uid}"
					name="residentId"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					<option value="">{m.adminOccupancies_residentPlaceholder()}</option>
					{#each residents as resident (resident.residentId)}
						<option value={resident.residentId}>{resident.name} — {resident.email}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="occupancy-form-role-{uid}">
					{m.adminOccupancies_roleLabel()}
				</label>
				<select
					id="occupancy-form-role-{uid}"
					name="role"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					{#each roles as role (role)}
						<option value={role}>{ROLE_LABEL[role]?.() ?? role}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="occupancy-form-started-on-{uid}">
					{m.adminOccupancies_startedOnLabel()}
				</label>
				<input
					id="occupancy-form-started-on-{uid}"
					name="startedOn"
					type="date"
					required
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>

			<label
				class="flex h-11 items-center gap-2 text-sm"
				for="occupancy-form-primary-occupant-{uid}"
			>
				<input
					id="occupancy-form-primary-occupant-{uid}"
					name="isPrimaryOccupant"
					type="checkbox"
					value="true"
					class="size-5 rounded border-border"
				/>
				{m.adminOccupancies_primaryLabel()}
			</label>

			<Button type="submit" class="h-11">{m.adminOccupancies_addSubmit()}</Button>
		</form>
	{/if}
</section>
