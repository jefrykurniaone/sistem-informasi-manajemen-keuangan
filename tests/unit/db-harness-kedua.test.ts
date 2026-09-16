import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { percobaanRangka } from '$lib/server/db/schema';
import { basisDataUji } from '$lib/server/db/test-helpers';

const basis = basisDataUji();

/**
 * Penanda yang sama persis dengan yang ditulis `db-harness.test.ts`. Kalau isolasi antar berkas
 * bocor — dua berkas berbagi satu skema — salah satu dari kedua berkas ini akan melihat dua
 * baris memakai penanda ini, bukan satu.
 */
const PENANDA_BERSAMA = 'penanda-isolasi-antar-berkas';

/**
 * Rekan `db-harness.test.ts`, bukan salinannya. Berkas itu sudah membuktikan koneksi, migrasi,
 * bulat-tidaknya nilai bigint, dan komit sungguhan; berkas ini hanya membuktikan klaim isolasi
 * antar berkas: dua berkas yang berjalan berurutan atau paralel, menulis penanda yang identik,
 * tidak saling melihat baris satu sama lain.
 */
describe('isolasi antar berkas pengujian', () => {
	it('mendapat skema uji acak miliknya sendiri, bukan yang dipakai db-harness.test.ts', () => {
		expect(basis.skema).toMatch(/^uji_[0-9a-f]{32}$/);
	});

	it('mulai dengan tabel kosong di skemanya sendiri', async () => {
		const [hasil] = await basis.db.select({ jumlah: count() }).from(percobaanRangka);
		expect(hasil.jumlah).toBe(0);
	});

	it('menulis penanda bersama dan melihat tepat satu baris di skemanya sendiri', async () => {
		await basis.db
			.insert(percobaanRangka)
			.values({ keterangan: PENANDA_BERSAMA, nilai: rupiah(1) });

		const [hasil] = await basis.db
			.select({ jumlah: count() })
			.from(percobaanRangka)
			.where(eq(percobaanRangka.keterangan, PENANDA_BERSAMA));

		expect(hasil.jumlah).toBe(1);
	});
});
