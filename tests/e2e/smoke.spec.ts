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

	await button.click();
	await expect(page.getByRole('list')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sembunyikan isi rangka' })).toHaveAttribute(
		'aria-expanded',
		'true'
	);
});
