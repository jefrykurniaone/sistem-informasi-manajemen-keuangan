<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import { formatDay } from '$lib/time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** A day a person reads, out of the instant the row stores. */
	function asDay(instant: Date): string {
		return formatDay(instant);
	}

	/** The one label each status renders as. */
	function statusLabel(status: 'pending' | 'expired' | 'used'): string {
		if (status === 'used') {
			return m.adminInvitations_statusUsed();
		}
		return status === 'expired'
			? m.adminInvitations_statusExpired()
			: m.adminInvitations_statusPending();
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminInvitations_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminInvitations_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminInvitations_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="font-medium">{m.adminInvitations_singleHeading()}</h2>
		<form method="POST" action="?/send" class="flex flex-col gap-3 sm:flex-row sm:items-end">
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="invitation-unit-{uid}">
					{m.adminInvitations_unitLabel()}
				</label>
				<select
					id="invitation-unit-{uid}"
					name="unitId"
					required
					class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				>
					{#each data.units as unit (unit.id)}
						<option value={unit.id}>
							{m.unit_label({ block: unit.block, number: unit.number })}
						</option>
					{/each}
				</select>
			</div>
			<div class="flex flex-1 flex-col gap-1.5">
				<label class="text-sm font-medium" for="invitation-email-{uid}">
					{m.adminInvitations_emailLabel()}
				</label>
				<input
					id="invitation-email-{uid}"
					name="email"
					type="email"
					required
					class="h-9 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>
			<Button type="submit">{m.adminInvitations_sendSubmit()}</Button>
		</form>
	</section>

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="font-medium">{m.adminInvitations_bulkHeading()}</h2>
		<p class="text-sm text-muted-foreground">{m.adminInvitations_bulkDescription()}</p>
		<form method="POST" action="?/sendMany" class="flex flex-col gap-3">
			{#each data.units as unit (unit.id)}
				<div class="flex items-center gap-3">
					<input type="hidden" name="unitId" value={unit.id} />
					<label class="w-32 shrink-0 text-sm font-medium" for="bulk-email-{unit.id}-{uid}">
						{m.unit_label({ block: unit.block, number: unit.number })}
					</label>
					<input
						id="bulk-email-{unit.id}-{uid}"
						name="email"
						type="email"
						placeholder={m.adminInvitations_emailLabel()}
						class="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm"
					/>
				</div>
			{/each}
			<div>
				<Button type="submit">{m.adminInvitations_bulkSubmit()}</Button>
			</div>
		</form>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.adminInvitations_listHeading()}</h2>
		{#each data.invitations as invitation (invitation.invitationId)}
			<article class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="font-medium">{invitation.email}</span>
					<span class="text-sm text-muted-foreground">{statusLabel(invitation.status)}</span>
				</div>
				<p class="text-sm text-muted-foreground">
					{m.unit_label({ block: invitation.block, number: invitation.number })} ·
					{m.adminInvitations_validUntil({ date: asDay(invitation.expiresAt) })}
				</p>
				{#if invitation.status !== 'used'}
					<form method="POST" action="?/resend">
						<input type="hidden" name="invitationId" value={invitation.invitationId} />
						<Button type="submit" variant="outline">{m.adminInvitations_resendSubmit()}</Button>
					</form>
				{/if}
			</article>
		{/each}

		{#if data.invitations.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminInvitations_empty()}</p>
		{/if}
	</section>
</main>
