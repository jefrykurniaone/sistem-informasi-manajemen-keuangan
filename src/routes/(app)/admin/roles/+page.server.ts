import { fail } from '@sveltejs/kit';
import { ROLES, type Role } from '#lib/server/db/schema/authz.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import { grantRole, listUsersWithRoles, revokeRole } from '#lib/server/services/user/roles.ts';
import { LastSuperuserError } from '#lib/errors.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for granting and revoking roles.
 *
 * **Nobody who is not signed in ever reaches the service layer.** `requireUser` checks `locals.user`
 * first, and a missing one redirects to `/login` before `listUsersWithRoles` is ever called — there is no
 * caller to hand it, so calling it would not be "naming who is calling", it would be lying about
 * it.
 *
 * **A permission refusal becomes a 403 page, never a 500.** `PermissionDeniedError` from
 * `requirePermission` — reached here through `listUsersWithRoles`, `grantRole` and `revokeRole` —
 * is caught in every export below and turned into `error(403, …)`, the translation
 * `spec-fondasi-v1.md`'s "Peran" section asks the route to do. `LastSuperuserError` is different:
 * the actor is allowed to manage roles, only this one change is refused, so it becomes a rejected
 * form submission (`fail(400, …)`) rather than a 403. Both go through
 * `#lib/server/route-action.ts` (#318).
 *
 * This screen's sentences are still written here rather than in the Paraglide catalogue; moving them
 * is not part of the route-action migration, so each is wrapped as the `Message` the module takes.
 */

/** The complaint for a grant/revoke form that names no known user or role. */
const INVALID_FORM_MESSAGE = 'Permintaan tidak valid: pengguna atau peran tidak dikenali.';

/** The 403 for anyone without the right to manage roles. There is no 404 page. */
const PAGE = {
	forbidden: () => 'Anda tidak berhak mengelola peran pengguna.'
} satisfies PageMessages;

/** What `revoke` says when the service refuses the change. */
const REVOKE_FORM = {
	...PAGE,
	fallback: () => INVALID_FORM_MESSAGE,
	refusals: [
		refusal(LastSuperuserError, () => 'Tidak bisa mencabut peran superuser terakhir yang tersisa.')
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	try {
		const users = await listUsersWithRoles(productionDependencies().db, user.id);
		return { users, roles: ROLES };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	grant: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await readRoleChangeForm(request);
		if (!form.ok) {
			return fail(400, { message: form.complaint });
		}

		const { db, clock } = productionDependencies();
		try {
			await grantRole(db, clock, {
				actorId: user.id,
				targetUserId: form.targetUserId,
				role: form.role
			});
		} catch (caught) {
			throwRouteError(caught, PAGE);
		}
		return { message: `Peran ${form.role} berhasil ditambahkan.` };
	},

	revoke: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await readRoleChangeForm(request);
		if (!form.ok) {
			return fail(400, { message: form.complaint });
		}

		const { db, clock } = productionDependencies();
		try {
			await revokeRole(db, clock, {
				actorId: user.id,
				targetUserId: form.targetUserId,
				role: form.role
			});
		} catch (caught) {
			return failOrThrow(caught, REVOKE_FORM);
		}
		return { message: `Peran ${form.role} berhasil dicabut.` };
	}
};

/** What a grant/revoke form posts, after being checked for shape. */
type RoleChangeForm =
	| { readonly ok: true; readonly targetUserId: string; readonly role: Role }
	| { readonly ok: false; readonly complaint: string };

/** Reads and validates a grant/revoke form, without yet knowing whether the change is allowed. */
async function readRoleChangeForm(request: Request): Promise<RoleChangeForm> {
	const form = await request.formData();
	const targetUserId = readText(form, 'targetUserId');
	const role = readText(form, 'role');

	if (targetUserId === '' || !isRole(role)) {
		return { ok: false, complaint: INVALID_FORM_MESSAGE };
	}
	return { ok: true, targetUserId, role };
}

function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
}
