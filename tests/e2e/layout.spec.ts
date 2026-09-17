import { expect, test } from '@playwright/test';

/**
 * The app shell — navigation and the language switcher — at 390 pixels, the narrowest width this
 * ticket's acceptance criteria name. See `spec-fondasi-v1.md`'s "Antarmuka" and "i18n" sections.
 *
 * Kept thin on purpose, matching `spec-fondasi-v1.md`'s testing decision that Playwright proves the
 * shell is alive rather than exercising every role: an anonymous visitor is the one state this
 * spec can reach without registering and verifying an account first.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('an anonymous visitor sees only the public navigation, with no horizontal overflow at 390px', async ({
	page
}) => {
	await page.goto('/');

	const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
	await expect(nav).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Masuk' })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Daftar' })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Kelola Peran' })).toHaveCount(0);
	await expect(nav.getByRole('button', { name: 'Keluar' })).toHaveCount(0);

	const hasHorizontalOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	expect(hasHorizontalOverflow).toBe(false);
});

test('the language switcher is a labelled, keyboard-usable control whose choice survives a reload', async ({
	page
}) => {
	await page.goto('/');

	const switcher = page.getByLabel('Bahasa');
	await expect(switcher).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'id');

	await switcher.selectOption('en');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByLabel('Language')).toHaveValue('en');

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByLabel('Language')).toHaveValue('en');
});
