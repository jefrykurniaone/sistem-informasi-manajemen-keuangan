<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatRupiah } from '$lib/money';
	import * as m from '$lib/paraglide/messages.js';
	import type { PaymentStatus } from '$lib/server/db/schema/payment';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * The sentence beside each payment.
	 *
	 * The keys are written out rather than taken from `PAYMENT_STATUS`, because everything under
	 * `$lib/server/` is server-only and this page also runs in the browser — the same split
	 * `status-change-dialog.svelte` already makes, importing the union as a *type* and spelling the
	 * values. The `Record` is exhaustive over that union, so a fourth status — were anybody ever to
	 * add one, which `CONTEXT.md` says there is not — is a type error here before it is a blank badge
	 * on a resident's screen.
	 */
	const STATUS_LABEL: Readonly<Record<PaymentStatus, () => string>> = {
		pending: m.payments_status_pending,
		verified: m.payments_status_verified,
		rejected: m.payments_status_rejected
	};
</script>

<svelte:head>
	<title>{m.payments_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.payments_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.payments_description()}</p>
	</header>

	{#if data.justRecorded}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">
			{m.payments_recordedNotice()}
		</p>
	{/if}

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	{#if data.canRecord}
		<a
			class="flex h-11 items-center text-sm underline underline-offset-4"
			href={resolve('/payments/new')}
		>
			{m.payments_newLink()}
		</a>
	{:else}
		<p class="rounded-md border border-border px-3 py-2 text-sm">{m.payments_noUnit()}</p>
	{/if}

	{#if data.payments.length === 0}
		<section class="flex flex-col gap-2 rounded-lg border border-border p-4">
			<h2 class="font-medium">{m.payments_emptyTitle()}</h2>
			<p class="text-sm text-muted-foreground">{m.payments_emptyBody()}</p>
		</section>
	{:else}
		<ul class="flex flex-col gap-4">
			{#each data.payments as payment (payment.paymentId)}
				<li class="flex flex-col gap-3 rounded-lg border border-border p-4">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<span class="text-lg font-semibold">{formatRupiah(payment.amount)}</span>
						<span class="text-sm text-muted-foreground">
							{STATUS_LABEL[payment.status]()}
						</span>
					</div>

					<p class="text-sm text-muted-foreground">
						{m.payments_rowSummary({
							unit: m.payments_unitName({ block: payment.block, number: payment.number }),
							receivedOn: payment.receivedOn
						})}
					</p>

					{#if payment.rejectionReason}
						<p class="text-sm">
							{m.payments_rejectionReason({ reason: payment.rejectionReason })}
						</p>
					{/if}

					<div class="flex flex-wrap items-center gap-4">
						{#if payment.proofUrl}
							<!--
								`rel="external"` rather than `resolve()`: this href is a signed link the
								`FileStore` port minted, `/files/<key>?expires=…&signature=…`, and it is served by
								a file endpoint rather than by a SvelteKit page — so there is no route id to
								resolve, and a client-side navigation to it would be the wrong thing anyway. The
								same reading `cash-book-table.svelte` already makes of its receipt link.
							-->
							<a
								class="flex h-11 items-center text-sm underline underline-offset-4"
								href={payment.proofUrl}
								target="_blank"
								rel="external noopener"
							>
								{m.payments_proofLink()}
							</a>
						{/if}

						{#if payment.canCancel}
							<form method="POST" action="?/cancel">
								<input type="hidden" name="paymentId" value={payment.paymentId} />
								<Button type="submit" variant="outline" class="h-11">
									{m.payments_cancelButton()}
								</Button>
							</form>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>
