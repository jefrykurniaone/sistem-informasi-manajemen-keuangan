import { loadShellState } from '#lib/server/app-shell.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Whether the announcement board and a Post open inside the app shell, and what the shell needs
 * (#319, spec `papan-pengumuman-v1`).
 *
 * `shell` is `null` for everyone who gets the light header: a visitor with no session, and a
 * signed-in account that has not been admitted yet. It is the shell's data for everyone who would
 * also get the shell in the `(app)` group. Both layouts ask `loadShellState`, so the two groups
 * cannot disagree about who is let in.
 *
 * **No redirect here.** Unlike the `(app)` group this board is open to everyone, including an
 * account still waiting for a superuser, so that account simply keeps the light header it had
 * before. A visitor with no session costs no database read at all.
 *
 * `(public)/+layout.svelte` reads `shell` off `page.data` to drop its own header when this layout
 * supplies the shell; the unsubscribe page, which has no layout of this kind, never has it.
 */
export const load: LayoutServerLoad = async ({ cookies, locals }) => {
	const { sidebarOpen, menu, awaitingApproval } = await loadShellState(cookies, locals.user);
	const shell = locals.user && !awaitingApproval ? { sidebarOpen, menu } : null;
	return { shell };
};
