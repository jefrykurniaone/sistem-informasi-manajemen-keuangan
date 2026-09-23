import { expect, test, type Locator, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Where the app shell is, and where it is not, through a real browser.
 *
 * Since #170 (`docs/spec-shell-masuk-v1.md`) the sidebar, its collapse control and its menu wrap
 * only the `(app)` group. The sign-in pages and the public announcement board carry none of them;
 * the board gets a light header instead, with the complex's name on the left and one way onward on
 * the right. The rest of this file is the shell itself at 390 pixels, the narrowest width this
 * application's acceptance criteria name (`spec-fondasi-v1.md`'s "Antarmuka" and "i18n" sections,
 * `spec-shell-beranda-v1.md`'s 390 pixel criteria): the drawer, its touch targets and the language
 * switcher in its foot.
 *
 * Kept thin on purpose, matching `spec-fondasi-v1.md`'s testing decision that Playwright proves the
 * shell is alive rather than exercising every role. Hover intent, the icon mode and the floating
 * panel are walk criteria, not assertions here.
 *
 * ## Signing in
 *
 * The shell now only exists behind a session, so the tests that open it need one. There is no
 * seeded account under this harness, so `signedInSuperuser` registers one, reads its verification
 * link straight out of `email_queue` and grants `superuser` by SQL, the same shortest path
 * `tests/e2e/registration.spec.ts` takes and for the same reasons. `superuser` rather than a bare
 * resident because an account with no `residents` row and no pengurus role is sent to
 * `/pending-approval` by the `(app)` layout, and these tests are about the shell, not that guard.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** The accessible name of the control that opens the drawer, `appShell_toggleSidebar`. */
const MENU_BUTTON_ID = 'Buka atau tutup menu';
const MENU_BUTTON_EN = 'Open or close menu';

/** The accessible name of the sidebar landmark, `appShell_navLabel`. */
const MAIN_NAV_ID = 'Navigasi utama';

/** Every element the shadcn sidebar renders carries this attribute, the trigger included. */
const ANY_SIDEBAR_PART = '[data-sidebar]';

/** The database the application under test is using. `playwright.config.ts` loads it out of `.env`. */
const DATABASE_URL = process.env.DATABASE_URL;

/** How long to keep looking for a queued verification email, and how long between two looks. */
const QUEUE_WAIT_MILLISECONDS = 10_000;
const QUEUE_POLL_MILLISECONDS = 200;

/** A password that clears the minimum length. Invented here, used by this file only. */
const PASSWORD = 'kata sandi kerangka aplikasi';

/** The label on the address field of the registration and sign-in forms. */
const EMAIL_FIELD = 'Alamat email';

/** The display name every account this file registers carries. */
const ACCOUNT_NAME = 'Pengurus Kerangka';

/**
 * The complex name the server under test was built with, worked out the way `src/lib/complex-name.ts`
 * does: trimmed, and "Komplek" when nothing is left. That module cannot be imported here, because
 * `$env/static/public` only resolves inside a SvelteKit build, so the rule is restated; the unit
 * test proves the module's side of it.
 */
function expectedComplexName(): string {
	const trimmed = process.env.PUBLIC_COMPLEX_NAME?.trim() ?? '';
	return trimmed === '' ? 'Komplek' : trimmed;
}

const COMPLEX_NAME = expectedComplexName();

/**
 * This file's own connection, opened on first use by each job and closed by the job that opened
 * it. See `tests/e2e/auth.spec.ts` for why `fullyParallel` runs `afterAll` more than once in one
 * worker process, and what `pg` does about a pool closed twice.
 */
let openPool: Pool | undefined;

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
 * Opens `path` and waits until the page can be typed into: hydration writes every `value={…}`
 * binding back over whatever was typed before it ran. See `tests/e2e/auth.spec.ts`.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** An address no other run of this spec will have used. */
function anAddress(): string {
	return `e2e-layout-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
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

/** Registers, verifies and signs a superuser in, granting the role by SQL; see the file comment. */
async function signedInSuperuser(page: Page): Promise<void> {
	const email = anAddress();
	await open(page, '/register');
	await page.getByLabel('Nama').fill(ACCOUNT_NAME);
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Blok rumah').fill('E2E');
	await page.getByLabel('Nomor rumah').fill('0');
	await page.getByLabel('Kata sandi', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Ulangi kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Daftar' }).click();
	await expect(page).toHaveURL(/\/verify/);

	const token = await verificationToken(email);
	await page.goto(`/verify?token=${encodeURIComponent(token)}`);
	await expect(page.getByText('Alamat email Anda sudah terverifikasi')).toBeVisible();

	await pool().query(
		`insert into user_roles (user_id, role, created_at)
		 select id, 'superuser', now() from "user" where email = $1
		 on conflict do nothing`,
		[email]
	);

	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(email);
	await page.getByLabel('Kata sandi').fill(PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	// Waiting for the session cookie to land before the caller's next `goto` races it.
	await expect(page).toHaveURL(/\/$/);
}

/**
 * Presses the menu button until the drawer it opens is on screen.
 *
 * The drawer is opened by the component's own script, so a click that lands before the page has
 * hydrated is simply lost. Hydration leaves nothing on the button to wait for either, and a marker
 * added to the application only for the tests would be worse than repeating the click here.
 *
 * `drawerContent` is something the open drawer shows: the navigation landmark, or the language
 * select in its footer once the interface is English and the landmark's name has changed with it.
 */
async function openDrawer(page: Page, buttonName: string, drawerContent: Locator): Promise<void> {
	await expect(async () => {
		await page.getByRole('button', { name: buttonName }).click();
		await expect(drawerContent).toBeVisible({ timeout: 1000 });
	}).toPass();
}

/** Whether the document is wider than the window, which is what a horizontal scrollbar means. */
async function overflowsHorizontally(page: Page): Promise<boolean> {
	return page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
}

test.describe('without a session, the pages outside the application carry no shell', () => {
	for (const width of [390, 1920]) {
		for (const path of ['/login', '/register', '/posts']) {
			test(`${path} at ${width}px has no sidebar, no collapse control and no horizontal overflow`, async ({
				page
			}) => {
				await page.setViewportSize({ width, height: 900 });
				await open(page, path);

				await expect(page.locator(ANY_SIDEBAR_PART)).toHaveCount(0);
				await expect(page.getByRole('button', { name: MENU_BUTTON_ID })).toHaveCount(0);
				await expect(page.getByRole('navigation', { name: MAIN_NAV_ID })).toHaveCount(0);
				expect(await overflowsHorizontally(page)).toBe(false);
			});
		}
	}
});

test('/posts without a session shows a header with the complex name and a Masuk link to the sign-in page', async ({
	page
}) => {
	await open(page, '/posts');

	const header = page.getByRole('banner');
	await expect(header.getByRole('link', { name: COMPLEX_NAME, exact: true })).toBeVisible();
	await expect(header.getByRole('link', { name: 'Beranda' })).toHaveCount(0);

	await header.getByRole('link', { name: 'Masuk' }).click();
	await expect(page).toHaveURL(/\/login$/);
});

test('with a session, / carries the shell with the complex name as its brand, and /posts greets the account and links back to Beranda', async ({
	page
}) => {
	await signedInSuperuser(page);

	await expect(page.locator(ANY_SIDEBAR_PART).first()).toBeAttached();
	await expect(page.getByRole('button', { name: MENU_BUTTON_ID })).toBeVisible();

	const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
	await openDrawer(page, MENU_BUTTON_ID, nav);
	await expect(page.locator('[data-sidebar="header"]')).toContainText(COMPLEX_NAME);

	await open(page, '/posts');
	await expect(page.locator(ANY_SIDEBAR_PART)).toHaveCount(0);
	const header = page.getByRole('banner');
	await expect(header).toContainText(ACCOUNT_NAME);
	await expect(header.getByRole('link', { name: 'Masuk' })).toHaveCount(0);

	await header.getByRole('link', { name: 'Beranda' }).click();
	await expect(page).toHaveURL(/\/$/);
});

test('with a session at 1920px, the sidebar is on screen beside the page and the page does not scroll sideways', async ({
	page
}) => {
	// Set before the first page loads, so the shell hydrates as the desktop sidebar rather than
	// switching over from the telephone drawer mid-test.
	await page.setViewportSize({ width: 1920, height: 1080 });
	await signedInSuperuser(page);

	await expect(page.getByRole('navigation', { name: MAIN_NAV_ID })).toBeVisible();
	await expect(page.locator('[data-sidebar="header"]')).toContainText(COMPLEX_NAME);
	expect(await overflowsHorizontally(page)).toBe(false);
});

/**
 * #205: the `lg` size variant used by the brand button (`sidebar-menu-button.svelte`) zeroed the
 * button's padding in icon mode, which pulled the brand icon flush to the button's left edge while
 * every other collapsed menu icon sits centered on the same axis by the base variant's own padding.
 * This proves the two axes match once collapsed, and that neither icon moved off its own button.
 */
test('with a session at 1920px, collapsing the sidebar puts the brand icon on the same horizontal axis as a menu icon', async ({
	page
}) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	await signedInSuperuser(page);

	// `signedInSuperuser` ends right after the client-side navigation off `/login`, a page the
	// sidebar's code never loads on. Without this, the trigger's click handler is not attached yet
	// and the click below is simply lost. `open` re-navigates to `/` and waits for `networkidle`, the
	// same hydration wait every other test in this file relies on.
	await open(page, '/');

	await page.getByRole('button', { name: MENU_BUTTON_ID }).click();

	// The collapse is a 200ms CSS width transition (`sidebar.svelte`'s `sidebar-container`), so the
	// icons are not on their final axis the instant the click resolves; wait for the container to
	// finish settling at the icon-mode width before measuring anything inside it.
	const container = page.locator('[data-slot="sidebar-container"]');
	await expect.poll(async () => Math.round((await container.boundingBox())?.width ?? 0)).toBe(48);

	const brandIcon = page
		.locator('[data-sidebar="header"]')
		.getByRole('link', { name: COMPLEX_NAME, exact: true })
		.locator('svg');
	const homeIcon = page
		.getByRole('navigation', { name: MAIN_NAV_ID })
		.getByRole('link', { name: 'Beranda', exact: true })
		.locator('svg');

	const brandBox = await brandIcon.boundingBox();
	const homeBox = await homeIcon.boundingBox();
	if (brandBox === null || homeBox === null) {
		throw new Error('Expected both the brand icon and the Beranda icon to have a bounding box.');
	}

	const brandCenterX = brandBox.x + brandBox.width / 2;
	const homeCenterX = homeBox.x + homeBox.width / 2;
	expect(Math.abs(brandCenterX - homeCenterX)).toBeLessThanOrEqual(0.5);
});

test('the drawer at 390px shows the menu and the way out, with every link at least 44 pixels tall and no horizontal overflow', async ({
	page
}) => {
	await signedInSuperuser(page);

	const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
	await expect(nav).toBeHidden();
	await openDrawer(page, MENU_BUTTON_ID, nav);

	await expect(nav.getByRole('link', { name: 'Beranda' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Keluar' })).toBeVisible();

	const links = await nav.getByRole('link').all();
	expect(links.length).toBeGreaterThan(0);
	for (const link of links) {
		const box = await link.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	}

	expect(await overflowsHorizontally(page)).toBe(false);
});

test('choosing a link in the drawer closes it and moves to that page', async ({ page }) => {
	await signedInSuperuser(page);

	const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
	await openDrawer(page, MENU_BUTTON_ID, nav);

	// The announcement board's group holds one item, and the `group.items.length === 1` branch of
	// `app-sidebar.svelte` renders a group of one as a plain link named after the group
	// (`appShell_groupPosts`), not after the item (`appShell_navPosts`, "Papan Pengumuman"); only a
	// group of two or more becomes the expandable button in `nav-group.svelte`. So there is no group
	// title to open first.
	await nav.getByRole('link', { name: 'Pengumuman & Kegiatan', exact: true }).click();

	await expect(page).toHaveURL(/\/posts$/);
	await expect(nav).toBeHidden();
});

test('the language switcher is a labelled, keyboard-usable control whose choice survives a reload', async ({
	page
}) => {
	await signedInSuperuser(page);

	const switcher = page.getByLabel('Bahasa');
	await openDrawer(page, MENU_BUTTON_ID, switcher);

	await expect(switcher).toBeVisible();
	await switcher.focus();
	await expect(switcher).toBeFocused();
	await expect(page.locator('html')).toHaveAttribute('lang', 'id');

	// `setLocale` navigates the whole document, which closes the drawer with it.
	await switcher.selectOption('en');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	const englishSwitcher = page.getByLabel('Language');
	await openDrawer(page, MENU_BUTTON_EN, englishSwitcher);
	await expect(englishSwitcher).toHaveValue('en');

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await openDrawer(page, MENU_BUTTON_EN, englishSwitcher);
	await expect(englishSwitcher).toHaveValue('en');
});
