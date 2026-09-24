<script lang="ts">
	import ExemptionForm from '$lib/components/dues/exemption-form.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** An exemption's stretch of days, read as one line. */
	function period(startedOn: string, endedOn: string | null): string {
		if (endedOn === null) {
			return m.adminExemptions_periodOpen({ startedOn });
		}
		return m.adminExemptions_periodScheduled({ startedOn, endedOn });
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminExemptions_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminExemptions_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminExemptions_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<ExemptionForm units={data.units} />

	<section class="flex flex-col gap-4">
		<h2 class="text-lg font-semibold">{m.adminExemptions_listHeading()}</h2>

		{#each data.exemptions as exemption (exemption.exemptionId)}
			<article class="flex flex-col gap-2 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="font-medium">
						{m.unit_label({ block: exemption.block, number: exemption.number })}
					</span>
				</div>

				<p class="text-sm text-muted-foreground">
					{period(exemption.startedOn, exemption.endedOn)}
				</p>

				<p class="text-sm">{exemption.reason}</p>

				<form method="POST" action="?/end" class="flex flex-col gap-3 sm:flex-row sm:items-end">
					<input type="hidden" name="exemptionId" value={exemption.exemptionId} />
					<div class="flex flex-1 flex-col gap-1.5">
						<label class="text-sm font-medium" for="exemption-end-{exemption.exemptionId}-{uid}">
							{m.adminExemptions_endInputLabel()}
						</label>
						<input
							id="exemption-end-{exemption.exemptionId}-{uid}"
							name="endedOn"
							type="date"
							required
							class="h-11 rounded-md border border-border bg-background px-3 text-sm"
						/>
					</div>
					<Button type="submit" variant="outline" class="h-11 self-end">
						{m.adminExemptions_endSubmit()}
					</Button>
				</form>
			</article>
		{/each}

		{#if data.exemptions.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminExemptions_empty()}</p>
		{/if}
	</section>
</main>
