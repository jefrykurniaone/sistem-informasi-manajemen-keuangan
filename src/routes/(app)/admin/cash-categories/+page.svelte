<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { pageTitle } from '$lib/complex-name';
	import * as m from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const uid = $props.id();

	/** The label one category type renders as. */
	function typeLabel(type: string): string {
		if (type === 'income') {
			return m.adminCashCategories_typeIncome();
		}
		return m.adminCashCategories_typeExpense();
	}

	/** The label one active flag renders as. */
	function statusLabel(isActive: boolean): string {
		if (isActive) {
			return m.adminCashCategories_statusActive();
		}
		return m.adminCashCategories_statusInactive();
	}
</script>

<svelte:head>
	<title>{pageTitle(m.adminCashCategories_pageTitle())}</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">{m.adminCashCategories_heading()}</h1>
		<p class="text-sm text-muted-foreground">{m.adminCashCategories_description()}</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<h2 class="font-medium">{m.adminCashCategories_addHeading()}</h2>
		<form method="POST" action="?/create" class="flex flex-col gap-3 sm:flex-row sm:items-end">
			<div class="flex flex-1 flex-col gap-1.5">
				<label class="text-sm font-medium" for="cash-category-new-name-{uid}">
					{m.adminCashCategories_nameLabel()}
				</label>
				<input
					id="cash-category-new-name-{uid}"
					name="name"
					type="text"
					required
					maxlength="80"
					placeholder={m.adminCashCategories_namePlaceholder()}
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<label class="text-sm font-medium" for="cash-category-new-type-{uid}">
					{m.adminCashCategories_typeLabel()}
				</label>
				<select
					id="cash-category-new-type-{uid}"
					name="type"
					class="h-11 rounded-md border border-border bg-background px-3 text-sm"
				>
					<option value="income">{m.adminCashCategories_typeIncome()}</option>
					<option value="expense">{m.adminCashCategories_typeExpense()}</option>
				</select>
			</div>
			<Button type="submit" class="h-11">{m.adminCashCategories_addSubmit()}</Button>
		</form>
	</section>

	<section class="flex flex-col gap-3">
		<h2 class="font-medium">{m.adminCashCategories_listHeading()}</h2>

		{#each data.categories as category (category.id)}
			<article class="flex flex-col gap-3 rounded-lg border border-border p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="font-medium">{category.name}</span>
					<span class="text-sm text-muted-foreground">
						{typeLabel(category.type)} · {statusLabel(category.isActive)}
					</span>
				</div>

				{#if category.isSystem}
					<p class="text-sm text-muted-foreground">
						{m.adminCashCategories_systemLabel()}. {m.adminCashCategories_systemNote()}
					</p>
				{:else}
					{#if !category.isActive}
						<p class="text-sm text-muted-foreground">
							{m.adminCashCategories_inactiveNote()}
						</p>
					{/if}

					<form
						method="POST"
						action="?/update"
						class="flex flex-col gap-3 sm:flex-row sm:items-end"
					>
						<input type="hidden" name="categoryId" value={category.id} />
						<div class="flex flex-1 flex-col gap-1.5">
							<label class="text-sm font-medium" for="cash-category-name-{category.id}-{uid}">
								{m.adminCashCategories_nameLabel()}
							</label>
							<input
								id="cash-category-name-{category.id}-{uid}"
								name="name"
								type="text"
								required
								maxlength="80"
								value={category.name}
								placeholder={m.adminCashCategories_namePlaceholder()}
								class="h-11 rounded-md border border-border bg-background px-3 text-sm"
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<label class="text-sm font-medium" for="cash-category-type-{category.id}-{uid}">
								{m.adminCashCategories_typeLabel()}
							</label>
							<select
								id="cash-category-type-{category.id}-{uid}"
								name="type"
								class="h-11 rounded-md border border-border bg-background px-3 text-sm"
							>
								<option value="income" selected={category.type === 'income'}>
									{m.adminCashCategories_typeIncome()}
								</option>
								<option value="expense" selected={category.type === 'expense'}>
									{m.adminCashCategories_typeExpense()}
								</option>
							</select>
						</div>
						<Button type="submit" variant="outline" class="h-11">
							{m.adminCashCategories_saveSubmit()}
						</Button>
					</form>

					<form method="POST" action={category.isActive ? '?/deactivate' : '?/reactivate'}>
						<input type="hidden" name="categoryId" value={category.id} />
						{#if category.isActive}
							<Button type="submit" variant="destructive" class="h-11">
								{m.adminCashCategories_deactivateSubmit()}
							</Button>
						{:else}
							<Button type="submit" variant="outline" class="h-11">
								{m.adminCashCategories_reactivateSubmit()}
							</Button>
						{/if}
					</form>
				{/if}
			</article>
		{/each}

		{#if data.categories.length === 0}
			<p class="text-sm text-muted-foreground">{m.adminCashCategories_empty()}</p>
		{/if}
	</section>
</main>
