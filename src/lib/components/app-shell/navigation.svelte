<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The primary navigation. It only ever renders what `+layout.server.ts` already decided a
	 * visitor may see — `signedIn` and `canManageRoles` come from `isAllowed()` against the same
	 * table `requirePermission` uses, so a link never claims a right the guard would refuse. Showing
	 * a link is not authorization: each page behind it still checks for itself.
	 */
	interface Props {
		readonly signedIn: boolean;
		readonly canManageRoles: boolean;
	}

	let { signedIn, canManageRoles }: Readonly<Props> = $props();
</script>

<nav aria-label={m.appShell_navLabel()} class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
	<a class="rounded-sm px-1 py-2 underline-offset-4 hover:underline" href={resolve('/')}>
		{m.appShell_navHome()}
	</a>

	{#if signedIn}
		{#if canManageRoles}
			<a
				class="rounded-sm px-1 py-2 underline-offset-4 hover:underline"
				href={resolve('/admin/roles')}
			>
				{m.appShell_navManageRoles()}
			</a>
		{/if}
		<form method="POST" action={resolve('/logout')}>
			<button type="submit" class="rounded-sm px-1 py-2 underline-offset-4 hover:underline">
				{m.appShell_navLogout()}
			</button>
		</form>
	{:else}
		<a class="rounded-sm px-1 py-2 underline-offset-4 hover:underline" href={resolve('/login')}>
			{m.appShell_navLogin()}
		</a>
		<a class="rounded-sm px-1 py-2 underline-offset-4 hover:underline" href={resolve('/register')}>
			{m.appShell_navRegister()}
		</a>
	{/if}
</nav>
