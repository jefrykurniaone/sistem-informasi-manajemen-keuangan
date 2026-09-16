import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { bacaAlamatBasisData, buatKoneksi } from '$lib/server/db';
import { percobaanRangka } from '$lib/server/db/schema';
import { basisDataUji } from '$lib/server/db/test-helpers';

const basis = basisDataUji();

/**
 * Penanda yang juga ditulis berkas pengujian lain yang memakai perkakas ini. Pemeriksaannya
 * di bawah — tepat satu baris, bukan dua — adalah yang gagal kalau skema per berkas bocor.
 */
const PENANDA_BERSAMA = 'penanda-isolasi-antar-berkas';

describe('koneksi basis data', () => {
	it('menolak alamat yang kosong dengan pesan yang menyebut nama variabelnya', () => {
		expect(() => bacaAlamatBasisData('DATABASE_URL', {})).toThrow(/DATABASE_URL tidak diisi/);
	});

	it('menolak alamat yang hanya berisi spasi', () => {
		expect(() => bacaAlamatBasisData('TEST_DATABASE_URL', { TEST_DATABASE_URL: '   ' })).toThrow(
			/TEST_DATABASE_URL tidak diisi/
		);
	});
});

describe('perkakas uji basis data', () => {
	it('memakai nama skema yang dibangkitkan acak, sehingga tidak ada dua berkas yang berbagi', () => {
		expect(basis.skema).toMatch(/^uji_[0-9a-f]{32}$/);
	});

	it('memberi berkas ini skemanya sendiri, bukan public', async () => {
		const hasil = await basis.db.execute<{ skema: string }>(sql`select current_schema() as skema`);
		expect(hasil.rows[0]?.skema).toBe(basis.skema);
	});

	it('menjalankan migrasi, sehingga tabelnya ada di skema itu', async () => {
		const hasil = await basis.db.execute<{ jumlah: string }>(
			sql`select count(*) as jumlah from information_schema.tables
			    where table_schema = ${basis.skema} and table_name = 'percobaan_rangka'`
		);
		expect(hasil.rows[0]?.jumlah).toBe('1');
	});

	it('mulai dengan tabel kosong', async () => {
		const [hasil] = await basis.db.select({ jumlah: count() }).from(percobaanRangka);
		expect(hasil.jumlah).toBe(0);
	});

	it('menulis sebuah baris dan membacanya kembali', async () => {
		const [baris] = await basis.db
			.insert(percobaanRangka)
			.values({ keterangan: 'iuran sebulan', nilai: rupiah(150_000) })
			.returning();

		const dibaca = await basis.db
			.select()
			.from(percobaanRangka)
			.where(eq(percobaanRangka.id, baris.id));

		expect(dibaca).toEqual([
			{
				id: baris.id,
				keterangan: 'iuran sebulan',
				nilai: 150_000,
				dibuatPada: baris.dibuatPada
			}
		]);
	});

	it('mengembalikan nilai uang sebagai number bulat, bukan string, dari kolom bigint', async () => {
		// Kesalahan yang dicegah: `bigint` tanpa `mode: 'number'` sampai ke kode sebagai string,
		// dan "150000" + "150000" adalah "150000150000".
		const besar = 987_654_321_098;
		const [baris] = await basis.db
			.insert(percobaanRangka)
			.values({ keterangan: 'nilai besar', nilai: rupiah(besar) })
			.returning();

		expect(baris.nilai).toBe(besar);
	});

	it('benar-benar mengomit, sehingga koneksi lain melihat barisnya', async () => {
		// Ini yang membuat perkakas ini memakai skema per berkas, bukan transaksi yang digulung
		// balik: aturan buku kas yang hanya-tambah adalah aturan tentang komit, dan tidak bisa
		// diuji dari dalam transaksi yang tidak pernah komit.
		const [baris] = await basis.db
			.insert(percobaanRangka)
			.values({ keterangan: 'bukti komit', nilai: rupiah(1) })
			.returning();

		const lain = buatKoneksi(bacaAlamatBasisData('TEST_DATABASE_URL'), {
			options: `-c search_path=${basis.skema}`
		});
		try {
			const dibaca = await lain.db
				.select()
				.from(percobaanRangka)
				.where(eq(percobaanRangka.id, baris.id));
			expect(dibaca).toHaveLength(1);
		} finally {
			await lain.tutup();
		}
	});

	it('tidak meninggalkan apa pun di skema public', async () => {
		// Kalau search_path salah, migrasi akan mendarat di public dan setiap berkas pengujian
		// akan berbagi satu tabel. Pemeriksaan ini gagal seketika kalau itu terjadi.
		const hasil = await basis.db.execute<{ jumlah: string }>(
			sql`select count(*) as jumlah from information_schema.tables where table_schema = 'public'`
		);
		expect(hasil.rows[0]?.jumlah).toBe('0');
	});

	it('menulis penanda bersama tepat sekali, meski berkas lain menulis penanda yang sama', async () => {
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
