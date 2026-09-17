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

const pool = new Pool({ connectionString: DATABASE_URL });

test.afterAll(async () => {
	await pool.end();
});

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** Waits for the queue to hold an email of one kind for one address, and returns its token. */
async function tokenFromQueuedEmail(recipient: string, kind: string): Promise<string> {
	const deadline = Date.now() + QUEUE_WAIT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await pool.query<{ payload: { url?: string } }>(
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

/** Fills in the registration form and submits it. */
async function register(page: Page, email: string, password = PASSWORD): Promise<void> {
	await page.goto('/register');
	await page.getByLabel('Nama').fill('Warga Uji');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi', { exact: true }).fill(password);
	await page.getByLabel('Ulangi kata sandi').fill(password);
	await page.getByRole('button', { name: 'Daftar' }).click();
}

/** Fills in the sign-in form and submits it. */
async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
	await page.goto(LOGIN_PATH);
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(password);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

/** The session cookie as the browser is holding it, if it is holding one. */
async function sessionCookie(context: BrowserContext) {
	const cookies = await context.cookies();
	return cookies.find((cookie) => cookie.name.endsWith('better-auth.session_token'));
}

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

	await signIn(page, email);
	await expect(page).toHaveURL(`${baseURL}/`);

	// The session is there, it cannot be read by script, it is withheld from cross-site posts,
	// and it has an expiry — which is what makes it survive closing the browser.
	const cookie = await sessionCookie(context);
	expect(cookie?.httpOnly).toBe(true);
	expect(cookie?.sameSite).toBe('Lax');
	expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000);

	// Being signed in is visible from the sign-in page, which sends a signed-in visitor home.
	await page.goto(LOGIN_PATH);
	await expect(page).toHaveURL(`${baseURL}/`);

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

	await page.goto('/forgot-password');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByRole('button', { name: 'Kirim tautan' }).click();
	await expect(page.getByRole('status')).toContainText('hanya bisa dipakai sekali');

	const resetToken = await tokenFromQueuedEmail(email, 'password-reset');
	const resetPath = `/set-password?token=${encodeURIComponent(resetToken)}`;
	await page.goto(resetPath);
	await page.getByLabel('Kata sandi baru', { exact: true }).fill(newPassword);
	await page.getByLabel('Ulangi kata sandi baru').fill(newPassword);
	await page.getByRole('button', { name: 'Simpan kata sandi' }).click();
	await expect(page).toHaveURL(/\/login/);

	// The same link a second time is refused, because using it deleted it.
	await page.goto(resetPath);
	await page.getByLabel('Kata sandi baru', { exact: true }).fill(newPassword);
	await page.getByLabel('Ulangi kata sandi baru').fill(newPassword);
	await page.getByRole('button', { name: 'Simpan kata sandi' }).click();
	await expect(page.getByRole('alert')).toContainText('sudah tidak berlaku');

	// The old password is gone, not merely joined by a new one.
	await signIn(page, email);
	await expect(page.getByRole('alert')).toContainText('Email atau kata sandi salah');

	await signIn(page, email, newPassword);
	await expect(page).toHaveURL(`${baseURL}/`);
});
