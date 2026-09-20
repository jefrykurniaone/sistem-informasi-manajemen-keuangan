import { visibleMenu, type MenuGroup } from '$lib/components/app-shell/menu';
import { rolesOf } from '$lib/server/authz';
import { SIDEBAR_COOKIE_NAME } from '$lib/components/ui/sidebar/constants';
import { database } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

/**
 * What the app shell in `+layout.svelte` needs: whether there is a session, which menu that
 * session may see, and how wide the sidebar was left last time.
 *
 * **This never decides what a request is allowed to do.** `visibleMenu` answers from `isAllowed`,
 * the same pure table `src/lib/server/authz.ts` uses inside `requirePermission`, consulted here
 * read-only to choose what a link *shows*; the guard on each page — see
 * `src/routes/(app)/admin/roles/+page.server.ts` — remains the only place a request is actually let
 * through or refused. Hiding a menu item is a convenience for someone who could not use it anyway,
 * never the reason it was refused.
 *
 * One `rolesOf` read answers the whole menu. It replaced the twenty `can*` booleans this file used
 * to compute one at a time: the grouping, the order and the action behind each link now live in
 * `src/lib/components/app-shell/menu.ts`, which is also what the unit test exercises.
 *
 * `sidebarOpen` is read here rather than left to the component because the shadcn `Sidebar.Provider`
 * only *writes* the `sidebar_state` cookie — it starts open on every load unless it is told
 * otherwise, so a collapsed sidebar would spring back open on the next request and, worse, flip
 * width one frame after hydration.
 */
export const load: LayoutServerLoad = async ({ cookies, locals }) => {
	// The cookie holds "true" or "false"; anything else, including no cookie at all, means a
	// visitor who has never touched the control, and the sidebar starts open for them.
	const sidebarOpen = cookies.get(SIDEBAR_COOKIE_NAME) !== 'false';

	const { user } = locals;
	if (!user) {
		const menu: readonly MenuGroup[] = [];
		return { signedIn: false, sidebarOpen, menu };
	}

	const roles = await rolesOf(database(), user.id);
	return { signedIn: true, sidebarOpen, menu: visibleMenu(roles) };
};
