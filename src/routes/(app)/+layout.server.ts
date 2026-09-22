import { redirect } from '@sveltejs/kit';
import { visibleMenu, type MenuGroup } from '$lib/components/app-shell/menu';
import { SIDEBAR_COOKIE_NAME } from '$lib/components/ui/sidebar/constants';
import { database, type Database } from '$lib/server/db';
import { rolesOf } from '$lib/server/authz';
import { ROLE, type Role } from '$lib/server/db/schema/authz';
import { residentProfileForUser } from '$lib/server/services/resident/profile';
import type { LayoutServerLoad } from './$types';

/**
 * Everything the `(app)` group asks once for all of its pages: what the app shell in
 * `+layout.svelte` needs, and whether this account is allowed in here yet.
 *
 * ## The app shell's data
 *
 * Which menu this session may see, and how wide the sidebar was left last time. Both lived in
 * `src/routes/+layout.server.ts` until the shell moved into this group (#170); only this group
 * renders a sidebar, so only this group pays for the roles read behind the menu.
 *
 * **The menu never decides what a request is allowed to do.** `visibleMenu` answers from `isAllowed`,
 * the same pure table `src/lib/server/authz.ts` uses inside `requirePermission`, consulted here
 * read-only to choose what a link *shows*; the guard on each page (see
 * `src/routes/(app)/admin/roles/+page.server.ts`) remains the only place a request is actually let
 * through or refused. Hiding a menu item is a convenience for someone who could not use it anyway,
 * never the reason it was refused. The grouping, the order and the action behind each link live in
 * `src/lib/components/app-shell/menu.ts`, which is also what the unit test exercises.
 *
 * `sidebarOpen` is read here rather than left to the component because the shadcn `Sidebar.Provider`
 * only *writes* the `sidebar_state` cookie: it starts open on every load unless it is told
 * otherwise, so a collapsed sidebar would spring back open on the next request and, worse, flip
 * width one frame after hydration.
 *
 * ## The pending-approval redirect
 *
 * The one place every page of the group asks "is this account allowed in here yet", so that a
 * self-registrant waiting for a superuser sees the page that says so and nothing else (the
 * acceptance criterion "setiap halaman lain menolaknya" in the ticket that added `/pending-approval`).
 *
 * **This is the experience, never the boundary.** A layout `load` does not run for a child page's
 * form action, so a rule written only here would be one POST away from nothing. What actually
 * refuses an unapproved registrant is the service layer: they have no `residents` row, so every
 * Warga service keyed by one answers empty, and they hold only the `resident` role, which no entry
 * in `PERMISSIONS` names. See the doc comment on
 * `src/lib/server/services/registration/index.ts`, and the test that proves it.
 *
 * The redirect is for an account that has no `residents` row **and** is not a pengurus. Both halves
 * are needed:
 *
 * - **No `residents` row** is what "has not been admitted" means. The XLSX import (Template Impor,
 *   #19) writes that row, accepting an invitation (#20) writes it, and approving a registration
 *   writes it; an account that has none has been through none of the three.
 * - **Not holding `admin` or `superuser`** is the exemption, and it is not a convenience. Those
 *   roles are granted by a superuser, which is a stronger admission than a `residents` row, and a
 *   pengurus is routinely an account with no house of their own: the first superuser of an
 *   installation is seeded from outside and has never been a resident of anything. Redirecting them
 *   would lock the admin screens behind a page about somebody else's registration, including the
 *   screen that decides registrations.
 *
 * The roles read that chooses the menu is the same one that answers the exemption, so a request
 * makes it once. It decides what a person *sees*; the guard on each service call remains the only
 * place a request is really let through or refused.
 *
 * `/pending-approval` is excluded by its own path, because it is the page being redirected to. It
 * still renders the shell, with whatever menu the account's roles allow, so the way out stays in
 * reach. `/profile` and `/my-unit` each still carry their own "belum tercatat" state for the
 * pengurus case this guard lets past.
 */

/** Where an account that has not been admitted is sent, and the one path this guard leaves alone. */
const PENDING_APPROVAL_PATH = '/pending-approval';

/** Whether an account holding `roles` still waits for a superuser, per the rule documented above. */
async function awaitsApproval(
	db: Database,
	userId: string,
	roles: ReadonlySet<Role>
): Promise<boolean> {
	if (roles.has(ROLE.admin) || roles.has(ROLE.superuser)) {
		return false;
	}
	return !(await residentProfileForUser(db, userId));
}

export const load: LayoutServerLoad = async ({ cookies, locals, url }) => {
	// The cookie holds "true" or "false"; anything else, including no cookie at all, means a
	// visitor who has never touched the control, and the sidebar starts open for them.
	const sidebarOpen = cookies.get(SIDEBAR_COOKIE_NAME) !== 'false';

	const { user } = locals;
	// Nobody signed in: every page in this group already sends its own visitor to the login page,
	// and answering that question twice in two places is how the two end up disagreeing.
	if (!user) {
		const menu: readonly MenuGroup[] = [];
		return { sidebarOpen, menu };
	}

	const db = database();
	const roles = await rolesOf(db, user.id);
	if (url.pathname !== PENDING_APPROVAL_PATH && (await awaitsApproval(db, user.id, roles))) {
		redirect(303, PENDING_APPROVAL_PATH);
	}

	return { sidebarOpen, menu: visibleMenu(roles) };
};
