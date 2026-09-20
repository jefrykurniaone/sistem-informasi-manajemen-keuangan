import { expect, test } from '@playwright/test';

/**
 * The app shell — the sidebar drawer and the language switcher — at 390 pixels, the narrowest
 * width this application's acceptance criteria name. See `spec-fondasi-v1.md`'s "Antarmuka" and
 * "i18n" sections, and `spec-shell-beranda-v1.md`'s 390 pixel criteria.
 *
 * Kept thin on purpose, matching `spec-fondasi-v1.md`'s testing decision that Playwright proves the
 * shell is alive rather than exercising every role: an anonymous visitor is the one state this
 * spec can reach without registering and verifying an account first. Hover intent, the icon mode
 * and the floating panel are walk criteria, not assertions here — `spec-shell-beranda-v1.md`'s
 * testing decisions put them on the Playwright MCP walk at 1280 and 390 pixels.
 *
 * At this width the sidebar is a drawer, so the navigation landmark only exists once the menu
 * button has been pressed. Every test below opens it first for that reason.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** The accessible name of the control that opens the drawer, `appShell_toggleSidebar`. */
const MENU_BUTTON_ID = 'Buka atau tutup menu';
const MENU_BUTTON_EN = 'Open or close menu';

test('an anonymous visitor opens the drawer from the menu button and sees only the public navigation, with no horizontal overflow at 390px', async ({
	page
}) => {
	await page.goto('/');

	const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
	await expect(nav).toBeHidden();

	await page.getByRole('button', { name: MENU_BUTTON_ID }).click();

	await expect(nav).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Masuk' })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Daftar' })).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Kelola Peran' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Keluar' })).toHaveCount(0);

	const hasHorizontalOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	expect(hasHorizontalOverflow).toBe(false);
});

test('every link in the open drawer is at least 44 pixels tall', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: MENU_BUTTON_ID }).click();

	const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
	const links = await nav.getByRole('link').all();
	expect(links.length).toBeGreaterThan(0);

	for (const link of links) {
		const box = await link.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	}
});

test('choosing a link in the drawer closes it and moves to that page', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: MENU_BUTTON_ID }).click();

	const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
	await nav.getByRole('link', { name: 'Masuk' }).click();

	await expect(page).toHaveURL(/\/login$/);
	await expect(nav).toBeHidden();
});

test('the language switcher is a labelled, keyboard-usable control whose choice survives a reload', async ({
	page
}) => {
	await page.goto('/');
	await page.getByRole('button', { name: MENU_BUTTON_ID }).click();

	const switcher = page.getByLabel('Bahasa');
	await expect(switcher).toBeVisible();
	await switcher.focus();
	await expect(switcher).toBeFocused();
	await expect(page.locator('html')).toHaveAttribute('lang', 'id');

	// `setLocale` navigates the whole document, which closes the drawer with it.
	await switcher.selectOption('en');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	await page.getByRole('button', { name: MENU_BUTTON_EN }).click();
	await expect(page.getByLabel('Language')).toHaveValue('en');

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await page.getByRole('button', { name: MENU_BUTTON_EN }).click();
	await expect(page.getByLabel('Language')).toHaveValue('en');
});
