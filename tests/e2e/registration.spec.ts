import { expect, test, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Self-registration and its approval, through a browser: someone signs themselves up naming a house,
 * is let in far enough to read that they are being reviewed and no further, and becomes a Warga of
 * the house a superuser picks — or reads why they were turned down.
 *
 * ## Where the links come from
 *
 * Exactly as `./invitation.spec.ts` explains: the application queues email rather than sending it
 * inside a request, so this spec reads each link out of `email_queue`. The approval email carries no
 * token — it announces a decision — so it is only asserted on, never walked.
 *
 * ## The fixtures this spec writes directly
 *
 * The `superuser` role grant and the unit row are inserted with SQL, for the reason that spec gives:
 * granting the first role has no UI that does not itself require a superuser, and the unit register
 * belongs to another spec's flow.
 */

const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued email before giving up. */
const QUEUE_WAIT_MILLISECONDS = 10_000;

/** How long to wait between two looks. */
const QUEUE_POLL_MILLISECONDS = 200;

/** A password clearing the minimum length. A literal in a test, protecting nothing. */
const PASSWORD = 'kata sandi ujung ke ujung';

/** The label on every address field in the flow. */
const EMAIL_FIELD = 'Alamat email';

/** The reason the superuser types when turning a registration down. */
const REJECTION_REASON = 'Blok itu tidak punya nomor rumah seperti yang Anda tulis.';

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
	return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

/** A block name no other run will have used, so the unit picker's option text is unambiguous. */
function aBlock(): string {
	return `E2E-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Waits for the queue to hold an email of one kind for one address, and returns its link. */
async function linkFromQueuedEmail(recipient: string, kind: string): Promise<string> {
	const deadline = Date.now() + QUEUE_WAIT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await pool().query<{ payload: { url?: string } }>(
			'select payload from email_queue where recipient = $1 and kind = $2 order by created_at desc limit 1',
			[recipient, kind]
		);
		const url = result.rows[0]?.payload?.url;
		if (typeof url === 'string') {
			return url;
		}
		await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MILLISECONDS));
	}
	throw new Error(`No email of kind "${kind}" was queued for ${recipient}.`);
}

/** The token a verification link carries in its query string. */
function tokenFromQuery(link: string): string {
	const token = new URL(link).searchParams.get('token');
	if (token === null) {
		throw new Error(`The link carries no token: ${link}`);
	}
	return token;
}

/** Fills in the whole sign-up form, claim included, and submits it. */
async function fillRegistrationForm(
	page: Page,
	form: { name: string; email: string; block: string; number: string }
): Promise<void> {
	await open(page, '/register');
	await page.getByLabel('Nama').fill(form.name);
	await page.getByLabel(EMAIL_FIELD).fill(form.email);
	await page.getByLabel('Blok rumah').fill(form.block);
	await page.getByLabel('Nomor rumah').fill(form.number);
	await page.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Ulangi kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await expect(page).toHaveURL(/\/verify/);
}

/** Opens the verification link that was queued for an address. */
async function verifyAddress(page: Page, email: string): Promise<void> {
	const verifyLink = await linkFromQueuedEmail(email, 'verify-email');
	await page.goto(`/verify?token=${encodeURIComponent(tokenFromQuery(verifyLink))}`);
	await expect(page.getByText('Alamat email Anda sudah terverifikasi')).toBeVisible();
}

/**
 * Signs an already verified account in.
 *
 * Asserts no destination itself: where sign-in lands now depends on the account, since `/` is
 * Beranda in the `(app)` group since #142 and that group's own layout redirects an unadmitted
 * account on to `/pending-approval`. Each caller below asserts its own account's landing place.
 */
async function signIn(page: Page, email: string): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
}

/** Registers, verifies and signs a superuser in, granting the role by SQL — see the doc comment. */
async function signedInSuperuser(page: Page): Promise<void> {
	const email = anAddress('superuser');
	await fillRegistrationForm(page, {
		name: 'Pengurus E2E',
		email,
		block: aBlock(),
		number: '1'
	});
	await verifyAddress(page, email);

	await pool().query(
		`insert into user_roles (user_id, role, created_at)
		 select id, 'superuser', now() from "user" where email = $1
		 on conflict do nothing`,
		[email]
	);

	await signIn(page, email);
	// Holds `superuser`, granted above by SQL, so the `(app)` layout's admitted-account exemption
	// applies and this account lands on Beranda rather than `/pending-approval`.
	await expect(page).toHaveURL(/\/$/);
}

/** A unit row of this run's own, returning its block and number. */
async function insertUnit(): Promise<{ block: string; number: string }> {
	const block = aBlock();
	await pool().query(
		"insert into units (block, number, created_at) values ($1, '1', now()) returning id",
		[block]
	);
	return { block, number: '1' };
}

/**
 * A registrant in a browser context of its own, so no superuser cookie leaks into it: they sign up
 * naming `claim`, verify, sign in, and are left standing on the page that reviews them.
 */
async function registrantWaiting(
	browser: Browser,
	claim: { block: string; number: string }
): Promise<{ page: Page; email: string; close: () => Promise<void> }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const email = anAddress('registrant');

	await fillRegistrationForm(page, { name: 'Warga Mendaftar', email, ...claim });
	await verifyAddress(page, email);
	await signIn(page, email);
	// No `residents` row and no admin/superuser role, so sign-in itself already lands here: `/` is
	// Beranda in the `(app)` group since #142, and that group's own layout redirects on.
	await expect(page).toHaveURL(/\/pending-approval/);

	// Every page of the application group sends them to the one page they may read.
	await page.goto('/my-unit');
	await expect(page).toHaveURL(/\/pending-approval/);

	return { page, email, close: () => context.close() };
}

test('a self-registrant waits, is approved onto a house, and becomes a warga of it', async ({
	page,
	browser
}) => {
	await signedInSuperuser(page);
	const unit = await insertUnit();
	const registrant = await registrantWaiting(browser, unit);

	try {
		await expect(
			registrant.page.getByRole('heading', { name: 'Pendaftaran Anda sedang ditinjau' })
		).toBeVisible();

		await open(page, '/admin/registrations');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pendaftaran warga');
		const card = page.locator('article', { hasText: registrant.email });
		// The claim matched a real house, so the picker starts on it.
		await expect(card).toContainText(`Cocok dengan unit blok ${unit.block}`);
		await expect(card.getByLabel('Unit')).toHaveValue(/.+/);
		await card.getByRole('button', { name: 'Setujui' }).click();
		await expect(page.getByRole('status')).toContainText(
			`Pendaftaran ${registrant.email} disetujui`
		);

		// The approval email went out, naming the house they were attached to.
		const signInLink = await linkFromQueuedEmail(registrant.email, 'registration-approved');
		expect(new URL(signInLink).pathname).toBe('/login');

		// And the page that refused them a moment ago is theirs now.
		await registrant.page.goto('/my-unit');
		await expect(registrant.page).toHaveURL(/\/my-unit/);
		await expect(registrant.page.getByText(unit.block)).toBeVisible();
	} finally {
		await registrant.close();
	}
});

test('a self-registrant who is turned down reads the reason and may apply again', async ({
	page,
	browser
}) => {
	await signedInSuperuser(page);
	const registrant = await registrantWaiting(browser, { block: aBlock(), number: '404' });

	try {
		await open(page, '/admin/registrations');
		const card = page.locator('article', { hasText: registrant.email });
		// Nothing in the register matches what they typed, and the screen says so rather than hiding it.
		await expect(card).toContainText('tidak cocok dengan unit mana pun');
		await card.getByLabel('Alasan penolakan').fill(REJECTION_REASON);
		await card.getByRole('button', { name: 'Tolak' }).click();
		await expect(page.getByRole('status')).toContainText(`Pendaftaran ${registrant.email} ditolak`);

		await registrant.page.goto('/pending-approval');
		await expect(
			registrant.page.getByRole('heading', { name: 'Pendaftaran Anda ditolak' })
		).toBeVisible();
		await expect(registrant.page.getByRole('alert')).toContainText(REJECTION_REASON);
		await expect(registrant.page.getByRole('link', { name: 'Daftar ulang' })).toBeVisible();
	} finally {
		await registrant.close();
	}
});
