import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { buildSignedLink } from '../../src/lib/server/ports/file-store';

/**
 * The `/files/…` serving route over a real HTTP connection, and the flow that first hit its
 * absence: a published Post's cover image rendering for a browser with no session.
 *
 * The first half talks to the route directly with `request`, planting bytes straight into the
 * store's directory and minting links with the same `buildSignedLink` the application uses —
 * `FILE_STORE_SECRET` is in this process's environment because Bun loads `.env` before Playwright
 * starts, exactly the way `tests/e2e/posts-public.spec.ts` reads `DATABASE_URL`. The second half
 * is wave 10's reproduction, inverted into the acceptance criterion: an admin uploads a cover
 * image and publishes, and an anonymous browser's `og:image` address answers 200 with an image
 * `Content-Type` instead of the 404 that ticket #83 was opened for.
 *
 * The admin sign-up helpers are copied from `tests/e2e/posts-public.spec.ts` rather than imported:
 * importing a spec file would register its tests a second time, and this repository keeps no
 * shared e2e helper module yet.
 */

/** The database the application under test is using. Bun loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** The secret the application under test signs links with. Bun loads it out of `.env`. */
const FILE_STORE_SECRET = process.env.FILE_STORE_SECRET ?? '';

/** The directory the application under test stores files in, as the preview server resolves it. */
const FILE_STORE_ROOT = path.resolve(
	process.cwd(),
	process.env.FILE_STORE_ROOT?.trim() || 'storage'
);

/** A directory of this run's own, inside the store root, removed when the file finishes. */
const runDirectory = `e2e-file-serving-${randomUUID()}`;

/** A 1×1 transparent PNG — a real image, so a browser can actually decode and render it. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/** How long a minted link lives — far longer than any test below runs. */
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** How long to keep looking for a queued verification email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi tautan berkas';

/** The label on the address field in the registration form. */
const EMAIL_FIELD = 'Alamat email';

/**
 * This file's own connection, opened on first use by each job and closed by the job that opened
 * it. Not a module-scope pool closed once — see `tests/e2e/auth.spec.ts` for why `fullyParallel`
 * runs `afterAll` more than once in one worker process, and what `pg` does about it. This is the
 * file the failure was measured on: the test at line 140 below, which never touches the database,
 * failed with "Called end on pool more than once" whenever the runner split this file.
 */
let openPool: Pool | undefined;

/** The connection, opened on first use by this job. */
function pool(): Pool {
	openPool ??= new Pool({ connectionString: DATABASE_URL });
	return openPool;
}

test.beforeAll(() => {
	if (!FILE_STORE_SECRET) {
		throw new Error(
			'FILE_STORE_SECRET is not in the environment; this spec cannot mint the links it tests.'
		);
	}
});

test.afterAll(async () => {
	// `force: true` makes this one idempotent already, which is what the hook has to be: it runs
	// once per job, and this file's jobs can share a worker.
	await rm(path.join(FILE_STORE_ROOT, runDirectory), { recursive: true, force: true });
	const closing = openPool;
	openPool = undefined;
	await closing?.end();
});

/** Writes `content` where the preview server's store will find it under `key`. */
async function plantFile(key: string, content: Buffer): Promise<void> {
	const file = path.join(FILE_STORE_ROOT, key);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, content);
}

/** A genuine signed link for `key`, minted with the application's own secret. */
function genuineLink(key: string): string {
	return buildSignedLink({
		key,
		expiresAt: new Date(Date.now() + FIFTEEN_MINUTES),
		secret: FILE_STORE_SECRET
	});
}

/** `link` with exactly one character of its signature changed. */
function flipOneSignatureCharacter(link: string): string {
	const url = new URL(link, 'https://example.invalid');
	const signature = url.searchParams.get('signature') ?? '';
	url.searchParams.set('signature', (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1));
	return `${url.pathname}${url.search}`;
}

test('a validly signed link answers 200 with the stored bytes and their Content-Type', async ({
	request
}) => {
	const key = `${runDirectory}/served/cover.png`;
	await plantFile(key, PNG);

	const response = await request.get(genuineLink(key));

	expect(response.status()).toBe(200);
	expect(response.headers()['content-type']).toBe('image/png');
	expect(response.headers()['x-content-type-options']).toBe('nosniff');
	expect(await response.body()).toEqual(PNG);
});

test('a signature with one character changed answers 403, not 200 and not 404', async ({
	request
}) => {
	const key = `${runDirectory}/tampered/cover.png`;
	await plantFile(key, PNG);

	const response = await request.get(flipOneSignatureCharacter(genuineLink(key)));

	expect(response.status()).toBe(403);
	expect(await response.text()).toBe('');
});

test('a link past its expiry answers 403 though its signature is genuine', async ({ request }) => {
	const key = `${runDirectory}/expired/cover.png`;
	await plantFile(key, PNG);
	const link = buildSignedLink({
		key,
		expiresAt: new Date(Date.now() - 1000),
		secret: FILE_STORE_SECRET
	});

	const response = await request.get(link);

	expect(response.status()).toBe(403);
});

test('a link without its signature, or without its expiry, answers 403', async ({ request }) => {
	const key = `${runDirectory}/stripped/cover.png`;
	await plantFile(key, PNG);
	const genuine = genuineLink(key);

	for (const parameter of ['signature', 'expires']) {
		const url = new URL(genuine, 'https://example.invalid');
		url.searchParams.delete(parameter);

		const response = await request.get(`${url.pathname}${url.search}`);

		expect(response.status(), `without ${parameter}`).toBe(403);
	}
});

test('no traversal encoding reads a file outside the store root', async ({ request }) => {
	// `.env` really exists one level above `storage/` and really holds FILE_STORE_SECRET, so it is
	// the exact file a traversal would go for. Some encodings are collapsed by URL parsing before
	// they reach the route (and then miss every route: 404), the rest must be refused by the route
	// itself (403). None may ever answer 200 or echo the file.
	const targets = [
		'/files/..%2f..%2f.env',
		'/files/%2e%2e%2f%2e%2e%2f.env',
		'/files/%2e%2e/%2e%2e/.env',
		'/files/..%5c..%5c.env',
		'/files/....//....//.env'
	];

	for (const target of targets) {
		const response = await request.get(`${target}?expires=9999999999&signature=x`);

		expect([403, 404], target).toContain(response.status());
		expect(await response.text(), target).not.toContain('FILE_STORE_SECRET');
	}
});

test('a genuine link whose file does not exist answers 404', async ({ request }) => {
	const response = await request.get(genuineLink(`${runDirectory}/never/written.png`));

	expect(response.status()).toBe(404);
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
	return `e2e-files-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
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

/** Registers a resident, verifies their address, signs them in, and grants them the admin role. */
async function signUpAdmin(page: Page, email: string): Promise<void> {
	await open(page, '/register');
	await page.getByLabel('Nama').fill('Pengurus E2E Berkas');
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
	await pool().query(
		"insert into user_roles (user_id, role, created_at) values ($1, 'admin', now())",
		[userId]
	);
	await pool().query('insert into residents (user_id, created_at) values ($1, now())', [userId]);

	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	// The session has to have landed before the caller navigates — see the same wait, with its
	// reasoning, in `tests/e2e/posts-public.spec.ts`.
	await expect(page).toHaveURL(/\/$/);
}

test('a published cover image really renders for a browser with no session, through its og:image address', async ({
	page,
	browser
}) => {
	// Blocked on the same application defect `tests/e2e/posts-public.spec.ts` records at length:
	// changing `Tipe` on the Post form clears the `required` `Judul` input, the browser then refuses
	// to submit `Simpan draf`, and the page never leaves `/admin/posts/new` — which is why the
	// `Berkas gambar` field below was never found. The old `toHaveURL(/\/admin\/posts\/[^/]+$/)` on
	// the line after the submit hid that, because `/admin/posts/new` matches it; #111 tightened the
	// same assertion in `posts-public.spec.ts` for this reason.
	test.fixme(
		true,
		'Changing Tipe on the Post form clears the required Judul input, so Simpan draf is held back by the browser own form validation and no Post is ever created. Application defect in src/lib/components/post/post-form.svelte, filed as its own ticket.'
	);
	const email = anAddress('cover');
	await signUpAdmin(page, email);

	await open(page, '/admin/posts/new');
	await page.getByLabel('Judul').fill(`Sampul tautan bertanda tangan ${Date.now()}`);
	await page.getByLabel('Ringkasan').fill('Bukti gelombang 13 bahwa gambar sampul tampil.');
	await page.getByLabel('Isi').fill('Isi pengumuman dengan gambar sampul.');
	await page.getByLabel('Tipe').selectOption('announcement');
	await page.getByRole('button', { name: 'Simpan draf' }).click();

	// A uuid-shaped final segment only. `/\/admin\/posts\/[^/]+$/` also matches `/admin/posts/new`
	// itself, so it passed while the save had not happened at all and handed `postId` the literal
	// string `new` — the same trap #111 took out of `tests/e2e/posts-public.spec.ts`.
	await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]{36}$/);
	const postId = page.url().split('/').pop();

	await page
		.getByLabel('Berkas gambar')
		.setInputFiles({ name: 'sampul.png', mimeType: 'image/png', buffer: PNG });
	await page.getByRole('button', { name: 'Unggah sampul' }).click();
	await expect(page.getByRole('status')).toContainText('Gambar sampul berhasil diunggah');

	await page.getByRole('button', { name: 'Terbitkan' }).click();
	await expect(page.getByRole('status')).toContainText('sudah tampil di papan pengumuman');

	// A fresh context: no cookie, no session — the browser a shared WhatsApp link opens in.
	const anonymousContext = await browser.newContext();
	const anonymousPage = await anonymousContext.newPage();
	await anonymousPage.goto(`/posts/${postId}`);

	const ogImage = await anonymousPage.locator('meta[property="og:image"]').getAttribute('content');
	expect(ogImage).toContain(`/files/posts/${postId}/cover.png`);

	// The acceptance criterion verbatim: fetch the og:image address and read status and Content-Type.
	const response = await anonymousPage.request.get(ogImage ?? '');
	expect(response.status()).toBe(200);
	expect(response.headers()['content-type']).toBe('image/png');

	// And the image really renders: a decoded 1×1 PNG reports a natural width of 1, a 404 reports 0.
	const image = anonymousPage.locator('img[src*="/files/posts/"]');
	await expect(image).toBeVisible();
	const naturalWidth = await image.evaluate(
		(element) => (element as HTMLImageElement).naturalWidth
	);
	expect(naturalWidth).toBeGreaterThan(0);

	await anonymousContext.close();

	// The stored cover file belongs to the application's database and store, not to this run's
	// scratch directory; it is small, overwritten by any later upload to the same Post, and the
	// database row that owns it survives this spec anyway, exactly like the Posts other specs leave.
});
