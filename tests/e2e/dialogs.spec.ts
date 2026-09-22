import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Proves `dialog:modal { margin: auto; }` in `src/app.css` really centers an open `<dialog>` on the
 * viewport, at a desktop and a phone size. Tailwind v4's Preflight strips the browser's default
 * centering, and this rule is what puts it back — see the comment beside it in `src/app.css`.
 *
 * The dialog under test is the "batalkan Tagihan" confirmation on the Data Contoh unit `A-01`,
 * `src/lib/components/dues/void-invoice-dialog.svelte`, opened from
 * `src/routes/(app)/admin/units/[id]/finance/+page.svelte`. It is only ever cancelled here: Data
 * Contoh is shared across specs in this run, and confirming would void a seeded Tagihan for good.
 *
 * The sign-in helper is copied from `tests/e2e/payments.spec.ts` rather than imported — importing a
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
 * and `tests/e2e/auth.spec.ts` — hydration overwrites anything typed before it runs, and
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

/** Navigates to unit `A-01`'s Keuangan screen through the admin Unit list, as a person would. */
async function openUnitA01Finance(page: Page): Promise<void> {
	await open(page, '/admin/units');
	await page.getByLabel('Cari blok atau nomor').fill('A-01');
	await page.getByRole('button', { name: 'Cari' }).click();
	await page.getByRole('link', { name: 'Detail' }).first().click();
	await page.getByRole('link', { name: 'Keuangan dan saldo titipan' }).click();
}

/** The distance, on each axis, between `locator`'s bounding-box center and the viewport's center. */
async function centerOffsetFromViewport(
	page: Page,
	locator: Locator
): Promise<{ x: number; y: number }> {
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error('The dialog has no bounding box - is it open?');
	}
	const viewport = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight
	}));
	return {
		x: Math.abs(box.x + box.width / 2 - viewport.width / 2),
		y: Math.abs(box.y + box.height / 2 - viewport.height / 2)
	};
}

for (const viewport of VIEWPORTS) {
	test(`the batalkan Tagihan dialog is centered at ${viewport.name}`, async ({ page }) => {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await signInAsSuperuser(page);
		await openUnitA01Finance(page);

		await page.getByRole('button', { name: 'Batalkan tagihan' }).first().click();
		const dialog = page.locator('dialog[open]');
		await expect(dialog).toBeVisible();

		const offset = await centerOffsetFromViewport(page, dialog);
		expect(offset.x).toBeLessThanOrEqual(CENTER_TOLERANCE_PIXELS);
		expect(offset.y).toBeLessThanOrEqual(CENTER_TOLERANCE_PIXELS);

		// Never confirm: Data Contoh is shared across this run's specs.
		await page.getByRole('button', { name: 'Batal' }).click();
		await expect(dialog).toBeHidden();
	});
}
