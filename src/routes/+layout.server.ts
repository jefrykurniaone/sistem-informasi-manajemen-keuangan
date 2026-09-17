import { database } from '$lib/server/db';
import { ACTION, isAllowed, rolesOf } from '$lib/server/authz';
import type { LayoutServerLoad } from './$types';

/**
 * What the app shell in `+layout.svelte` needs to decide which menu items to render.
 *
 * **This never decides what a request is allowed to do.** `isAllowed` is the same pure table
 * `src/lib/server/authz.ts` uses inside `requirePermission`, consulted here read-only to choose
 * what a link *shows*; the guard on each page — see `src/routes/(app)/admin/roles/+page.server.ts`
 * — remains the only place a request is actually let through or refused. Hiding a menu item is a
 * convenience for someone who could not use it anyway, never the reason it was refused.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	const { user } = locals;
	if (!user) {
		return { signedIn: false, canManageRoles: false };
	}

	const roles = await rolesOf(database(), user.id);
	return {
		signedIn: true,
		canManageRoles: isAllowed(roles, ACTION.manageRoles)
	};
};
