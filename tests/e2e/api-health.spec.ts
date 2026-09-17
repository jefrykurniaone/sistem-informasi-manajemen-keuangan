import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The Elysia surface mounted at `/api`, over a real HTTP connection:
 *
 * - `/api/health` answers with no session and reports the database is reachable;
 * - `/api/me`, the guarded example route, refuses with 401 without a session and returns the
 *   signed-in resident's own data with one.
 *
 * `tests/unit/api-macro.test.ts` covers the `session` macro's 401/403 behaviour in more depth,
 * without a browser or an HTTP round trip.
 *
 * ## What this file does not, and cannot, prove about `/api/auth/*`
 *
 * `src/hooks.server.ts`'s `authHandle` only forwards a request to better-auth's own router when
 * `better-auth/svelte-kit`'s `isAuthPath` finds the request's *origin* equal to `auth().options.baseURL`
 * (read from `ORIGIN`). `playwright.config.ts` always previews this application on a fixed port
 * (4173), while `.env` sets `ORIGIN` to the port this worktree's dev server answers on — the two
 * disagree, so under this harness every request's origin fails that check regardless of this
 * ticket, and `/api/auth/*` falls through to SvelteKit's router exactly as it did before this
 * ticket added a route under `/api` at all. That is a pre-existing property of this repository's
 * `ORIGIN`/preview-port wiring, not something `src/routes/api/[...slugs]/+server.ts` can fix from
 * inside its own `writes:` scope, and not something a fixed preview port can be made to prove
 * either way. The claim that this catch-all does not break `/api/auth/*` is verified instead
 * against `bun run dev` on the port `ORIGIN` actually names, where the origins agree — see the
 * ticket's delivery report for that walk.
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

const pool = new Pool({ connectionString: DATABASE_URL });

test.afterAll(async () => {
	await pool.end();
});

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-api-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** Waits for a verification email to be queued for `recipient`, and returns its token. */
async function verificationToken(recipient: string): Promise<string> {
	const deadline = Date.now() + QUEUE_WAIT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await pool.query<{ payload: { url?: string } }>(
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
	await page.goto('/register');
	await page.getByLabel('Nama').fill('Warga API');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Ulangi kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await expect(page).toHaveURL(/\/verify/);

	const token = await verificationToken(email);
	await page.goto(`/verify?token=${encodeURIComponent(token)}`);
}

/** Signs a verified resident in. */
async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

test('the health route answers with no session and reports the app and database', async ({
	request
}) => {
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
	await expect(page).toHaveURL('/');

	const response = await page.request.get('/api/me');

	expect(response.status()).toBe(200);
	expect(await response.json()).toMatchObject({ email, roles: ['resident'] });
});
