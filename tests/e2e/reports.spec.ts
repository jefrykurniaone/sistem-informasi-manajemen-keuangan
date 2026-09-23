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
 * ## Which month, and why it is not this one
 *
 * A month of this run's own, picked out of a stretch of history nothing else in this repository
 * touches, and dated inside it — never the calendar month the complex is in now. Two reasons, both
 * found by running this file twice:
 *
 * - **Publishing locks the month.** `publishReport` locks the Periode inside its own transaction,
 *   and `lockPeriod` refuses a month that is already locked. A second run of this spec against the
 *   same database would therefore be refused on the month the first run published — the suite has
 *   to pass twice in a row on one database, so the month it publishes has to be free every time.
 * - **The current month is where every other spec's money is.** `payments.spec.ts` issues a
 *   Tagihan for it and verifies a payment, which writes a Transaksi Kas dated today; under
 *   `fullyParallel` that happens while this file is running. Locking the current month here would
 *   refuse that write for reasons that have nothing to do with either spec.
 *
 * `anUnusedPeriod` reads `periods` and takes the first month in that stretch the buku kas has
 * never heard of, so runs do not collide with each other either. `/admin/reports` previews
 * whichever month `?period=` names — `periodFrom` in its `+page.server.ts` — so a month in the
 * past is previewed and published exactly like the current one.
 *
 * The second test below still asks for the month the complex is in **in `Asia/Jakarta`**, because
 * it only proves a signed-out browser is turned away and that is the address a warga would type;
 * see `src/lib/server/services/report/composition.ts` for why that zone and not UTC.
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

/**
 * The first year of the stretch of history this spec publishes in. Long before any complex this
 * application will ever run for, so a month taken from it is never one a real buku kas needs and
 * never one another spec is recording in.
 */
const FIRST_ARCHIVE_YEAR = 1900;

/**
 * How many years of that stretch are on offer. Twelve months each and one month per run, so this
 * spec can be run 1200 times against one database before `anUnusedPeriod` runs out.
 */
const ARCHIVE_YEARS = 100;

/** How many months a year has, written down so the walk below reads as a calendar. */
const MONTHS_IN_A_YEAR = 12;

/** The day of the month this spec dates its Transaksi Kas on. Any day inside the month will do. */
const A_DAY_IN_THE_MONTH = '15';

/** The Indonesian month names `monthLabel` reads a `YYYY-MM` period into, index 0 is January. */
const MONTH_NAMES_ID = [
	'Januari',
	'Februari',
	'Maret',
	'April',
	'Mei',
	'Juni',
	'Juli',
	'Agustus',
	'September',
	'Oktober',
	'November',
	'Desember'
];

/**
 * `"2026-09"` read as `"September 2026"` — the same text `$lib/time`'s `formatMonthLabel` writes
 * for the `id` locale, reimplemented here rather than imported: this file runs outside Vite, with
 * no `$lib` alias, the same reason `todayInComplexZone` below does its own zone arithmetic instead
 * of importing `$lib/time`.
 */
function monthLabel(period: string): string {
	const [year, month] = period.split('-').map(Number);
	return `${MONTH_NAMES_ID[month - 1]} ${year}`;
}

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
	return `e2e-reports-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/**
 * A calendar month, as `YYYY-MM`, that the buku kas has never heard of — no `periods` row, so
 * nothing has ever been recorded in it, published for it, or locked on it.
 *
 * See this file's doc comment for why the month is taken from history rather than from the
 * calendar: publishing locks a month for good, and the month the complex is in now belongs to
 * every other spec.
 *
 * @throws {Error} when every month on offer has been used, which means this database has run this
 *   spec more than `ARCHIVE_YEARS * MONTHS_IN_A_YEAR` times and wants throwing away.
 */
async function anUnusedPeriod(): Promise<string> {
	const { rows } = await pool().query<{ year: number; month: number }>(
		'select year, month from periods where year >= $1 and year < $2',
		[FIRST_ARCHIVE_YEAR, FIRST_ARCHIVE_YEAR + ARCHIVE_YEARS]
	);
	const taken = new Set(rows.map((row) => asPeriod(row.year, row.month)));

	for (let year = FIRST_ARCHIVE_YEAR; year < FIRST_ARCHIVE_YEAR + ARCHIVE_YEARS; year += 1) {
		for (let month = 1; month <= MONTHS_IN_A_YEAR; month += 1) {
			const period = asPeriod(year, month);
			if (!taken.has(period)) {
				return period;
			}
		}
	}
	throw new Error(
		`Every month from ${FIRST_ARCHIVE_YEAR} on has already been published by a run of this spec.`
	);
}

/** A year and a month as the `YYYY-MM` every address, heading and assertion below is written in. */
function asPeriod(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, '0')}`;
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

/** Registers an account, verifies its address, and gives it a `residents` row. Returns its id. */
async function signUp(page: Page, email: string, name: string): Promise<string> {
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
	// A `residents` row is what `(app)/+layout.server.ts` reads as "has been admitted"; without one a
	// plain warga is sent to `/pending-approval` instead of to the report.
	await pool().query('insert into residents (user_id, created_at) values ($1, now())', [userId]);
	return userId;
}

/**
 * Signs an already-registered account in, and waits until the session has really landed.
 *
 * Clicking the button only posts the form; the response that carries the session cookie is still
 * in flight when `click` resolves, so the `goto` on the next line would otherwise race it and be
 * answered with no session.
 */
async function signIn(page: Page, email: string): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	await expect(page).toHaveURL(/\/$/);
}

/** Grants a role directly, the same shortcut `tests/e2e/posts-public.spec.ts` takes. */
async function grant(userId: string, role: 'admin' | 'superuser'): Promise<void> {
	await pool().query('insert into user_roles (user_id, role, created_at) values ($1, $2, now())', [
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
	await pool().query(
		"insert into cash_categories (id, name, type, is_active, created_at) values ($1, $2, 'expense', true, now())",
		[categoryId, categoryName]
	);
	await pool().query(
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
	const period = await anUnusedPeriod();
	const day = `${period}-${A_DAY_IN_THE_MONTH}`;
	const categoryName = `Perbaikan gerbang E2E ${Date.now()}`;
	const description = `Las ulang engsel gerbang ${Date.now()}`;

	const adminId = await signUp(page, adminEmail, 'Pengurus Laporan E2E');
	await grant(adminId, 'admin');
	await recordExpense(adminId, categoryName, day, 750_000, description);
	await signIn(page, adminEmail);

	// The publication itself: the preview shows that month's figures, and the button freezes them.
	// `open`, not a bare `goto`: switching the period below relies on the `<select>`'s own `change`
	// handler, which is only attached once hydration has run.
	await open(page, `/admin/reports?period=${period}`);
	await expect(page.getByRole('heading', { name: monthLabel(period) })).toBeVisible();
	// A category's name is the row's own header — `<th scope="row">` in
	// `src/lib/components/report/category-table.svelte` — so its role is `rowheader`, not `cell`.
	// `getByRole('cell', …)` matched nothing and never would have.
	await expect(page.getByRole('rowheader', { name: categoryName })).toBeVisible();

	// No button to press: changing the period `<select>` submits the same GET form on its own, and
	// the preview heading follows it without a further click.
	const periodForm = page.locator('form', { has: page.getByLabel('Periode') });
	await expect(periodForm.getByRole('button')).toHaveCount(0);
	const currentPeriod = todayInComplexZone().slice(0, 'YYYY-MM'.length);
	await periodForm.getByLabel('Periode').selectOption(currentPeriod);
	await expect(page).toHaveURL(new RegExp(`[?&]period=${currentPeriod}(&|$)`));
	await expect(page.getByRole('heading', { name: monthLabel(currentPeriod) })).toBeVisible();

	// Back to the month this run publishes, to resume the flow above.
	await open(page, `/admin/reports?period=${period}`);
	await expect(page.getByRole('rowheader', { name: categoryName })).toBeVisible();
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
	// Scoped to the summary, whose `<section>` is labelled with the Periode — the revision banner
	// and the list of revisions further down the page carry the same sentence, and an unscoped
	// match resolves to both and fails Playwright's strict mode.
	await expect(
		residentPage.getByRole('region', { name: period }).getByText('Revisi 1,')
	).toBeVisible();

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
