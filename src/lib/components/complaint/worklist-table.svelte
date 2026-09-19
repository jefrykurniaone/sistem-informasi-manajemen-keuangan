<script lang="ts" module>
	import type { ComplaintStatus } from '$lib/server/db/schema/complaint';

	/** One row this table renders. A plain object rather than `ComplaintWithAge` itself, because the
	 * server load already reduced the age to whole days and dropped everything the row does not use. */
	export interface WorklistRow {
		readonly id: string;
		readonly title: string;
		readonly category: string;
		readonly status: ComplaintStatus;
		readonly ageDays: number;
		readonly stale: boolean;
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The admin work queue's table: one row per open Keluhan, longest wait first — the order
	 * `+page.server.ts` already sorted them in, never re-sorted here. A `stale` row is the one this
	 * whole screen exists for, so it carries a visibly different border and its own badge rather than
	 * a colour alone, which `prefers-contrast` and colour-blind readers would both lose.
	 */
	interface Props {
		readonly rows: readonly WorklistRow[];
	}

	let { rows }: Readonly<Props> = $props();

	/** The label for one of the six statuses. Read from the same functions every Keluhan screen uses. */
	const STATUS_LABEL: Record<ComplaintStatus, () => string> = {
		new: m.adminComplaints_status_new,
		reviewing: m.adminComplaints_status_reviewing,
		working: m.adminComplaints_status_working,
		resolved: m.adminComplaints_status_resolved,
		rejected: m.adminComplaints_status_rejected,
		withdrawn: m.adminComplaints_status_withdrawn
	};
</script>

<div class="flex flex-col gap-3">
	{#each rows as row (row.id)}
		<a
			href={resolve(`/admin/complaints/${row.id}`)}
			class="flex min-h-11 flex-col gap-2 rounded-lg border p-4 {row.stale
				? 'border-destructive'
				: 'border-border'}"
		>
			<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span class="rounded-md border border-border px-2 py-1">
					{STATUS_LABEL[row.status]?.() ?? row.status}
				</span>
				<span class="rounded-md border border-border px-2 py-1">{row.category}</span>
				{#if row.stale}
					<span class="rounded-md border border-destructive px-2 py-1 font-medium text-destructive">
						{m.adminComplaints_staleBadge()}
					</span>
				{/if}
			</div>

			<h2 class="font-medium">{row.title}</h2>
			<p class="text-sm text-muted-foreground">
				{m.adminComplaints_ageLabel({ days: row.ageDays })}
			</p>
		</a>
	{/each}

	{#if rows.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminComplaints_empty()}</p>
	{/if}
</div>
