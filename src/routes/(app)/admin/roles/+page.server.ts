import { error, fail, redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { ROLES, type Role } from '$lib/server/db/schema/authz';
import { systemClock } from '$lib/server/ports/clock';
import { grantRole, listUsersWithRoles, revokeRole } from '$lib/server/services/user/roles';
import { LastSuperuserError, PermissionDeniedError } from '$lib/errors';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for granting and revoking roles.
 *
 * **Nobody who is not signed in ever reaches the service layer.** `locals.user` is checked first,
 * and a missing one redirects to `/login` before `listUsersWithRoles` is ever called — there is no
 * caller to hand it, so calling it would not be "naming who is calling", it would be lying about
 * it.
 *
 * **A permission refusal becomes a 403 page, never a 500.** `PermissionDeniedError` from
 * `requirePermission` — reached here through `listUsersWithRoles`, `grantRole` and `revokeRole` —
 * is caught in every export below and turned into `error(403, …)`, the translation
 * `spec-fondasi-v1.md`'s "Peran" section asks the route to do. `LastSuperuserError` is different:
 * the actor is allowed to manage roles, only this one change is refused, so it becomes a rejected
 * form submission (`fail(400, …)`) rather than a 403.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const users = await listUsersWithRoles(database(), locals.user.id);
		return { users, roles: ROLES };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	grant: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}
		const form = await readRoleChangeForm(request);
		if (!form.ok) {
			return fail(400, { message: form.complaint });
		}

		try {
			await grantRole(database(), systemClock, {
				actorId: locals.user.id,
				targetUserId: form.targetUserId,
				role: form.role
			});
		} catch (caught) {
			throwAsRouteError(caught);
		}
		return { message: `Peran ${form.role} berhasil ditambahkan.` };
	},

	revoke: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}
		const form = await readRoleChangeForm(request);
		if (!form.ok) {
			return fail(400, { message: form.complaint });
		}

		try {
			await revokeRole(database(), systemClock, {
				actorId: locals.user.id,
				targetUserId: form.targetUserId,
				role: form.role
			});
		} catch (caught) {
			if (caught instanceof LastSuperuserError) {
				return fail(400, { message: 'Tidak bisa mencabut peran superuser terakhir yang tersisa.' });
			}
			throwAsRouteError(caught);
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
	const targetUserId = String(form.get('targetUserId') ?? '').trim();
	const role = String(form.get('role') ?? '').trim();

	if (targetUserId === '' || !isRole(role)) {
		return { ok: false, complaint: 'Permintaan tidak valid: pengguna atau peran tidak dikenali.' };
	}
	return { ok: true, targetUserId, role };
}

function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what an action or a load function returns. A helper that
 * sometimes *returned* `error(403, …)` instead of throwing it, or whose return type was inferred
 * from `fail`'s generic signature rather than a literal, is what made `svelte-check` lose track of
 * `ActionData` the first time this file was written — every response a route sends back has to be
 * a literal `return`/`throw` at the call site, not laundered through a generically typed helper.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, 'Anda tidak berhak mengelola peran pengguna.');
	}
	throw caught;
}
