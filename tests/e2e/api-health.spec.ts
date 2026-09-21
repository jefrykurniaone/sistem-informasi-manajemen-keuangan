import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The boundary at `/api`, over a real HTTP connection, from both of its sides:
 *
 * - `/api/auth/*` is answered by better-auth's own router, not by the Elysia catch-all;
 * - `/api/health` answers with no session and reports the database is reachable;
 * - `/api/me`, the guarded example route, refuses with 401 without a session and returns the
 *   signed-in resident's own data with one.
 *
 * The two sides belong in one file because they share one address space.
 * `src/routes/api/[...slugs]/+server.ts` mounts Elysia on everything under `/api`, and
 * `src/hooks.server.ts`'s `authHandle` takes `/api/auth/*` back out from under it first, by handing
 * the request to `svelteKitHandler`. A change that let the catch-all start swallowing the sign-in
 * surface would break every session this application issues while leaving every page-level test
 * green — the other e2e specs all reach better-auth through form actions, never over HTTP — so
 * neither assertion below is allowed to stand without the other.
 *
 * Proving any of this needs `ORIGIN` to name the address the server under test is really listening
 * on: `svelteKitHandler` compares the request's origin against it before forwarding anything.
 * `playwright.config.ts` derives the port, the `baseURL` and that `ORIGIN` from one constant for
 * exactly this reason, and says so at length.
 *
 * `tests/unit/api-macro.test.ts` covers the `session` macro's 401/403 behaviour in more depth,
 * without a browser or an HTTP round trip.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued verification email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi permukaan api';

/** The label on the address field in the registration form. */
const EMAIL_FIELD = 'Alamat email';

/**
 * This file's own connection, opened on first use by each job and closed by the job that opened
 * it. Not a module-scope pool closed once — see `tests/e2e/auth.spec.ts` for why `fullyParallel`
 * runs `afterAll` more than once in one worker process, and what `pg` does about it.
 */
let openPool: Pool | undefined;

/** The connection, opened on first use by this job. */
function pool(): Pool {
	openPool ??= new Pool({ connectionString: DATABASE_URL });
	return openPool;
}

test.afterAll(async () => {
	const closing = openPool;
	openPool = undefined;
	await closing?.end();
});

/**
 * Opens `path` and waits until the page can be typed into. `goto` on its own is not enough:
 * Svelte's hydration writes every `value={…}` binding back over whatever was typed before it ran,
 * which empties a `required` field and leaves a form the browser will not submit. See
 * `tests/e2e/auth.spec.ts` for the measurement and for why `networkidle` is the signal.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-api-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** Waits for a verification email to be queued for `recipient`, and returns its token. */
async function verificationToken(recipient: string): Promise<string> {
	const deadline = Date.now() + QUEUE_WAIT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await pool().query<{ payload: { url?: string } }>(
			"select payload from email_queue where recipient = $1 and kind = 'verify-email' order by created_at desc limit 1",
			[recipient]
		);
		const url = result.rows[0]?.payload?.url;
		if (typeof url === 'string') {
			const token = new URL(url).searchParams.get('token');
			if (token !== null) {
				return token;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MILLISECONDS));
	}
	throw new Error(`No verification email was queued for ${recipient}.`);
}

/** Registers a resident and verifies their address, leaving them signed out. */
async function registerAndVerify(page: Page, email: string): Promise<void> {
	await open(page, '/register');
	await page.getByLabel('Nama').fill('Warga API');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	// The claimed house the form asks for since #21. Nothing here checks it against `units`, and a
	// registration nobody approves grants nothing, so this spec's flows are unaffected by its value.
	await page.getByLabel('Blok rumah').fill('E2E');
	await page.getByLabel('Nomor rumah').fill('0');
	await page.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Ulangi kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await expect(page).toHaveURL(/\/verify/);

	const token = await verificationToken(email);
	await page.goto(`/verify?token=${encodeURIComponent(token)}`);
}

/** Signs a verified resident in. */
async function signIn(page: Page, email: string): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

test('better-auth answers its own routes instead of the catch-all mounted at /api', async ({
	request
}) => {
	const response = await request.get('/api/auth/get-session');

	// better-auth reports "nobody is signed in" as 200 carrying a JSON `null`. The Elysia catch-all
	// has no route at this address and would answer 404 with the uniform `{ error: { message } }`
	// body from `src/lib/server/api/errors.ts` — the same shape the `/api/me` test below reads — so
	// this pair of assertions tells the two answers apart on its own.
	expect(response.status()).toBe(200);
	expect(await response.json()).toBeNull();
});

test('the Elysia health route still answers on the same arrangement', async ({ request }) => {
	const response = await request.get('/api/health');

	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ app: 'ok', database: 'ok' });
});

test('the guarded example route refuses a request with no session', async ({ request }) => {
	const response = await request.get('/api/me');

	expect(response.status()).toBe(401);
	const body: { error?: { message?: unknown } } = await response.json();
	expect(typeof body.error?.message).toBe('string');
});

test('a signed-in resident reads their own data from the guarded example route', async ({
	page
}) => {
	const email = anAddress('me');
	await registerAndVerify(page, email);
	await signIn(page, email);
	// This account has no `residents` row and no admin/superuser role, so it is not admitted yet;
	// `/` is Beranda in the `(app)` group since #142, and that group's own layout sends an
	// unadmitted account to `/pending-approval` instead of rendering it.
	await expect(page).toHaveURL('/pending-approval');

	const response = await page.request.get('/api/me');

	expect(response.status()).toBe(200);
	expect(await response.json()).toMatchObject({ email, roles: ['resident'] });
});
