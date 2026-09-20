import { expect, test, type Locator, type Page } from '@playwright/test';

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

/** The accessible name of the sidebar landmark, `appShell_mainNavigation`. */
const MAIN_NAV_ID = 'Navigasi utama';

/**
 * Presses the menu button until the drawer it opens is on screen.
 *
 * The drawer is opened by the component's own script, so a click that lands before the page has
 * hydrated is simply lost. The old navigation needed no script and never had this race. Hydration
 * leaves nothing on the button to wait for either — its attributes are the same at
 * `domcontentloaded` and 1500 ms later — and a marker added to the application only for the tests
 * would be worse than repeating the click here, so the click is repeated until the drawer answers.
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

test('an anonymous visitor opens the drawer from the menu button and sees only the public navigation, with no horizontal overflow at 390px', async ({
	page
}) => {
	await page.goto('/');

	const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
	await expect(nav).toBeHidden();

	await openDrawer(page, MENU_BUTTON_ID, nav);

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

	const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
	await openDrawer(page, MENU_BUTTON_ID, nav);

	const links = await nav.getByRole('link').all();
	expect(links.length).toBeGreaterThan(0);

	for (const link of links) {
		const box = await link.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	}
});

test('choosing a link in the drawer closes it and moves to that page', async ({ page }) => {
	await page.goto('/');

	const nav = page.getByRole('navigation', { name: MAIN_NAV_ID });
	await openDrawer(page, MENU_BUTTON_ID, nav);

	await nav.getByRole('link', { name: 'Masuk' }).click();

	await expect(page).toHaveURL(/\/login$/);
	await expect(nav).toBeHidden();
});

test('the language switcher is a labelled, keyboard-usable control whose choice survives a reload', async ({
	page
}) => {
	await page.goto('/');

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
