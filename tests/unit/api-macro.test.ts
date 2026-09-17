import { and, desc, eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { describe, expect, it } from 'vitest';
import { createApiApp } from '$lib/server/api/app';
import { createAuthMacro } from '$lib/server/api/auth-macro';
import { createAuth, type Auth } from '$lib/server/auth';
import { ACTION, type Action } from '$lib/server/authz';
import { emailQueue, user } from '$lib/server/db/schema';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { testDatabase } from '$lib/server/db/test-helpers';
import { VERIFY_EMAIL_KIND } from '$lib/server/email/templates/verify-email';
import { systemClock } from '$lib/server/ports/clock';

/**
 * The Elysia surface, against a real PostgreSQL and a real better-auth, without a browser:
 *
 * - the `session` macro refusing with 401 (no session) and 403 (session, insufficient permission),
 *   and resolving `user`/`roles` for a caller the guard lets through — the same
 *   `requirePermission` the service layer uses, per `spec-fondasi-v1.md`'s "Peran" section;
 * - `/health` answering without a session and reporting the database is reachable;
 * - `/me` returning the signed-in caller's own data.
 *
 * `tests/e2e/api-health.spec.ts` covers `/health` and `/me` again over a real HTTP connection, and
 * is the one that proves `/api/auth/*` still answers through the catch-all route — nothing here
 * goes over HTTP at all.
 */

const testDb = testDatabase();

/** The origin the test better-auth instance answers on. Never served over HTTP. */
const TEST_ORIGIN = 'http://localhost:5173';

/** A secret long enough for `createAuth` to accept. Protects nothing; used by this file only. */
const TEST_SECRET = 'api-macro-test-secret-that-is-long-enough';

/** A password clearing the minimum length. Invented here, protects nothing. */
const PASSWORD = 'kata sandi permukaan api';

let authInstance: Auth | undefined;

/** The better-auth instance under test, built on first use once `testDb.db` exists. */
function authentication(): Auth {
	authInstance ??= createAuth({
		db: testDb.db,
		clock: systemClock,
		baseURL: TEST_ORIGIN,
		secret: TEST_SECRET
	});
	return authInstance;
}

/** Registers and verifies a fresh account, using an address unique to this file's run. */
async function register(label: string): Promise<{ userId: string; email: string }> {
	const email = `api-macro-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
	await authentication().api.signUpEmail({
		body: { name: 'Warga Uji', email, password: PASSWORD }
	});

	const [queued] = await testDb.db
		.select()
		.from(emailQueue)
		.where(and(eq(emailQueue.recipient, email), eq(emailQueue.kind, VERIFY_EMAIL_KIND)))
		.orderBy(desc(emailQueue.createdAt))
		.limit(1);
	const url = queued?.payload.url;
	if (typeof url !== 'string') {
		throw new TypeError(`No verification email was queued for ${email}.`);
	}
	const token = new URL(url).searchParams.get('token');
	if (token === null) {
		throw new TypeError(`The queued verification email carries no token: ${url}`);
	}
	await authentication().api.verifyEmail({ query: { token } });

	const [row] = await testDb.db.select().from(user).where(eq(user.email, email));
	if (!row) {
		throw new TypeError(`No user row was found for ${email} after verifying.`);
	}
	return { userId: row.id, email };
}

/** Signs a registered account in, returning the `Cookie` header a browser would send back. */
async function signIn(email: string): Promise<string> {
	const { headers } = await authentication().api.signInEmail({
		body: { email, password: PASSWORD },
		returnHeaders: true
	});
	return headers
		.getSetCookie()
		.map((line) => line.split(';')[0])
		.join('; ');
}

/** Registers, verifies and signs a fresh caller in, in one step. */
async function aSignedInCaller(label: string): Promise<{ userId: string; cookie: string }> {
	const { userId, email } = await register(label);
	const cookie = await signIn(email);
	return { userId, cookie };
}

/** Grants a role directly, bypassing the service layer — this file tests the guard, not `roles.ts`. */
async function grant(userId: string, role: Role): Promise<void> {
	await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date() });
}

describe('the session macro', () => {
	function protectedApp(requirement: true | Action) {
		return new Elysia()
			.use(createAuthMacro({ db: testDb.db, auth: authentication() }))
			.get('/protected', ({ user, roles }) => ({ userId: user.id, roles: [...roles] }), {
				session: requirement
			});
	}

	it('refuses a request with no session at all, with 401', async () => {
		const response = await protectedApp(true).handle(new Request('http://localhost/protected'));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: { message: expect.any(String) } });
	});

	it('resolves the caller and their roles for a plain session requirement', async () => {
		const { userId, cookie } = await aSignedInCaller('session-plain');

		const response = await protectedApp(true).handle(
			new Request('http://localhost/protected', { headers: { cookie } })
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ userId, roles: [ROLE.resident] });
	});

	it('refuses a signed-in caller who lacks the required permission, with 403', async () => {
		const { cookie } = await aSignedInCaller('session-forbidden');

		const response = await protectedApp(ACTION.manageJobs).handle(
			new Request('http://localhost/protected', { headers: { cookie } })
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: { message: expect.any(String) } });
	});

	it('lets a caller through once they hold a role the permission allows', async () => {
		const { userId, cookie } = await aSignedInCaller('session-allowed');
		await grant(userId, ROLE.superuser);

		const response = await protectedApp(ACTION.manageJobs).handle(
			new Request('http://localhost/protected', { headers: { cookie } })
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.userId).toBe(userId);
		expect(body.roles).toEqual(expect.arrayContaining([ROLE.resident, ROLE.superuser]));
	});
});

describe('createApiApp', () => {
	function app() {
		return createApiApp({ db: testDb.db, auth: authentication() });
	}

	it('/health answers with no session and reports the database is reachable', async () => {
		const response = await app().handle(new Request('http://localhost/api/health'));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ app: 'ok', database: 'ok' });
	});

	it('/me refuses a request with no session, with 401', async () => {
		const response = await app().handle(new Request('http://localhost/api/me'));

		expect(response.status).toBe(401);
	});

	it('/me returns the signed-in caller’s own data', async () => {
		const { userId, email } = await register('me-route');
		const cookie = await signIn(email);

		const response = await app().handle(
			new Request('http://localhost/api/me', { headers: { cookie } })
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: userId,
			name: 'Warga Uji',
			email,
			roles: [ROLE.resident]
		});
	});
});
