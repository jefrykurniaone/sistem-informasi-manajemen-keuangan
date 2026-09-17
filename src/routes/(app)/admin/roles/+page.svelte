<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** How a role reads in Indonesian, on this page only — the name in code stays English. */
	const ROLE_LABEL: Record<string, string> = {
		resident: 'Warga',
		admin: 'Admin',
		superuser: 'Superuser'
	};
</script>

<svelte:head>
	<title>Kelola peran — Komplek</title>
</svelte:head>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight">Kelola peran</h1>
		<p class="text-sm text-muted-foreground">
			Tambah atau cabut peran seorang pengguna. Setiap perubahan tercatat di catatan audit.
		</p>
	</header>

	{#if form?.message}
		<p class="rounded-md border border-border px-3 py-2 text-sm" role="status">{form.message}</p>
	{/if}

	<div class="flex flex-col gap-4">
		{#each data.users as entry (entry.userId)}
			<section class="flex flex-col gap-3 rounded-lg border border-border p-4">
				<div class="flex flex-col">
					<span class="font-medium">{entry.name}</span>
					<span class="text-sm text-muted-foreground">{entry.email}</span>
				</div>

				<ul class="flex flex-wrap gap-2">
					{#each data.roles as role (role)}
						{@const held = entry.roles.includes(role)}
						<li>
							<form method="POST" action={held ? '?/revoke' : '?/grant'}>
								<input type="hidden" name="targetUserId" value={entry.userId} />
								<input type="hidden" name="role" value={role} />
								<Button type="submit" variant={held ? 'default' : 'outline'} size="sm">
									{ROLE_LABEL[role] ?? role}
									{held ? '(cabut)' : '(beri)'}
								</Button>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{/each}

		{#if data.users.length === 0}
			<p class="text-sm text-muted-foreground">Belum ada pengguna yang terdaftar.</p>
		{/if}
	</div>
</main>
