import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Keluhan, through a real browser — `docs/spec-keluhan-v1.md`'s testing decision: "Playwright
 * dipakai untuk satu alur: warga melapor dengan satu foto, admin memindahkan statusnya sampai
 * selesai, warga melihat statusnya berubah."
 *
 * Two accounts, the same shortest path `tests/e2e/posts-public.spec.ts` already takes to get one:
 * registering through the real `/register` flow, verifying the address by reading the queued email
 * straight out of `email_queue`, and granting the `admin` role directly against the database — this
 * repository has no seeded admin account and no worker running under this harness to deliver a real
 * email.
 *
 * A signed link is never asserted against directly. `page.getByRole('link', { name: … })` clicking
 * through to the photograph, inside the same browser context that reported it, is what proves
 * "lampiran hanya bisa dibuka lewat tautan bertanda tangan berumur pendek oleh pihak yang berhak
 * membaca keluhannya" the way a resident actually experiences it, without this spec parsing the
 * query string `buildSignedLink` produces — `tests/unit/complaint-attachment.test.ts` and
 * `payment-proof.test.ts` already prove that shape at the unit level.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued verification email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi lapor keluhan';

/** The label on the address field in the registration form. */
const EMAIL_FIELD = 'Alamat email';

/** The first bytes a real JPEG starts with — enough for the attachment's signature check. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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
	return `e2e-complaints-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
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

/**
 * Registers an account, verifies its address, and gives it a `residents` row. Returns its
 * `user.id`, and leaves the browser signed out — verifying deliberately does not sign anyone in.
 */
async function register(page: Page, email: string, name: string): Promise<string> {
	await open(page, '/register');
	await page.getByLabel('Nama').fill(name);
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Blok rumah').fill('E2E');
	await page.getByLabel('Nomor rumah').fill('0');
	await page.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Ulangi kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await expect(page).toHaveURL(/\/verify/);

	const token = await verificationToken(email);
	await page.goto(`/verify?token=${encodeURIComponent(token)}`);

	const { rows } = await pool().query<{ id: string }>('select id from "user" where email = $1', [
		email
	]);
	const userId = rows[0]?.id;
	if (!userId) {
		throw new Error(`No "user" row was found for ${email} after verifying.`);
	}
	await pool().query('insert into residents (user_id, created_at) values ($1, now())', [userId]);
	return userId;
}

/**
 * Signs an already registered account in, and waits until the session has really landed.
 *
 * The wait is the point. Clicking the button only posts the form; the response that carries the
 * session cookie is still in flight when `click` resolves, so a `goto` on the next line races it
 * and can be answered with no session at all.
 */
async function signIn(page: Page, email: string): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	await expect(page).toHaveURL(/\/$/);
}

/** Registers a resident, verifies their address, and signs them in. Grants no role beyond it. */
async function signUpResident(page: Page, email: string, name: string): Promise<void> {
	await register(page, email, name);
	await signIn(page, email);
}

/**
 * The same, and also grants the `admin` role — the shortest path to a pengurus account.
 *
 * The grant happens **before** the one sign-in this helper makes, rather than after it with a
 * second visit to `/login`. `(auth)/login/+page.server.ts`'s `load` redirects an account that is
 * already signed in straight to `/`, so a second visit never renders the form at all: the version
 * of this helper that signed in twice spent its whole thirty seconds waiting for an "Alamat email"
 * field the redirect had taken away, which is the failure #112 was opened for.
 *
 * Nothing needed that second session. Roles are read out of `user_roles` on every request — by
 * `(app)/+layout.server.ts` and by `requirePermission` — and `session.cookieCache` is deliberately
 * off in `$lib/server/auth`, so a grant takes effect on the next request whether the session that
 * carries it is new or not.
 */
async function signUpAdmin(page: Page, email: string, name: string): Promise<void> {
	const userId = await register(page, email, name);
	await pool().query(
		"insert into user_roles (user_id, role, created_at) values ($1, 'admin', now())",
		[userId]
	);
	await signIn(page, email);
}

/** Moves a Keluhan one step through the admin dialog, on a page already at its detail screen. */
async function changeStatus(page: Page, to: string): Promise<void> {
	await page.getByRole('button', { name: 'Ubah status' }).click();
	await page.getByLabel('Status baru').selectOption({ label: to });
	await page.getByRole('button', { name: 'Simpan' }).click();
}

test('a resident reports a complaint with one photo, an admin moves it to selesai, and the resident sees it change', async ({
	page,
	browser
}) => {
	const reporterEmail = anAddress('reporter');
	const adminEmail = anAddress('admin');
	const title = `Lampu jalan mati E2E ${Date.now()}`;

	await signUpResident(page, reporterEmail, 'Warga E2E Keluhan');

	await open(page, '/complaints/new');
	await page.getByLabel('Judul').fill(title);
	await page.getByLabel('Kategori').fill('penerangan');
	await page.getByLabel('Uraian').fill('Lampu di depan blok E2E sudah mati sejak tiga hari lalu.');
	await page
		.getByLabel('Foto (opsional, maksimal tiga)')
		.setInputFiles({ name: 'bukti.jpg', mimeType: 'image/jpeg', buffer: JPEG });
	await page.getByRole('button', { name: 'Kirim keluhan' }).click();

	await expect(page).toHaveURL(/\/complaints\/[^/]+\?created=1$/);
	const complaintId = page.url().split('/').pop()?.split('?')[0];
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
	await expect(page.getByText('Baru')).toBeVisible();

	// The photograph is reachable, through a signed link, from inside the same session that
	// reported it — story "Lampiran hanya bisa dibuka lewat tautan bertanda tangan berumur pendek
	// oleh pihak yang berhak membaca keluhannya".
	const photoLink = page.getByRole('link', { name: 'Lihat foto 1' });
	await expect(photoLink).toBeVisible();
	const photoHref = await photoLink.getAttribute('href');
	expect(photoHref).toMatch(/^\/files\/complaints\/.+\?expires=\d+&signature=/);

	// A second browser context: the pengurus's own session, so the resident's cookie never crosses
	// into the admin's browsing.
	const adminContext = await browser.newContext();
	const adminPage = await adminContext.newPage();
	await signUpAdmin(adminPage, adminEmail, 'Pengurus E2E Keluhan');

	// `open()`, not a bare `goto`: `changeStatus` below clicks "Ubah status", which only opens the
	// dialog through an `onclick` handler (`showModal()`), so a click before hydration does nothing,
	// and `getByLabel('Status baru')` would then wait the full 30 seconds for a dialog that never
	// shows.
	await open(adminPage, `/admin/complaints/${complaintId}`);
	await expect(adminPage.getByRole('heading', { level: 1 })).toHaveText(title);

	await changeStatus(adminPage, 'Ditinjau');
	await expect(adminPage.getByText('Status keluhan diperbarui.')).toBeVisible();
	await changeStatus(adminPage, 'Dikerjakan');
	await expect(adminPage.getByText('Status keluhan diperbarui.')).toBeVisible();
	await changeStatus(adminPage, 'Selesai');
	await expect(adminPage.getByText('Status keluhan diperbarui.')).toBeVisible();

	await adminContext.close();

	// Back on the resident's own session: the same complaint now reads "Selesai", with no reload
	// needed beyond the one a resident would actually do — visiting the page again.
	await page.goto(`/complaints/${complaintId}`);
	// `exact`, because the page now carries the history of the change as well as its outcome: the
	// status badge reads "Selesai" and the log line reads "Dikerjakan → Selesai", and a substring
	// match resolves to both and fails Playwright's strict mode. The badge is what this assertion
	// is about — that the status a warga reads really moved.
	await expect(page.getByText('Selesai', { exact: true })).toBeVisible();
	// The "tarik keluhan" button is gone: it only ever shows while the complaint is still "baru".
	await expect(page.getByRole('button', { name: 'Tarik keluhan' })).toHaveCount(0);
});
