import { redirect } from '@sveltejs/kit';
import { database } from '$lib/server/db';
import { rolesOf } from '$lib/server/authz';
import { ROLE } from '$lib/server/db/schema/authz';
import { residentProfileForUser } from '$lib/server/services/resident/profile';
import type { LayoutServerLoad } from './$types';

/**
 * The one place every page of the `(app)` group asks "is this account allowed in here yet", so that
 * a self-registrant waiting for a superuser sees the page that says so and nothing else — the
 * acceptance criterion "setiap halaman lain menolaknya" in the ticket that added `/pending-approval`.
 *
 * **This is the experience, never the boundary.** A layout `load` does not run for a child page's
 * form action, so a rule written only here would be one POST away from nothing. What actually
 * refuses an unapproved registrant is the service layer: they have no `residents` row, so every
 * Warga service keyed by one answers empty, and they hold only the `resident` role, which no entry
 * in `PERMISSIONS` names. See the doc comment on
 * `src/lib/server/services/registration/index.ts`, and the test that proves it.
 *
 * ## Who is redirected, and who is not
 *
 * The redirect is for an account that has no `residents` row **and** is not a pengurus. Both halves
 * are needed:
 *
 * - **No `residents` row** is what "has not been admitted" means. The XLSX import (Template Impor,
 *   #19) writes that row, accepting an invitation (#20) writes it, and approving a registration
 *   writes it; an account that has none has been through none of the three.
 * - **Not holding `admin` or `superuser`** is the exemption, and it is not a convenience. Those
 *   roles are granted by a superuser, which is a stronger admission than a `residents` row, and a
 *   pengurus is routinely an account with no house of their own — the first superuser of an
 *   installation is seeded from outside and has never been a resident of anything. Redirecting them
 *   would lock the admin screens behind a page about somebody else's registration, including the
 *   screen that decides registrations.
 *
 * Reading roles here is the same read `src/routes/+layout.server.ts` already makes to choose which
 * menu items to render: it decides what a person *sees*, and the guard on each service call remains
 * the only place a request is really let through or refused.
 *
 * `/pending-approval` is excluded by its own path, because it is the page being redirected to.
 * `/profile` and `/my-unit` each still carry their own "belum tercatat" state for the pengurus case
 * this guard lets past.
 */

/** Where an account that has not been admitted is sent, and the one path this guard leaves alone. */
const PENDING_APPROVAL_PATH = '/pending-approval';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const { user } = locals;
	// Nobody signed in: every page in this group already sends its own visitor to the login page,
	// and answering that question twice in two places is how the two end up disagreeing.
	if (!user || url.pathname === PENDING_APPROVAL_PATH) {
		return;
	}

	const db = database();
	if (await residentProfileForUser(db, user.id)) {
		return;
	}

	const roles = await rolesOf(db, user.id);
	if (roles.has(ROLE.admin) || roles.has(ROLE.superuser)) {
		return;
	}

	redirect(303, PENDING_APPROVAL_PATH);
};
