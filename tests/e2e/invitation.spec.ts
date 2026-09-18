import { expect, test, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * The invitation flow, through a browser: a superuser sends the link, the invitee sets their own
 * password and lands on their house, and the same link is worth nothing a second time.
 *
 * ## Where the links come from
 *
 * Exactly as `./auth.spec.ts` explains: the application queues email rather than sending it inside
 * a request, so this spec reads each link out of `email_queue` — the half of the chain this ticket
 * owns. Whether a queued row reaches an SMTP server (and therefore Mailpit) is the worker's
 * promise, proven by `tests/unit/ports-email.test.ts` against a mail server it starts itself.
 *
 * ## The fixtures this spec writes directly
 *
 * The `superuser` role grant and the unit row are inserted with SQL. Granting the role has no UI
 * that does not itself require a superuser — the first one is always seeded from outside — and the
 * unit register belongs to another spec's flow; re-walking it here would test that screen twice.
 *
 * ## The expired case travels through the database on purpose
 *
 * Seven days cannot pass inside a test run, and the service's own clock is not reachable from
 * outside the process, so the row is aged by writing `expires_at` back — the same trick
 * `tests/unit/auth.test.ts` uses on better-auth's reset tokens. What the page then shows for an
 * expired link is exactly what this spec is after.
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

const pool = new Pool({ connectionString: DATABASE_URL });

test.afterAll(async () => {
	await pool.end();
});

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
		const result = await pool.query<{ payload: { url?: string } }>(
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

/** The invitation accept path, taken from the emailed link so the test walks what was really sent. */
function acceptPathOf(link: string): string {
	return new URL(link).pathname;
}

/** Registers, verifies and signs a superuser in, granting the role by SQL — see the doc comment. */
async function signedInSuperuser(page: Page): Promise<string> {
	const email = anAddress('superuser');
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

	const verifyLink = await linkFromQueuedEmail(email, 'verify-email');
	await page.goto(`/verify?token=${encodeURIComponent(tokenFromQuery(verifyLink))}`);
	await expect(page.getByText('Alamat email Anda sudah terverifikasi')).toBeVisible();

	await pool.query(
		`insert into user_roles (user_id, role, created_at)
		 select id, 'superuser', now() from "user" where email = $1
		 on conflict do nothing`,
		[email]
	);

	await page.goto('/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	await expect(page).toHaveURL(/\/$/);
	return email;
}

/** A unit row of this run's own, returning its id and block. */
async function insertUnit(): Promise<{ unitId: string; block: string }> {
	const block = aBlock();
	const result = await pool.query<{ id: string }>(
		"insert into units (block, number, created_at) values ($1, '1', now()) returning id",
		[block]
	);
	return { unitId: result.rows[0].id, block };
}

/** Sends one invitation through the admin screen and returns the emailed accept path. */
async function inviteThroughScreen(page: Page, block: string, email: string): Promise<string> {
	await page.goto('/admin/invitations');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Undangan warga');
	await page.getByLabel('Unit').selectOption({ label: `${block} — 1` });
	await page.getByLabel(EMAIL_FIELD, { exact: true }).fill(email);
	await page.getByRole('button', { name: 'Kirim undangan', exact: true }).click();
	await expect(page.getByRole('status')).toContainText(`Undangan terkirim ke ${email}`);

	return acceptPathOf(await linkFromQueuedEmail(email, 'invitation'));
}

/** The invitee's half, in a browser context of its own so no superuser cookie leaks into it. */
async function acceptInBrowser(browser: Browser, acceptPath: string, block: string): Promise<void> {
	const context = await browser.newContext();
	const invitee = await context.newPage();
	try {
		await invitee.goto(acceptPath);
		await expect(invitee.getByRole('heading', { level: 1 })).toHaveText('Terima undangan');
		await invitee.getByLabel('Nama').fill('Warga Diundang');
		await invitee.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
		await invitee.getByLabel('Ulangi kata sandi').fill(PASSWORD);
		await invitee.getByRole('button', { name: 'Simpan kata sandi dan masuk' }).click();

		// Signed in and standing in their own house, in one motion.
		await expect(invitee).toHaveURL(/\/my-unit/);
		await expect(invitee.getByText(block)).toBeVisible();

		// The same link a second time, still inside the invitee's browser: spent is spent.
		await invitee.goto(acceptPath);
		await expect(invitee.getByText('sudah pernah dipakai')).toBeVisible();
	} finally {
		await context.close();
	}
}

test('a superuser invites, the invitee sets a password and lands on their house, once', async ({
	page,
	browser
}) => {
	await signedInSuperuser(page);
	const { block } = await insertUnit();
	const inviteeEmail = anAddress('invitee');

	const acceptPath = await inviteThroughScreen(page, block, inviteeEmail);
	await acceptInBrowser(browser, acceptPath, block);
});

test('an expired link is refused with its own message, and a resend makes a working one', async ({
	page,
	browser
}) => {
	await signedInSuperuser(page);
	const { block } = await insertUnit();
	const inviteeEmail = anAddress('expired');
	const oldPath = await inviteThroughScreen(page, block, inviteeEmail);

	// Age the link — see the doc comment for why this travels through the database.
	await pool.query('update invitations set expires_at = now() where email = $1', [inviteeEmail]);

	const context = await browser.newContext();
	const invitee = await context.newPage();
	try {
		await invitee.goto(oldPath);
		await expect(invitee.getByText('Masa berlaku undangan ini sudah lewat')).toBeVisible();
	} finally {
		await context.close();
	}

	// The superuser resends from the list — this invitation's own card, because other tests may
	// have put cards of their own above it.
	await page.goto('/admin/invitations');
	await page
		.locator('article', { hasText: inviteeEmail })
		.getByRole('button', { name: 'Kirim ulang' })
		.click();
	await expect(page.getByRole('status')).toContainText(`Undangan baru terkirim ke ${inviteeEmail}`);
	const freshPath = acceptPathOf(await linkFromQueuedEmail(inviteeEmail, 'invitation'));
	expect(freshPath).not.toBe(oldPath);
	await acceptInBrowser(browser, freshPath, block);
});
