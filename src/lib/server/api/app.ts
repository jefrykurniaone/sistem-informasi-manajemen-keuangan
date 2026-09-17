import { Elysia } from 'elysia';
import { sql } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import { auth, type Auth } from '../auth';
import { database, type Database } from '../db';
import { createAuthMacro } from './auth-macro';
import { API_ERROR, apiErrorBody } from './errors';

/**
 * The HTTP surface of this application, mounted under `/api` by
 * `src/routes/api/[...slugs]/+server.ts` following Elysia's own documented pattern for SvelteKit.
 *
 * Two things this file deliberately does not do, both settled by `spec-fondasi-v1.md`'s "Seam":
 *
 * 1. **No domain rule lives here.** Every route below either answers a plain infrastructure
 *    question (`/health`) or reads context the `session` macro already resolved (`/me`). A route
 *    that needs to decide something about money, roles or any other domain concept calls the
 *    service layer for that decision, the same way `src/routes/(app)/admin/roles/+page.server.ts`
 *    does — it does not decide it inline.
 * 2. **No error escapes with a stack trace or an internal detail.** `onError` below is the single
 *    place an uncaught failure is turned into the uniform shape `src/lib/server/api/errors.ts`
 *    defines, and only ever logs the real error server-side.
 *
 * `/me` is the guarded example route the next tickets copy: tag a route with `{ session: true }` (or
 * `{ session: SOME_ACTION }` to also require a permission), and its handler can read `user`/`roles`
 * already resolved.
 */

/** What `createApiApp` needs. A factory, not a module-level instance, for the same reason
 * `createAuth` in `src/lib/server/auth.ts` is one: a unit test builds this against its own schema
 * and its own better-auth instance. */
export interface ApiAppSettings {
	readonly db: Database;
	readonly auth: Auth;
}

/** Builds the Elysia application. Every call produces its own. */
export function createApiApp(settings: ApiAppSettings) {
	const { db } = settings;

	return new Elysia({ prefix: '/api' })
		.use(createAuthMacro(settings))
		.onError(({ code, error, status }) => {
			if (code === 'VALIDATION') {
				return status(400, apiErrorBody(API_ERROR.badRequest));
			}
			if (code === 'NOT_FOUND') {
				return status(404, apiErrorBody(API_ERROR.notFound));
			}
			if (error instanceof PermissionDeniedError) {
				return status(403, apiErrorBody(API_ERROR.forbidden));
			}
			// Anything else is unexpected. It is logged for whoever is watching the running process
			// and never echoed back: a driver error or a stack trace can name a column, a path or a
			// query that a caller has no business seeing.
			console.error('[api] unhandled error', error);
			return status(500, apiErrorBody(API_ERROR.internal));
		})
		.get('/health', async ({ status }) => {
			const databaseOk = await isDatabaseReachable(db);
			const body = {
				app: 'ok' as const,
				database: databaseOk ? ('ok' as const) : ('error' as const)
			};
			return databaseOk ? body : status(503, body);
		})
		.get(
			'/me',
			({ user, roles }) => ({
				id: user.id,
				name: user.name,
				email: user.email,
				roles: [...roles].sort()
			}),
			{ session: true }
		);
}

/** Whether a plain query round-trips against `db`. The one thing `/health` proves about the database. */
async function isDatabaseReachable(db: Database): Promise<boolean> {
	try {
		await db.execute(sql`select 1`);
		return true;
	} catch {
		return false;
	}
}

let instance: ReturnType<typeof createApiApp> | undefined;

/** The running application's Elysia instance, built once from the real singletons on first call. */
export function api(): ReturnType<typeof createApiApp> {
	instance ??= createApiApp({ db: database(), auth: auth() });
	return instance;
}
