<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * Label and description per kind, on this page only — the kind string itself stays the value
	 * `$lib/server/services/subscription/kinds.ts` names it, the same split
	 * `(app)/admin/roles/+page.svelte`'s `ROLE_LABEL` makes for role names.
	 */
	const KIND_LABEL: Record<string, () => string> = {
		'invoice-issued': m.profile_notifications_kind_invoiceIssued_label,
		'payment-verified': m.profile_notifications_kind_paymentVerified_label,
		'own-complaint-status-changed': m.profile_notifications_kind_ownComplaintStatusChanged_label,
		'monthly-report': m.profile_notifications_kind_monthlyReport_label,
		'new-post': m.profile_notifications_kind_newPost_label
	};

	const KIND_DESCRIPTION: Record<string, () => string> = {
		'invoice-issued': m.profile_notifications_kind_invoiceIssued_description,
		'payment-verified': m.profile_notifications_kind_paymentVerified_description,
		'own-complaint-status-changed':
			m.profile_notifications_kind_ownComplaintStatusChanged_description,
		'monthly-report': m.profile_notifications_kind_monthlyReport_description,
		'new-post': m.profile_notifications_kind_newPost_description
	};
</script>

<svelte:head>
	<title>{m.profile_notifications_pageTitle()} — Komplek</title>
</svelte:head>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.profile_notifications_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.profile_notifications_subheading()}</p>
	</header>

	{#if !data.residentId}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.profile_noRecordTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.profile_noRecordBody()}</p>
		</section>
	{:else}
		{#if form?.message}
			<p
				class="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
				role="alert"
			>
				{form.message}
			</p>
		{:else if form?.saved}
			<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
				{m.profile_notifications_savedMessage()}
			</p>
		{/if}

		<ul class="flex flex-col gap-3">
			{#each data.preferences as preference (preference.kind)}
				<li class="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
					<div class="flex flex-col gap-1">
						<span class="font-medium">{KIND_LABEL[preference.kind]?.() ?? preference.kind}</span>
						<span class="text-sm text-muted-foreground">
							{KIND_DESCRIPTION[preference.kind]?.() ?? ''}
						</span>
					</div>

					{#if preference.mandatory}
						<span
							class="flex h-11 shrink-0 items-center rounded-md border border-border px-3 text-sm text-muted-foreground"
						>
							{m.profile_notifications_mandatoryBadge()}
						</span>
					{:else}
						<form method="POST" action="?/update">
							<input type="hidden" name="residentId" value={data.residentId} />
							<input type="hidden" name="kind" value={preference.kind} />
							<input type="hidden" name="enabled" value={(!preference.enabled).toString()} />
							<Button
								type="submit"
								variant={preference.enabled ? 'default' : 'outline'}
								class="h-11 min-w-24"
							>
								{preference.enabled
									? m.profile_notifications_onLabel()
									: m.profile_notifications_offLabel()}
							</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>

		<a class="text-sm underline underline-offset-4" href={resolve('/profile')}>
			{m.profile_notifications_backLink()}
		</a>
	{/if}
</main>
