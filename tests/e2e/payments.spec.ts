import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The one browser flow `docs/spec-iuran-v1.md` names for this spec: a warga records a payment with
 * its proof, an admin verifies it, and the warga sees the Tagihan lunas. Everything else about
 * verification — atomicity, allocation order, the cash row, the audit trail — is service-layer
 * ground held by `tests/unit/payment-verification.test.ts`; this file only proves the two screens
 * really carry a person through it.
 *
 * The sign-up helpers are copied from `tests/e2e/file-serving.spec.ts` rather than imported:
 * importing a spec file would register its tests a second time, and this repository keeps no shared
 * e2e helper module yet. The unit, the Masa Huni and the Tagihan are planted through SQL, because
 * building them through the superuser screens would make this file a test of four other features
 * before it reaches its own.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued verification email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi verifikasi pembayaran';

/** The label on the address field in the registration and login forms. */
const EMAIL_FIELD = 'Alamat email';

/** A 1×1 transparent PNG — a real image, so the proof passes the magic-number check. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

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
	return `e2e-payments-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** The calendar month the run is happening in, as `YYYY-MM` — the period the Tagihan is issued for. */
function currentPeriod(): string {
	return new Date().toISOString().slice(0, 7);
}

/** Today as `YYYY-MM-DD`, for the day the money changed hands. */
function today(): string {
	return new Date().toISOString().slice(0, 10);
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

/** Registers an account, verifies its address, and answers its `user.id`. Signed out afterwards. */
async function signUp(page: Page, email: string, name: string): Promise<string> {
	await open(page, '/register');
	await page.getByLabel('Nama').fill(name);
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Blok rumah').fill('E2EP');
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
	return userId;
}

/** Signs `email` in on `page`. */
async function logIn(page: Page, email: string): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	// The session has to have landed before the caller navigates — see the same wait, with its
	// reasoning, in `tests/e2e/posts-public.spec.ts`.
	await expect(page).toHaveURL(/\/$/);
}

/** Gives an account a `residents` row, and answers its id. */
async function insertResident(userId: string): Promise<string> {
	const { rows } = await pool().query<{ id: string }>(
		'insert into residents (user_id, created_at) values ($1, now()) returning id',
		[userId]
	);
	return rows[0].id;
}

test('a warga records a payment with proof, an admin verifies it, and the Tagihan reads lunas', async ({
	page,
	browser
}) => {
	// ── The stage: a house, its resident, and one Tagihan of Rp150.000 for this month. ──
	const residentEmail = anAddress('warga');
	const residentUserId = await signUp(page, residentEmail, 'Warga E2E Pembayaran');
	const residentId = await insertResident(residentUserId);

	const unitNumber = String(Date.now());
	const { rows: unitRows } = await pool().query<{ id: string }>(
		"insert into units (block, number, created_at) values ('E2EP', $1, now()) returning id",
		[unitNumber]
	);
	const unitId = unitRows[0].id;
	await pool().query(
		"insert into occupancies (unit_id, resident_id, role, started_on, is_primary_occupant, created_at) values ($1, $2, 'owner', '2025-01-01', true, now())",
		[unitId, residentId]
	);
	const period = currentPeriod();
	await pool().query(
		'insert into invoices (unit_id, period, amount, due_date, issued_at) values ($1, $2, 150000, $3, now())',
		[unitId, period, `${period}-05`]
	);

	const unitLabel = `Blok E2EP No ${unitNumber}`;

	// ── The warga records the transfer, with the photo of its receipt. ──
	await logIn(page, residentEmail);
	await open(page, '/payments/new');
	// One house, so the form fixes the unit; ticking the Tagihan fills the amount in.
	//
	// The nominal is a RupiahInput, which is two inputs behaving as one control, so both halves are
	// checked here: the labelled visible input reads the grouped 150.000, and the field actually named
	// `amount` — the hidden one beside it, which is what gets posted — still holds the plain 150000
	// that `parseRupiah` turns into money. Asserting only the visible half would pass while the form
	// posted nothing at all.
	await expect(page.getByText(period)).toBeVisible();
	await page.getByRole('checkbox').first().check();
	await expect(page.getByLabel('Nominal yang ditransfer')).toHaveValue('150.000');
	await expect(page.locator('input[name="amount"]')).toHaveValue('150000');
	await page.getByLabel('Tanggal uang ditransfer').fill(today());
	await page
		.locator('input[name="proof"]')
		.setInputFiles({ name: 'bukti.png', mimeType: 'image/png', buffer: PNG });
	await page.getByRole('button', { name: 'Catat pembayaran' }).click();

	await expect(page).toHaveURL(/\/payments\?recorded=1/);
	await expect(page.getByText('Menunggu verifikasi').first()).toBeVisible();

	// ── The admin opens the queue, sees the proof link, and verifies. ──
	const adminEmail = anAddress('pengurus');
	const adminContext = await browser.newContext();
	const adminPage = await adminContext.newPage();
	const adminUserId = await signUp(adminPage, adminEmail, 'Pengurus E2E Pembayaran');
	await pool().query(
		"insert into user_roles (user_id, role, created_at) values ($1, 'admin', now())",
		[adminUserId]
	);
	await insertResident(adminUserId);
	await logIn(adminPage, adminEmail);

	await adminPage.goto('/admin/payments');
	const queueRow = adminPage.locator('article').filter({ hasText: unitLabel });
	await expect(queueRow).toHaveCount(1);
	// The proof opens through a short-lived signed link — the criterion's "bukti yang bisa dibuka".
	await expect(queueRow.getByRole('link', { name: 'Lihat bukti' })).toBeVisible();
	await queueRow.getByRole('button', { name: 'Verifikasi' }).click();

	await expect(adminPage.getByRole('status')).toContainText('terverifikasi');
	// The queue no longer offers it: the decision is made.
	await expect(adminPage.locator('article').filter({ hasText: unitLabel })).toHaveCount(0);
	await adminContext.close();

	// ── The warga sees the outcome without asking anybody. ──
	await page.goto('/payments');
	await expect(page.getByText('Terverifikasi').first()).toBeVisible();

	await page.goto('/invoices');
	await expect(page.getByText(`Tagihan ${period}`)).toBeVisible();
	await expect(page.getByText('Lunas', { exact: true })).toBeVisible();

	// This run's rows stay in the development database like every other spec's do; the block E2EP
	// and a timestamped unit number keep them out of any other run's way, and a colliding rerun
	// fails loudly on the units unique pair rather than silently sharing a house.
});
