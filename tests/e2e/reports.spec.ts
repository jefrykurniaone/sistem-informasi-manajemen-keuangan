import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The one browser flow `docs/spec-kas-laporan-v1.md` asks for: "admin menerbitkan laporan, warga
 * membukanya dan melihat rincian kategori" — plus the criterion that a visitor with no account is
 * turned away from a report altogether.
 *
 * ## What is driven through the browser, and what is not
 *
 * Only the report flow. The buku kas rows the report is *made of* are written straight into the
 * database here, the same shortcut `tests/e2e/posts-public.spec.ts` takes for roles and queued
 * email: they are #33's and #34's screens, they already have their own service-layer tests, and
 * clicking through them would make this spec fail for reasons outside the feature it covers. What
 * is genuinely under test is the publication, the resident's reading of it, and the drill-down.
 *
 * ## Which month
 *
 * Everything is dated inside the calendar month the complex is in **in `Asia/Jakarta`**, because
 * that is the month `/admin/reports` previews by default — see
 * `src/lib/server/services/report/composition.ts` for why that zone and not UTC. Computing it here
 * the same way keeps this spec from breaking for seven hours a day.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued verification email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi laporan bulanan';

/** The label on the address field in the registration and sign-in forms. */
const EMAIL_FIELD = 'Alamat email';

/** The complex's own time zone, which is the calendar a report's month is read against. */
const COMPLEX_TIME_ZONE = 'Asia/Jakarta';

const pool = new Pool({ connectionString: DATABASE_URL });

test.afterAll(async () => {
	await pool.end();
});

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-reports-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** Today as `YYYY-MM-DD` in the complex's own zone, built from the parts so locale order is irrelevant. */
function todayInComplexZone(): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: COMPLEX_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date());
	const partOfType = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${partOfType('year')}-${partOfType('month')}-${partOfType('day')}`;
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

/** Registers an account, verifies its address, and gives it a `residents` row. Returns its id. */
async function signUp(page: Page, email: string, name: string): Promise<string> {
	await page.goto('/register');
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

	const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [
		email
	]);
	const userId = rows[0]?.id;
	if (!userId) {
		throw new Error(`No "user" row was found for ${email} after verifying.`);
	}
	// A `residents` row is what `(app)/+layout.server.ts` reads as "has been admitted"; without one a
	// plain warga is sent to `/pending-approval` instead of to the report.
	await pool.query('insert into residents (user_id, created_at) values ($1, now())', [userId]);
	return userId;
}

/** Signs an already-registered account in. */
async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

/** Grants a role directly, the same shortcut `tests/e2e/posts-public.spec.ts` takes. */
async function grant(userId: string, role: 'admin' | 'superuser'): Promise<void> {
	await pool.query('insert into user_roles (user_id, role, created_at) values ($1, $2, now())', [
		userId,
		role
	]);
}

/** One Kategori Kas and one Transaksi Kas in it, written straight into the database. */
async function recordExpense(
	recordedBy: string,
	categoryName: string,
	occurredOn: string,
	amount: number,
	description: string
): Promise<string> {
	const categoryId = randomUUID();
	await pool.query(
		"insert into cash_categories (id, name, type, is_active, created_at) values ($1, $2, 'expense', true, now())",
		[categoryId, categoryName]
	);
	await pool.query(
		"insert into cash_transactions (occurred_on, type, category_id, amount, description, recorded_by, created_at) values ($1, 'expense', $2, $3, $4, $5, now())",
		[occurredOn, categoryId, amount, description, recordedBy]
	);
	return categoryId;
}

test('an admin publishes a report, and a warga opens it and drills into a category', async ({
	page,
	browser
}) => {
	const adminEmail = anAddress('admin');
	const residentEmail = anAddress('warga');
	const day = todayInComplexZone();
	const period = day.slice(0, 'YYYY-MM'.length);
	const categoryName = `Perbaikan gerbang E2E ${Date.now()}`;
	const description = `Las ulang engsel gerbang ${Date.now()}`;

	const adminId = await signUp(page, adminEmail, 'Pengurus Laporan E2E');
	await grant(adminId, 'admin');
	await recordExpense(adminId, categoryName, day, 750_000, description);
	await signIn(page, adminEmail);

	// The publication itself: the preview shows this month's figures, and the button freezes them.
	await page.goto('/admin/reports');
	await expect(page.getByRole('heading', { name: `Pratinjau periode ${period}` })).toBeVisible();
	await expect(page.getByRole('cell', { name: categoryName })).toBeVisible();
	await page.getByRole('button', { name: 'Terbitkan laporan' }).click();
	await expect(page.getByRole('status')).toContainText('sekarang terkunci');

	// A different person, with no pengurus role at all, reads what was published.
	const residentContext = await browser.newContext();
	const residentPage = await residentContext.newPage();
	await signUp(residentPage, residentEmail, 'Warga Pembaca Laporan E2E');
	await signIn(residentPage, residentEmail);

	await residentPage.goto('/reports');
	await residentPage.getByRole('link', { name: `Buka laporan ${period}` }).click();
	await expect(residentPage).toHaveURL(new RegExp(`/reports/${period}$`));
	await expect(residentPage.getByRole('heading', { level: 1 })).toHaveText(
		`Laporan bulanan ${period}`
	);
	await expect(residentPage.getByText('Revisi 1,')).toBeVisible();

	// The breakdown, and then the drill-down user story 20 asks for.
	await expect(
		residentPage.getByRole('heading', { name: 'Rincian pengeluaran per kategori' })
	).toBeVisible();
	const expenseRow = residentPage.getByRole('row').filter({ hasText: categoryName });
	await expect(expenseRow).toContainText('Rp 750.000');
	await expenseRow.getByRole('link', { name: 'Lihat transaksi' }).click();

	await expect(
		residentPage.getByRole('heading', { name: `Transaksi kategori ${categoryName}` })
	).toBeVisible();
	await expect(residentPage.getByText(description)).toBeVisible();

	// The iuran summary is three numbers and a sentence saying so — no name, no house.
	await expect(residentPage.getByText('Rumah lunas')).toBeVisible();
	await expect(residentPage.getByText('tidak memuat nama siapa pun')).toBeVisible();

	await residentContext.close();
});

test('a browser with no session is sent to the sign-in page instead of a report', async ({
	browser
}) => {
	// "Laporan hanya bisa dibuka setelah masuk; pengunjung tanpa akun ditolak" — the criterion the
	// service layer deliberately cannot answer, because it has no session to look at.
	const anonymousContext = await browser.newContext();
	const anonymousPage = await anonymousContext.newPage();

	await anonymousPage.goto('/reports');
	await expect(anonymousPage).toHaveURL(/\/login/);

	await anonymousPage.goto(`/reports/${todayInComplexZone().slice(0, 'YYYY-MM'.length)}`);
	await expect(anonymousPage).toHaveURL(/\/login/);

	await anonymousContext.close();
});
