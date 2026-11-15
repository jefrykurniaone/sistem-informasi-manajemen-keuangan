import type { Cookies } from '@sveltejs/kit';
import { visibleMenu, type MenuGroup } from '#lib/components/app-shell/menu.ts';
import { SIDEBAR_COOKIE_NAME } from '#lib/components/ui/sidebar/constants.ts';
import { database, type Database } from '#lib/server/db/index.ts';
import { rolesOf } from '#lib/server/authz.ts';
import { ROLE, type Role } from '#lib/server/db/schema/authz.ts';
import { residentProfileForUser } from '#lib/server/services/resident/profile.ts';

/**
 * What the app shell needs from the server, and the one rule that says who is let into it.
 *
 * Two layouts render the shell, `src/routes/(app)/+layout.svelte` for every page of the
 * application and `src/routes/(public)/posts/+layout.svelte` for the announcement board and a
 * Post, but only for a signed-in account that is let in. Both ask this module, so "who gets the
 * shell" has one answer, not two that can drift (#319, spec `papan-pengumuman-v1`).
 *
 * ## The shell's data
 *
 * Which menu this session may see, and how wide the sidebar was left last time.
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
 * ## Who is let in
 *
 * A self-registrant waiting for a superuser has not been admitted yet, and `awaitsApproval` is the
 * rule for that. The `(app)` layout turns it into a redirect to `/pending-approval`; the
 * announcement board, which is open to everyone, turns it into the light header instead of the
 * shell. Nobody signed in is in neither case: the `(app)` pages send them to `/login` themselves,
 * and the board gives them the light header.
 *
 * **This is the experience, never the boundary.** A layout `load` does not run for a child page's
 * form action, so a rule written only in a layout would be one POST away from nothing. What actually
 * refuses an unapproved registrant is the service layer: they have no `residents` row, so every
 * Warga service keyed by one answers empty, and they hold only the `resident` role, which no entry
 * in `PERMISSIONS` names. See the doc comment on
 * `src/lib/server/services/registration/index.ts`, and the test that proves it.
 *
 * The rule is: no `residents` row **and** not a pengurus. Both halves are needed:
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
 * makes it once.
 */

/** Whether an account holding `roles` still waits for a superuser, per the rule documented above. */
export async function awaitsApproval(
	db: Database,
	userId: string,
	roles: ReadonlySet<Role>
): Promise<boolean> {
	if (roles.has(ROLE.admin) || roles.has(ROLE.superuser)) {
		return false;
	}
	return !(await residentProfileForUser(db, userId));
}

/** What the shell is built from, and whether the account may be shown it. */
export interface ShellState {
	/** The remembered sidebar width: `false` only when the person collapsed it. */
	readonly sidebarOpen: boolean;
	/** The menu this account may see; empty when nobody is signed in. */
	readonly menu: readonly MenuGroup[];
	/** Whether the account waits for a superuser. Always `false` when nobody is signed in. */
	readonly awaitingApproval: boolean;
}

/**
 * The shell's state for one request. Nobody signed in costs no database read at all: the menu is
 * empty and there is nobody to wait for approval.
 */
export async function loadShellState(
	cookies: Cookies,
	user: { readonly id: string } | null
): Promise<ShellState> {
	// The cookie holds "true" or "false"; anything else, including no cookie at all, means a
	// visitor who has never touched the control, and the sidebar starts open for them.
	const sidebarOpen = cookies.get(SIDEBAR_COOKIE_NAME) !== 'false';

	if (!user) {
		return { sidebarOpen, menu: [], awaitingApproval: false };
	}

	const db = database();
	const roles = await rolesOf(db, user.id);
	return {
		sidebarOpen,
		menu: visibleMenu(roles),
		awaitingApproval: await awaitsApproval(db, user.id, roles)
	};
}
