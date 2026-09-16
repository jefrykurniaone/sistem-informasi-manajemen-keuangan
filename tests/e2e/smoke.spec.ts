import { expect, test } from '@playwright/test';

test('halaman beranda terbuka dan tombol contoh membuka isi rangka', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Sistem Informasi dan Manajemen Keuangan Komplek'
	);

	const tombol = page.getByRole('button', { name: 'Lihat isi rangka' });
	await expect(tombol).toHaveAttribute('aria-expanded', 'false');

	await tombol.click();
	await expect(page.getByRole('list')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sembunyikan isi rangka' })).toHaveAttribute(
		'aria-expanded',
		'true'
	);
});
