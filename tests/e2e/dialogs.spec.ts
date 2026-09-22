import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Proves `dialog:modal { margin: auto; }` in `src/app.css` really centers an open `<dialog>` on the
 * viewport, at a desktop and a phone size. Tailwind v4's Preflight strips the browser's default
 * centering, and this rule is what puts it back (see the comment beside it in `src/app.css`).
 *
 * The dialog under test is the "batalkan Tagihan" confirmation on the Data Contoh unit `A-01`,
 * `src/lib/components/dues/void-invoice-dialog.svelte`, opened from
 * `src/routes/(app)/admin/units/[id]/finance/+page.svelte`. It is only ever cancelled here: Data
 * Contoh is shared across specs in this run, and confirming would void a seeded Tagihan for good.
 *
 * The sign-in helper is copied from `tests/e2e/payments.spec.ts` rather than imported: importing a
 * spec file would register its tests a second time, and this repository keeps no shared e2e helper
 * module yet.
 */

/** The Data Contoh superuser account (`README.md`, "Data Contoh"), on unit `A-01`. */
const SUPERUSER_EMAIL = 'superuser@komplek.local';
const SUPERUSER_PASSWORD = 'kata-sandi-dummy-123';

/** The label on the address field in the sign-in form. */
const EMAIL_FIELD = 'Alamat email';

/** How far off-center the dialog's midpoint may land, on each axis, and still count as centered. */
const CENTER_TOLERANCE_PIXELS = 2;

/** The two sizes this spec measures the dialog at: a desktop and a phone viewport. */
const VIEWPORTS = [
	{ name: 'desktop 1920x1080', width: 1920, height: 1080 },
	{ name: 'phone 390x844', width: 390, height: 844 }
];

/**
 * Opens `path` and waits until the page can be typed into. Copied from `tests/e2e/payments.spec.ts`
 * and `tests/e2e/auth.spec.ts`: hydration overwrites anything typed before it runs, and
 * `networkidle` is the signal that it has already happened.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** Signs the Data Contoh superuser in on `page`. */
async function signInAsSuperuser(page: Page): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(SUPERUSER_EMAIL);
	await page.getByLabel('Kata sandi').fill(SUPERUSER_PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	await expect(page).toHaveURL(/\/$/);
}

/**
 * Navigates to unit `A-01`'s Keuangan screen through the admin Unit list, as a person would.
 *
 * Searches block `A` rather than "A-01": `src/lib/server/services/unit/queries.ts` ORs an `ilike`
 * against `units.block` and `units.number` separately (line 124), so a combined "A-01" matches
 * neither column and the list comes back empty. The same query orders its rows
 * `asc(units.block), asc(units.number)` (line 42), so of the ten Data Contoh units in block `A`,
 * `A-01` sorts first: the first "Detail" link on the results page is always its own.
 *
 * `Cari` navigates to `?q=A`, which detaches the pre-search list and its "Detail" links, so the
 * navigation is awaited (by URL, then by network idling) before the first "Detail" link is
 * touched, rather than clicking a link that is about to be torn down.
 *
 * `.first()` on "Detail" is intentional, not a shortcut around ambiguity: the block-A results page
 * has one "Detail" link per unit, by design, and the ordering comment above is what makes "first"
 * mean A-01 rather than an arbitrary row.
 */
async function openUnitA01Finance(page: Page): Promise<void> {
	await open(page, '/admin/units');
	await page.getByLabel('Cari blok atau nomor').fill('A');
	await page.getByRole('button', { name: 'Cari' }).click();
	await expect(page).toHaveURL(/[?&]q=A(&|$)/);
	await page.waitForLoadState('networkidle');
	await page.getByRole('link', { name: 'Detail' }).first().click();
	await page.getByRole('link', { name: 'Keuangan dan saldo titipan' }).click();

	// Confirms the click above really landed on A-01, not some other block-A unit that a future
	// reseed or reorder of Data Contoh could put first.
	await expect(page).toHaveURL(/\/admin\/units\/[^/]+\/finance$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Keuangan Blok A No 01');
}

/**
 * The distance, on each axis, between `locator`'s `getBoundingClientRect()` center and the
 * viewport's center, per the ticket's acceptance criterion. Read inside one `evaluate` call so the
 * rect and the viewport size come from the same page, in the same layout pass.
 *
 * Measured against `document.documentElement.clientWidth`/`clientHeight`, not
 * `window.innerWidth`/`innerHeight`: `clientWidth`/`clientHeight` is the layout viewport a
 * `dialog:modal`'s `margin: auto` actually centers into, while `innerWidth`/`innerHeight` also
 * counts a classic scrollbar's width, which would read a centered dialog as off by half that width.
 */
async function centerOffsetFromViewport(locator: Locator): Promise<{ x: number; y: number }> {
	return locator.evaluate((el) => {
		const rect = el.getBoundingClientRect();
		const { clientWidth, clientHeight } = document.documentElement;
		return {
			x: Math.abs(rect.x + rect.width / 2 - clientWidth / 2),
			y: Math.abs(rect.y + rect.height / 2 - clientHeight / 2)
		};
	});
}

for (const viewport of VIEWPORTS) {
	test(`the batalkan Tagihan dialog is centered at ${viewport.name}`, async ({ page }) => {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await signInAsSuperuser(page);
		await openUnitA01Finance(page);

		// `.first()` is intentional here too: A-01 can carry more than one un-voided Tagihan (a
		// current one plus carried-over history), each with its own "Batalkan tagihan" button, and
		// this spec only needs one of them open to measure the dialog.
		await page.getByRole('button', { name: 'Batalkan tagihan' }).first().click();
		const dialog = page.locator('dialog[open]');
		await expect(dialog).toBeVisible();

		const offset = await centerOffsetFromViewport(dialog);
		expect(offset.x).toBeLessThanOrEqual(CENTER_TOLERANCE_PIXELS);
		expect(offset.y).toBeLessThanOrEqual(CENTER_TOLERANCE_PIXELS);

		// Never confirm: Data Contoh is shared across this run's specs.
		//
		// Scoped to `dialog`, and matched exactly, because Playwright's `name` is a case-insensitive
		// substring match: an unscoped, inexact "Batal" also resolves every "Batalkan tagihan" button
		// on the page behind the dialog, which is what made this a strict-mode violation before.
		await dialog.getByRole('button', { name: 'Batal', exact: true }).click();
		await expect(dialog).toBeHidden();
	});
}
