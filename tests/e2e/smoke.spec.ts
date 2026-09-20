import { expect, test } from '@playwright/test';

test('the home page opens and the sample button reveals the scaffold contents', async ({
	page
}) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Sistem Informasi dan Manajemen Keuangan Komplek'
	);

	// The button labels are Indonesian because the interface is Indonesian; only the identifiers
	// and the test description are English.
	const button = page.getByRole('button', { name: 'Lihat isi rangka' });
	await expect(button).toHaveAttribute('aria-expanded', 'false');

	// The scaffold list by its own id: the sidebar puts lists of its own on every page, so the
	// `list` role alone now matches several elements and is a strict mode violation.
	const contents = page.locator('#scaffold-contents');

	// The button is answered by the page's own script, so a click that lands before hydration is
	// lost, and hydration leaves nothing on the button to wait for. Under parallel workers that
	// race is reliably lost, so the click is repeated until the contents answer.
	await expect(async () => {
		await button.click();
		await expect(contents).toBeVisible({ timeout: 1000 });
	}).toPass();
	await expect(page.getByRole('button', { name: 'Sembunyikan isi rangka' })).toHaveAttribute(
		'aria-expanded',
		'true'
	);
});
