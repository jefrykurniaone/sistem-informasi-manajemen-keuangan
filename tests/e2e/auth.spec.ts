import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Registering, verifying, signing in, signing out and recovering a password, through a browser.
 *
 * ## Where the links come from
 *
 * The application does not send email from inside a request — it writes a row into `email_queue`,
 * and a worker sends it later. That worker is started by the scheduler, which is a later ticket,
 * so during this run nothing drains the queue and Mailpit never sees anything. This spec
 * therefore reads the link out of the queue row, which is the half of the chain this ticket owns.
 * The other half — a queued row really reaching an SMTP server — is proven by
 * `tests/unit/ports-email.test.ts` against a mail server it starts itself.
 *
 * The link in the row is built from `ORIGIN`, which is the address the development server answers
 * on, while Playwright serves a preview build on a port of its own. Only the token is taken out of
 * the link, and the address is rebuilt against whichever origin the test is running on.
 *
 * ## Why the sign-out step posts rather than clicks
 *
 * Signing out is a POST, so that no link or image on another page can do it to someone. There is
 * no navigation frame to put that button in yet — that belongs to a later ticket — so the test
 * makes the same POST a form would, `Origin` header included, which is what SvelteKit checks
 * before it will act on one.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/**
 * A password that clears the minimum length the application asks for. Invented here, used by this
 * file only, and protecting nothing — a literal in a test rather than a credential.
 */
const PASSWORD = 'kata sandi ujung ke ujung';

/** The label on every address field in the flow. */
const EMAIL_FIELD = 'Alamat email';

/** The sign-in page. */
const LOGIN_PATH = '/login';

/**
 * The complex name the server under test was built with, worked out the way `src/lib/complex-name.ts`
 * does: trimmed, and "Komplek" when nothing is left. Restated rather than imported for the reason
 * `tests/e2e/layout.spec.ts` gives: `$env/static/public` only resolves inside a SvelteKit build.
 */
function expectedComplexName(): string {
	const trimmed = process.env.PUBLIC_COMPLEX_NAME?.trim() ?? '';
	return trimmed === '' ? 'Komplek' : trimmed;
}

const COMPLEX_NAME = expectedComplexName();

/**
 * This file's own connection, opened when a test first needs one and opened again after it has
 * been closed.
 *
 * **Not a `const` pool closed once in `afterAll`**, which is what every spec in this directory
 * used to be, and which `fullyParallel: true` breaks. Playwright gives each test a job of its own
 * under that setting, two jobs of one file can land in the same worker process, and it runs
 * `beforeAll` and `afterAll` around each of those jobs against the one module instance the worker
 * has already imported — so the hook below really does run more than once per process. `pg` throws
 * "Called end on pool more than once" on the second `end()`, and throws again on any query made
 * through a pool that was closed, so the old shape failed one way or the other as soon as the
 * runner split a file. Measured while fixing #112: `tests/e2e/file-serving.spec.ts:140` failed
 * with exactly that message, and only ever above `--workers=1`.
 *
 * Opening per job rather than per file costs one connection handshake and takes the whole question
 * away: each job closes exactly the pool it opened.
 *
 * The other specs in this directory carry the same two lines and point back here for the reason,
 * the way they already copy their sign-up helpers rather than importing one — importing from a
 * spec file would register its tests a second time.
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

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** Waits for the queue to hold an email of one kind for one address, and returns its token. */
async function tokenFromQueuedEmail(recipient: string, kind: string): Promise<string> {
	const deadline = Date.now() + QUEUE_WAIT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await pool().query<{ payload: { url?: string } }>(
			'select payload from email_queue where recipient = $1 and kind = $2 order by created_at desc limit 1',
			[recipient, kind]
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
	throw new Error(`No email of kind "${kind}" was queued for ${recipient}.`);
}

/**
 * Opens `path` and waits until the page can be typed into.
 *
 * `goto` on its own is not enough, and the reason is measured rather than guessed. The page
 * arrives server-rendered and Svelte hydrates it a moment later, and hydration writes every
 * `value={…}` binding back over the DOM — so anything typed before it runs is thrown away. With
 * the client chunks held back two seconds and `goto` told not to wait for them, an address filled
 * into `Alamat email` on `/login` survived twelve readings and was empty on the thirteenth, at the
 * moment hydration landed, and stayed empty. `Alamat email` is `required`, so what that leaves is
 * a form the browser silently refuses to submit and no error anywhere to say why: `/login`, still
 * showing, with an empty address and a full password. That is exactly the page every one of #112's
 * parallel failures was looking at.
 *
 * It only bites above one worker because six Chromium instances share this machine, and hydration
 * then slips past `load` often enough to lose the race several times per run.
 *
 * `networkidle` is the signal because it needs to know nothing about Svelte or SvelteKit:
 * hydration runs as soon as the client chunks resolve, and this application opens no socket and
 * polls nothing, so half a second with no network activity means those chunks have arrived and
 * run. Playwright discourages `networkidle` as a way of deciding an application is *ready* — that
 * is what the assertions in these tests are for — but "the last module has arrived" is exactly
 * what it does report.
 *
 * The other specs in this directory carry the same helper and point back here, the way they
 * already copy their sign-up helpers rather than importing one.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** Fills in the registration form and submits it. */
async function register(page: Page, email: string, password = PASSWORD): Promise<void> {
	await open(page, '/register');
	await page.getByLabel('Nama').fill('Warga Uji');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	// The claimed house the form asks for since #21. Nothing here checks it against `units`, and a
	// registration nobody approves grants nothing, so this spec's flows are unaffected by its value.
	await page.getByLabel('Blok rumah').fill('E2E');
	await page.getByLabel('Nomor rumah').fill('0');
	await page.getByLabel('Kata sandi', { exact: true }).fill(password);
	await page.getByLabel('Ulangi kata sandi').fill(password);
	await page.getByRole('button', { name: 'Daftar' }).click();
	// Waiting here rather than leaving it to whichever test cares. Clicking only posts the form,
	// and the sign-up is still running when `click` resolves — the test below that registers and
	// then goes straight to `/login` would otherwise race its own account into existence.
	await expect(page).toHaveURL(/\/verify/);
}

/** Fills in the sign-in form and submits it. */
async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
	await open(page, LOGIN_PATH);
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(password);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

/** The session cookie as the browser is holding it, if it is holding one. */
async function sessionCookie(context: BrowserContext) {
	const cookies = await context.cookies();
	return cookies.find((cookie) => cookie.name.endsWith('better-auth.session_token'));
}

test('the sign-in page carries a brand panel with the complex name', async ({ page }) => {
	await open(page, LOGIN_PATH);
	// `exact: true` so the lowercase "komplek" in the tagline cannot stand in for the name when the
	// build falls back to "Komplek".
	await expect(
		page.getByRole('complementary').getByText(COMPLEX_NAME, { exact: true })
	).toBeVisible();
});

test('a new resident registers, verifies, signs in, and signs out', async ({
	page,
	context,
	baseURL
}) => {
	const email = anAddress('lifecycle');

	await register(page, email);
	await expect(page).toHaveURL(/\/verify/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Verifikasi email');

	const token = await tokenFromQueuedEmail(email, 'verify-email');
	await page.goto(`/verify?token=${encodeURIComponent(token)}`);
	await expect(page.getByText('Alamat email Anda sudah terverifikasi')).toBeVisible();

	// The same link a second time says it was already used, not the first-visit sentence, and it
	// carries no resend form.
	await page.goto(`/verify?token=${encodeURIComponent(token)}`);
	await expect(page.getByText('Tautan ini sudah pernah dipakai')).toBeVisible();
	await expect(page.getByText('Alamat email Anda sudah terverifikasi')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Kirim ulang email verifikasi' })).toHaveCount(0);

	await signIn(page, email);
	// This account has no `residents` row and no admin/superuser role, so it is not admitted yet;
	// `/` is Beranda in the `(app)` group since #142, and that group's own layout sends an
	// unadmitted account to `/pending-approval` instead of rendering it.
	await expect(page).toHaveURL(`${baseURL}/pending-approval`);

	// The session is there, it cannot be read by script, it is withheld from cross-site posts,
	// and it has an expiry — which is what makes it survive closing the browser.
	const cookie = await sessionCookie(context);
	expect(cookie?.httpOnly).toBe(true);
	expect(cookie?.sameSite).toBe('Lax');
	expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000);

	// Being signed in is visible from the sign-in page, which sends a signed-in visitor home — and
	// home redirects this still-unadmitted account on to `/pending-approval`, same as above.
	await page.goto(LOGIN_PATH);
	await expect(page).toHaveURL(`${baseURL}/pending-approval`);

	await page.request.post('/logout', { form: {}, headers: { origin: String(baseURL) } });
	expect(await sessionCookie(context)).toBeUndefined();
	await page.goto(LOGIN_PATH);
	await expect(page.getByRole('button', { name: 'Masuk' })).toBeVisible();
});

test('an account whose address is not verified is turned away and told how to fix it', async ({
	page
}) => {
	const email = anAddress('unverified');
	await register(page, email);

	await signIn(page, email);

	await expect(page.getByRole('alert')).toContainText('belum diverifikasi');
	await page.getByRole('link', { name: 'Kirim ulang email verifikasinya' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Verifikasi email');
	await expect(page.getByRole('button', { name: 'Kirim ulang email verifikasi' })).toBeVisible();
});

test('a forgotten password is recovered through the emailed link, which works once', async ({
	page,
	baseURL
}) => {
	const email = anAddress('recovery');
	const newPassword = 'kata sandi yang benar-benar baru';
	await register(page, email);
	const verifyToken = await tokenFromQueuedEmail(email, 'verify-email');
	await page.goto(`/verify?token=${encodeURIComponent(verifyToken)}`);

	await open(page, '/forgot-password');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByRole('button', { name: 'Kirim tautan' }).click();
	await expect(page.getByRole('status')).toContainText('hanya bisa dipakai sekali');

	const resetToken = await tokenFromQueuedEmail(email, 'password-reset');
	const resetPath = `/set-password?token=${encodeURIComponent(resetToken)}`;
	await open(page, resetPath);
	await page.getByLabel('Kata sandi baru', { exact: true }).fill(newPassword);
	await page.getByLabel('Ulangi kata sandi baru').fill(newPassword);
	await page.getByRole('button', { name: 'Simpan kata sandi' }).click();
	await expect(page).toHaveURL(/\/login/);

	// The same link a second time is refused, because using it deleted it.
	await open(page, resetPath);
	await page.getByLabel('Kata sandi baru', { exact: true }).fill(newPassword);
	await page.getByLabel('Ulangi kata sandi baru').fill(newPassword);
	await page.getByRole('button', { name: 'Simpan kata sandi' }).click();
	await expect(page.getByRole('alert')).toContainText('sudah tidak berlaku');

	// The old password is gone, not merely joined by a new one.
	await signIn(page, email);
	await expect(page.getByRole('alert')).toContainText('Email atau kata sandi salah');

	await signIn(page, email, newPassword);
	// Same unadmitted-account redirect as the lifecycle test above: `/` is Beranda in the `(app)`
	// group since #142, and this account has no `residents` row and no admin/superuser role.
	await expect(page).toHaveURL(`${baseURL}/pending-approval`);
});
