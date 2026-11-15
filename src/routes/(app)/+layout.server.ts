import { redirect } from '@sveltejs/kit';
import { loadShellState } from '#lib/server/app-shell.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Everything the `(app)` group asks once for all of its pages: what the app shell in
 * `+layout.svelte` needs, and whether this account is allowed in here yet.
 *
 * The shell's data (the role-aware menu, the sidebar's remembered width) and the rule for "is this
 * account allowed in yet" live in `src/lib/server/app-shell.ts`, because the announcement board's
 * layout (`(public)/posts/+layout.server.ts`) asks the same question and the two must not disagree
 * (#319). Read its doc comment for the reasoning, including why a menu link is never authorization
 * and why this redirect is the experience and never the boundary.
 *
 * ## The pending-approval redirect
 *
 * The one place every page of the group acts on that answer, so that a self-registrant waiting for
 * a superuser sees the page that says so and nothing else (the acceptance criterion "setiap halaman
 * lain menolaknya" in the ticket that added `/pending-approval`).
 *
 * `/pending-approval` is excluded by its own path, because it is the page being redirected to. It
 * still renders the shell, with whatever menu the account's roles allow, so the way out stays in
 * reach. `/profile` and `/my-unit` each still carry their own "belum tercatat" state for the
 * pengurus case this guard lets past.
 *
 * Nobody signed in: every page in this group already sends its own visitor to the login page, and
 * answering that question twice in two places is how the two end up disagreeing. The menu is empty.
 */

/** Where an account that has not been admitted is sent, and the one path this guard leaves alone. */
const PENDING_APPROVAL_PATH = '/pending-approval';

export const load: LayoutServerLoad = async ({ cookies, locals, url }) => {
	const { sidebarOpen, menu, awaitingApproval } = await loadShellState(cookies, locals.user);
	if (awaitingApproval && url.pathname !== PENDING_APPROVAL_PATH) {
		redirect(303, PENDING_APPROVAL_PATH);
	}
	return { sidebarOpen, menu };
};
