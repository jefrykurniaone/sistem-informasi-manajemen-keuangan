import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
 * ## The body is typed into a rich-text editor
 *
 * Since #140 there is no `<textarea>` to `fill`. The body is a Tiptap editor, so this spec clicks
 * into `.ProseMirror`, types, and presses the toolbar the way an admin would — which is also what
 * makes it worth walking at all, because the markup the public page renders is now produced by the
 * editor rather than typed out by hand.
 *
 * The Sampul is chosen on the same form, so this spec uploads one and checks the `og:image` a shared
 * link would carry. `tests/e2e/file-serving.spec.ts` owns the deeper claim about that address — that
 * `/files/…` really answers with the bytes and their `Content-Type`.
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
	return `e2e-posts-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
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
	// Waiting for the session to land, not for tidiness. Clicking only posts the form; the response
	// that carries the session cookie is still in flight when `click` resolves, so the `goto` the
	// caller makes next races it. Under `fullyParallel` that race is lost often enough to matter:
	// `/admin/posts/new` answers a request with no session by redirecting to `/login`, where there
	// is no `Judul` field, and the test then spends its whole timeout waiting for one. Measured on
	// #112, at six workers.
	await expect(page).toHaveURL(/\/$/);
}

/**
 * A 1×1 transparent PNG — a real image, so the signature check in `setPostCoverImage` accepts it and
 * a browser can decode it. The same bytes `tests/e2e/file-serving.spec.ts` plants; copied rather than
 * imported, for the reason that file gives for copying the sign-up helpers.
 */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/**
 * The Post body editor, once it has mounted and will take what is typed into it.
 *
 * `.ProseMirror` exists only after hydration has run and `rich-text-editor.svelte`'s `onMount` has
 * finished its dynamic import, so waiting for it is the strongest hydration marker this screen has:
 * every field filled after this call is filled on a page whose Svelte effects have already written
 * their `value={…}` bindings back. The click itself is wrapped in the `toPass` retry
 * `tests/e2e/layout.spec.ts` and `tests/e2e/smoke.spec.ts` use, because under parallel workers the
 * first JS-driven click can still land a frame early.
 */
async function bodyEditor(page: Page): Promise<Locator> {
	const editor = page.locator('.ProseMirror');
	await expect(editor).toBeVisible();
	await expect(editor).toHaveAttribute('contenteditable', 'true');
	await expect(async () => {
		await editor.click();
		await expect(editor).toBeFocused({ timeout: 1000 });
	}).toPass();
	return editor;
}

/**
 * Presses one toolbar button and waits until the caret is back in the editor.
 *
 * Every toolbar command ends in `chain().focus()`, so the editor takes focus back from the button it
 * was given by the click; waiting for that is what makes the `page.keyboard.type` after it land in
 * the document rather than on the button.
 */
async function pressToolbar(page: Page, editor: Locator, name: string): Promise<void> {
	await page.getByRole('button', { name, exact: true }).click();
	await expect(editor).toBeFocused();
}

/**
 * A `YYYY-MM-DD` date `daysAhead` days from now, for `date-time-fields.svelte`'s date box. The
 * server's own zone, not WIB — a few hours either side of midnight makes no difference to a date
 * chosen a week out, and `combineCivilDateTime` is what reads the pair as WIB regardless.
 */
function futureDate(daysAhead: number): string {
	const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A fixed `HH:mm` WIB time for `date-time-fields.svelte`'s time box — always seven in the evening. */
const EVENT_START_TIME = '19:00';

/** The end time, an hour after `EVENT_START_TIME`. */
const EVENT_END_TIME = '20:00';

test('an admin publishes a kegiatan, and a browser with no session opens it from the board and reads it', async ({
	page,
	browser
}) => {
	const email = anAddress('publish');
	const title = `Kerja bakti E2E ${Date.now()}`;

	await signUpAdmin(page, email);

	await open(page, '/admin/posts/new');

	// The body is typed, and its markup is made with the toolbar: bold on, the word, bold off, then a
	// bulleted list on the next line. Pressing the buttons rather than selecting text afterwards is
	// what an admin does, and it needs no fragile drag across a rendered range.
	const editor = await bodyEditor(page);
	await pressToolbar(page, editor, 'Tebal');
	await page.keyboard.type('sapu');
	await pressToolbar(page, editor, 'Tebal');
	await page.keyboard.type(' dan cangkul.');
	await page.keyboard.press('Enter');
	await pressToolbar(page, editor, 'Daftar berbutir');
	await page.keyboard.type('Bawa ember');

	await page.getByLabel('Judul').fill(title);
	await page.getByLabel('Ringkasan').fill('Kerja bakti bulanan di lapangan komplek.');
	await page
		.getByLabel('Berkas gambar')
		.setInputFiles({ name: 'sampul.png', mimeType: 'image/png', buffer: PNG });
	const eventDate = futureDate(7);
	await page.getByLabel('Waktu mulai').fill(eventDate);
	await page.getByLabel('Jam mulai').fill(EVENT_START_TIME);
	await page.getByLabel('Waktu selesai').fill(eventDate);
	await page.getByLabel('Jam selesai').fill(EVENT_END_TIME);
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
	// `.prose` is the `@tailwindcss/typography` container the editor and this page share since #140.
	await expect(anonymousPage.locator('.prose')).toContainText('dan cangkul.');
	await expect(anonymousPage.locator('.prose strong')).toHaveText('sapu');
	await expect(anonymousPage.locator('.prose ul li')).toContainText('Bawa ember');

	// The start time typed through the two boxes — `19:00` WIB — reaches the public page labelled
	// with the same hour and the zone, `19.00 WIB`: `id-ID`'s own separator, never a colon and never
	// `GMT+7`. This is what `formatDateTime` from `$lib/time` replacing the four route
	// `formatInstant` helpers is for.
	await expect(anonymousPage.getByText('Waktu mulai')).toBeVisible();
	await expect(anonymousPage.locator('dl')).toContainText('19.00 WIB');

	// The Sampul chosen on the write form, on the Post the same submission created.
	await expect(anonymousPage.locator('meta[property="og:image"]')).toHaveAttribute(
		'content',
		new RegExp(`/files/posts/${postId}/cover\\.png`)
	);

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

	// A shared Post opens outside the app shell (#170): no sidebar part at all, and the public
	// header offers the signed-out visitor the way in. `tests/e2e/layout.spec.ts` makes the same
	// claim for `/posts`, `/login` and `/register`; this proves it holds on a single Post too.
	await expect(anonymousPage.locator('[data-sidebar]')).toHaveCount(0);
	await expect(
		anonymousPage.getByRole('banner').getByRole('link', { name: 'Masuk' })
	).toBeVisible();

	await anonymousContext.close();
});

test('a draft Post answers 404 to a browser with no session, even with its real id', async ({
	page,
	browser
}) => {
	// The only Post this test can make is a pengumuman — a kegiatan is what the test above covers,
	// and its `Waktu mulai` is exactly the field this one must not have to fill. Picking the type is
	// therefore not avoidable here, and picking it used to break: `src/lib/components/post/post-form.svelte`
	// compiled every top-level attribute update in the form into one Svelte `template_effect`, so
	// changing `Tipe` reran it and wrote the unchanged, empty `values.title` back over the `Judul`
	// the person typed. `Judul` is `required`, so the browser refused to submit the form at all and
	// the page never left `/admin/posts/new`. Fixed by #119, which isolates the `Tipe` `<select>`'s
	// own reactive attribute update into its own compiled effect so it no longer reruns the effect
	// that writes `Judul`, `Ringkasan`, `Kategori` and `Isi`.
	const email = anAddress('draft');
	await signUpAdmin(page, email);

	await open(page, '/admin/posts/new');
	await bodyEditor(page);
	await page.keyboard.type('Isi belum final.');
	await page.getByLabel('Judul').fill(`Draf tidak terbit ${Date.now()}`);
	await page.getByLabel('Ringkasan').fill('Belum siap dibagikan.');
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
