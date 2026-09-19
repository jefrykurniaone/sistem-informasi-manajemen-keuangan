<script lang="ts">
	import { resolve } from '$app/paths';
	import PaymentQueueTable from '$lib/components/dues/payment-queue-table.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.adminPayments_pageTitle()}</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminPayments_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminPayments_description()}</p>
	</header>

	<a
		href={resolve('/admin/payments/cash')}
		class="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4"
	>
		{m.adminPayments_cashLink()}
	</a>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<PaymentQueueTable rows={data.payments} />
</main>
