import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The announcement board's public side, through a real browser — `docs/spec-konten-v1.md`'s
 * testing decision: "Playwright dipakai untuk satu alur: admin menerbitkan kegiatan, lalu peramban
 * tanpa sesi membuka tautannya dan membacanya."
 *
 * There is no seeded admin account, so this spec registers a resident through the same flow
 * `tests/e2e/auth.spec.ts` uses and then grants the `admin` role and a `residents` row directly
 * against the database — the shortest path to an admin account this repository has, the same
 * reasoning that file's own comments give for reading a queued email straight out of `email_queue`
 * rather than waiting for a worker that is not running under this harness.
 *
 * ## What this spec does not attempt
 *
 * It never uploads a cover image. `(public)/posts/+page.server.ts`'s own doc comment names the
 * reason: `LocalFileStore.signedLink` returns a path under `/files/…`, and no route in this
 * repository answers a request there yet, so an `<img>` or an `og:image` built from a real upload
 * would 404 for reasons outside this ticket's `writes:`. The `og:title`, `og:description` and
 * `og:url` tags this spec does check do not depend on that gap.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued verification email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi papan publik';

/** The label on the address field in the registration form. */
const EMAIL_FIELD = 'Alamat email';

const pool = new Pool({ connectionString: DATABASE_URL });

test.afterAll(async () => {
	await pool.end();
});

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-posts-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
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

/** Registers a resident, verifies their address, signs them in, and grants them the admin role. */
async function signUpAdmin(page: Page, email: string): Promise<void> {
	await page.goto('/register');
	await page.getByLabel('Nama').fill('Pengurus E2E');
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

	const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [
		email
	]);
	const userId = rows[0]?.id;
	if (!userId) {
		throw new Error(`No "user" row was found for ${email} after verifying.`);
	}
	await pool.query(
		"insert into user_roles (user_id, role, created_at) values ($1, 'admin', now())",
		[userId]
	);
	await pool.query('insert into residents (user_id, created_at) values ($1, now())', [userId]);

	await page.goto('/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

/** A `datetime-local` value for `daysAhead` days from now, in the server's own zone. */
function futureLocalDateTime(daysAhead: number): string {
	const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test('an admin publishes a kegiatan, and a browser with no session opens it from the board and reads it', async ({
	page,
	browser
}) => {
	const email = anAddress('publish');
	const title = `Kerja bakti E2E ${Date.now()}`;

	await signUpAdmin(page, email);

	await page.goto('/admin/posts/new');
	await page.getByLabel('Judul').fill(title);
	await page.getByLabel('Ringkasan').fill('Kerja bakti bulanan di lapangan komplek.');
	await page.getByLabel('Isi').fill('Bawa **sapu** dan cangkul.');
	await page.getByLabel('Waktu mulai').fill(futureLocalDateTime(7));
	await page.getByLabel('Waktu selesai').fill(futureLocalDateTime(7));
	await page.getByLabel('Lokasi').fill('Lapangan komplek');
	await page.getByRole('button', { name: 'Simpan draf' }).click();

	// A uuid-shaped final segment only — `/\/admin\/posts\/[^/]+$/` also matches
	// `/admin/posts/new` itself, which would read `postId` back as the literal string `new` if this
	// assertion somehow ran before the save navigated away. See #111.
	await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]{36}$/);
	const postId = page.url().split('/').pop();

	await page.getByRole('button', { name: 'Terbitkan' }).click();
	await expect(page.getByRole('status')).toContainText('sudah tampil di papan pengumuman');

	// A fresh context: no cookie, no session, exactly the "peramban tanpa sesi" the spec asks for.
	const anonymousContext = await browser.newContext();
	const anonymousPage = await anonymousContext.newPage();

	// The board lists the kegiatan before a visitor ever opens its link, which is what makes the
	// link worth sharing in the first place.
	await anonymousPage.goto('/posts');
	await expect(anonymousPage.getByRole('heading', { level: 2, name: title })).toBeVisible();

	// The link itself — what a visitor who followed it from WhatsApp would actually open.
	await anonymousPage.goto(`/posts/${postId}`);
	await expect(anonymousPage.getByRole('heading', { level: 1 })).toHaveText(title);
	await expect(anonymousPage.locator('.post-body')).toContainText('Bawa');
	await expect(anonymousPage.locator('.post-body strong')).toHaveText('sapu');

	await expect(anonymousPage.locator('meta[property="og:title"]')).toHaveAttribute(
		'content',
		title
	);
	await expect(anonymousPage.locator('meta[property="og:description"]')).toHaveAttribute(
		'content',
		'Kerja bakti bulanan di lapangan komplek.'
	);
	await expect(anonymousPage.locator('meta[property="og:url"]')).toHaveAttribute(
		'content',
		new RegExp(`/posts/${postId}$`)
	);

	// The public navigation carries no link a signed-out visitor could not use — see
	// `tests/e2e/layout.spec.ts` for the same check on the home page; this proves it holds here too.
	const nav = anonymousPage.getByRole('navigation', { name: 'Navigasi utama' });
	await expect(nav.getByRole('link', { name: 'Kelola Peran' })).toHaveCount(0);
	await expect(nav.getByRole('button', { name: 'Keluar' })).toHaveCount(0);

	await anonymousContext.close();
});

test('a draft Post answers 404 to a browser with no session, even with its real id', async ({
	page,
	browser
}) => {
	const email = anAddress('draft');
	await signUpAdmin(page, email);

	await page.goto('/admin/posts/new');
	await page.getByLabel('Judul').fill(`Draf tidak terbit ${Date.now()}`);
	await page.getByLabel('Ringkasan').fill('Belum siap dibagikan.');
	await page.getByLabel('Isi').fill('Isi belum final.');
	await page.getByLabel('Tipe').selectOption('announcement');
	await page.getByRole('button', { name: 'Simpan draf' }).click();

	// A uuid-shaped final segment only — see the note on the same pattern in the previous test.
	await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]{36}$/);
	const draftId = page.url().split('/').pop();

	const anonymousContext = await browser.newContext();
	const anonymousPage = await anonymousContext.newPage();

	const response = await anonymousPage.goto(`/posts/${draftId}`);
	expect(response?.status()).toBe(404);

	const guessedResponse = await anonymousPage.goto(`/posts/${randomUUID()}`);
	expect(guessedResponse?.status()).toBe(404);

	// #111: a `params.id` that is not shaped like a uuid at all — `new` (this route's own sibling
	// segment under `/admin/posts/new`), a short word, or a bare digit — must answer 404 exactly
	// like a real-but-missing uuid, never a 500.
	for (const nonUuidId of ['new', 'abc', '1']) {
		const nonUuidResponse = await anonymousPage.goto(`/posts/${nonUuidId}`);
		expect(nonUuidResponse?.status()).toBe(404);
	}

	await anonymousContext.close();
});
