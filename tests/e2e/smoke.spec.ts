import { expect, test } from '@playwright/test';

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
