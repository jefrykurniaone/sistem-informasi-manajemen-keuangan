import { Elysia } from 'elysia';
import type { User } from 'better-auth';
import { PermissionDeniedError } from '$lib/errors';
import type { Auth } from '../auth';
import { requirePermission, rolesOf, type Action, type DatabaseWriter } from '../authz';
import type { Role } from '../db/schema/authz';
import { API_ERROR, apiErrorBody } from './errors';

/**
 * The one macro every guarded route in `src/lib/server/api/app.ts` tags itself with, and the one
 * place a request under `/api` is turned into a caller `requirePermission` can be asked about — see
 * `spec-fondasi-v1.md`'s "Peran" section, which asks for exactly one place a permission is decided,
 * and #12's `src/lib/server/authz.ts`, which is that place.
 *
 * ## What `session` does
 *
 * Tagging a route with `{ session: true }` reads the session the same way
 * `src/hooks.server.ts`'s `authHandle` does — `auth().api.getSession({ headers })` — and refuses a
 * request with no active session with a `401`, before the route's own handler ever runs. Tagging it
 * with `{ session: SOME_ACTION }` does the same, and additionally calls
 * `requirePermission(db, callerId, SOME_ACTION)`, refusing with `403` when the caller's roles do not
 * permit it — the exact guard the service layer uses, not a copy of its decision.
 *
 * A route that passes never decides any of this itself: it reads `user` and `roles` off its own
 * context, already resolved, exactly as a `load` function reads `locals.user`.
 *
 * ## Why a factory rather than a module-level instance
 *
 * `createAuthMacro` takes `db` and `auth` rather than importing `database()`/`auth()` directly, the
 * same shape `createAuth` in `src/lib/server/auth.ts` settled: a unit test builds one against its own
 * schema and its own better-auth instance, and the running application builds one from the real
 * singletons in `src/lib/server/api/app.ts`.
 */

/** What a route tagged with `session` finds already resolved on its context. */
export interface SessionContext {
	/** The signed-in caller. Never `null` — a request with no session never reaches the handler. */
	readonly user: User;
	/** Every role `user` currently holds, read the same way `requirePermission` reads it. */
	readonly roles: ReadonlySet<Role>;
}

/** What `createAuthMacro` needs to read a session and decide a permission. */
export interface AuthMacroSettings {
	readonly auth: Auth;
	readonly db: DatabaseWriter;
}

/** Builds the `session` macro against one database and one better-auth instance. */
export function createAuthMacro(settings: AuthMacroSettings) {
	const { auth: authInstance, db } = settings;

	return new Elysia({ name: 'auth-macro' }).macro({
		session: (requirement: true | Action) => ({
			async resolve({ request, status }) {
				const active = await authInstance.api.getSession({ headers: request.headers });
				if (!active) {
					return status(401, apiErrorBody(API_ERROR.unauthorized));
				}

				if (requirement !== true) {
					try {
						await requirePermission(db, active.user.id, requirement);
					} catch (caught) {
						if (caught instanceof PermissionDeniedError) {
							return status(403, apiErrorBody(API_ERROR.forbidden));
						}
						throw caught;
					}
				}

				const roles = await rolesOf(db, active.user.id);
				return { user: active.user, roles } satisfies SessionContext;
			}
		})
	});
}
