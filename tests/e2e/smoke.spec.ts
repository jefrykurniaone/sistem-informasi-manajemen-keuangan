import { expect, test, type Page } from '@playwright/test';

/**
 * `/` is the Beranda now, and every page in the `(app)` group is guarded by its own session check
 * — `docs/spec-shell-beranda-v1.md`'s "Tanpa sesi, dialihkan ke halaman masuk." This replaces the
 * old scaffold smoke test, which asserted the scaffold page #142 deleted.
 */
test('the home page redirects an anonymous visitor to the login page', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Masuk');
});

/**
 * Click-only menu groups: `docs/spec-shell-masuk-v1.md`'s "Grup menu terbuka hanya saat judulnya
 * diklik ... Tidak ada pengatur waktu hover." #174 removes the hover-intent behaviour
 * `docs/spec-shell-beranda-v1.md` had introduced (`src/lib/components/app-shell/nav-group.svelte`):
 * hovering a group's title must never open it, only a click, a tap, or Enter/Space does.
 *
 * Signs in as the Data Contoh superuser account, the same fixture and password
 * `tests/e2e/dialogs.spec.ts` uses (see `README.md`, "Data Contoh"), which holds every menu group
 * so "Keuangan" and "Warga & Unit" are both on screen at 1920px without registering a throwaway
 * account here.
 */

/** The Data Contoh superuser account (`README.md`, "Data Contoh"). */
const SUPERUSER_EMAIL = 'superuser@komplek.local';
const SUPERUSER_PASSWORD = 'kata-sandi-dummy-123';

/** The label on the address field in the sign-in form. */
const EMAIL_FIELD = 'Alamat email';

/** The accessible name of the sidebar landmark, `appShell_navLabel`. */
const MAIN_NAV_ID = 'Navigasi utama';

/**
 * Longer than the 300 ms open timer hover-intent used to run on, so a leftover timer would have
 * fired well before this check runs if the removal in `nav-group.svelte` were incomplete.
 */
const HOVER_SETTLE_MILLISECONDS = 1000;

/**
 * Opens `path` and waits until the page can be typed into or clicked into. `goto` alone races
 * hydration: Svelte's hydration overwrites bindings and only wires up `onclick` handlers once it
 * finishes, roughly 100 ms after `load` for the first `(app)` page after `/login`. See
 * `tests/e2e/layout.spec.ts` and `tests/e2e/dialogs.spec.ts` for the same helper.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** Signs the Data Contoh superuser in on `page`, and waits for the landing page to be hydrated. */
async function signInAsSuperuser(page: Page): Promise<void> {
	await open(page, '/login');
	await page.getByLabel(EMAIL_FIELD).fill(SUPERUSER_EMAIL);
	await page.getByLabel('Kata sandi').fill(SUPERUSER_PASSWORD);
	await page.getByRole('button', { name: 'Masuk' }).click();
	await expect(page).toHaveURL(/\/$/);
	await page.waitForLoadState('networkidle');
}

test.describe('sidebar menu groups open only on click, never on hover', () => {
	test.use({ viewport: { width: 1920, height: 1080 } });

	test('hovering a group title never opens it; clicking toggles it; opening another group closes it; the active group is open on load', async ({
		page
	}) => {
		await signInAsSuperuser(page);

		const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
		const financeTitle = nav.getByRole('button', { name: 'Keuangan', exact: true });
		const residentsTitle = nav.getByRole('button', { name: 'Warga & Unit', exact: true });

		// Hovering, even held well past the old 300 ms open timer, opens nothing.
		await financeTitle.hover();
		await page.waitForTimeout(HOVER_SETTLE_MILLISECONDS);
		await expect(financeTitle).toHaveAttribute('aria-expanded', 'false');
		await expect(nav.getByRole('link', { name: 'Verifikasi Pembayaran' })).toBeHidden();

		// A click opens it, and a second click on the same title closes it again.
		await financeTitle.click();
		await expect(financeTitle).toHaveAttribute('aria-expanded', 'true');
		await expect(nav.getByRole('link', { name: 'Verifikasi Pembayaran' })).toBeVisible();

		await financeTitle.click();
		await expect(financeTitle).toHaveAttribute('aria-expanded', 'false');

		// Only one group open at a time: opening Warga & Unit closes Keuangan.
		await financeTitle.click();
		await expect(financeTitle).toHaveAttribute('aria-expanded', 'true');
		await residentsTitle.click();
		await expect(residentsTitle).toHaveAttribute('aria-expanded', 'true');
		await expect(financeTitle).toHaveAttribute('aria-expanded', 'false');

		// The group holding the active page is open the moment the page loads.
		await open(page, '/admin/payments');
		await expect(
			page.getByRole('navigation', { name: MAIN_NAV_ID }).getByRole('button', {
				name: 'Keuangan',
				exact: true
			})
		).toHaveAttribute('aria-expanded', 'true');
	});
});
