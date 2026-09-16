import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as skema from './schema';

/**
 * Satu-satunya tempat koneksi Drizzle ke PostgreSQL dibentuk.
 *
 * Keputusan yang ditetapkan di sini dan dipakai setiap spec berikutnya:
 *
 * 1. **Pabrik dulu, singleton belakangan.** `buatKoneksi()` adalah pabrik yang menerima alamat
 *    basis data sebagai argumen, dan `basisData()` adalah singleton malas di atasnya untuk
 *    aplikasi yang berjalan. Urutan ini penting karena pengujian butuh koneksi ke basis data
 *    yang *berbeda* dari server pengembangan, dan satu berkas pengujian bahkan butuh skemanya
 *    sendiri. Kalau modul ini mengekspor satu objek `db` yang dibentuk saat impor, tidak ada
 *    cara membuat koneksi kedua tanpa menambal variabel lingkungan.
 * 2. **Malas, bukan saat impor.** Singleton baru dibentuk pada pemanggilan pertama. Modul ini
 *    ikut terbawa ke dalam graf impor pengujian murni dan perkakas baris perintah yang tidak
 *    menyentuh basis data sama sekali; membentuk kolam koneksi saat impor akan membuat mereka
 *    gagal karena alasan yang tidak ada hubungannya dengan apa yang sedang diuji.
 * 3. **`process.env`, bukan `$env/dynamic/private`.** Berkas ini dibaca dari tiga tempat dengan
 *    pemuat modul yang berbeda: server SvelteKit, Vitest, dan `drizzle-kit`. Hanya yang pertama
 *    bisa menyelesaikan alias `$env`. `process.env` berlaku di ketiganya, dan `bun run` sudah
 *    memuat `.env` ke dalamnya sebelum perintah apa pun berjalan.
 * 4. **Galat yang menyebut nama variabelnya.** Alamat yang kosong ditolak di sini dengan pesan
 *    yang menyebut nama variabel lingkungannya, bukan diteruskan ke driver dan muncul belasan
 *    bingkai di bawah sebagai `TypeError` tentang properti `host` yang undefined.
 */

/** Basis data aplikasi, sudah terikat pada skema di `./schema`. */
export type BasisData = NodePgDatabase<typeof skema>;

/** Sebuah koneksi hidup beserta cara menutupnya. */
export interface Koneksi {
	readonly db: BasisData;
	readonly pool: Pool;
	tutup(): Promise<void>;
}

/**
 * Membaca alamat basis data dari variabel lingkungan.
 *
 * @param nama nama variabelnya — `DATABASE_URL` untuk aplikasi, `TEST_DATABASE_URL` untuk
 *   perkakas uji.
 * @throws {Error} dengan pesan yang menyebut nama variabelnya kalau ia kosong atau tidak ada.
 */
export function bacaAlamatBasisData(
	nama = 'DATABASE_URL',
	lingkungan: NodeJS.ProcessEnv = process.env
): string {
	const alamat = lingkungan[nama]?.trim();
	if (!alamat) {
		throw new Error(
			`Variabel lingkungan ${nama} tidak diisi. Salin .env.example menjadi .env, lalu isi ${nama} dengan alamat PostgreSQL, misalnya postgres://pengguna:kata-sandi@localhost:5432/komplek.`
		);
	}
	return alamat;
}

/**
 * Membentuk koneksi Drizzle baru. Setiap pemanggilan menghasilkan kolam koneksi tersendiri yang
 * harus ditutup pemanggilnya.
 *
 * @param alamat alamat PostgreSQL lengkap.
 * @param opsi setelan `pg` tambahan. Perkakas uji memakainya untuk mengunci `search_path` sebuah
 *   berkas pengujian ke skemanya sendiri.
 */
export function buatKoneksi(alamat: string, opsi: PoolConfig = {}): Koneksi {
	const pool = new Pool({ ...opsi, connectionString: alamat });
	// `casing` harus sama dengan yang ada di drizzle.config.ts. Lihat catatan di ./schema.
	const db = drizzle({ client: pool, schema: skema, casing: 'snake_case' });
	return {
		db,
		pool,
		tutup: () => pool.end()
	};
}

let koneksiAplikasi: Koneksi | undefined;

/**
 * Basis data aplikasi yang sedang berjalan, dibentuk sekali dari `DATABASE_URL` pada pemanggilan
 * pertama. Lapisan service memakai ini; pengujian tidak — pengujian memakai `buatKoneksi()`
 * lewat `./test-helpers`.
 */
export function basisData(): BasisData {
	koneksiAplikasi ??= buatKoneksi(bacaAlamatBasisData());
	return koneksiAplikasi.db;
}

/** Menutup koneksi aplikasi kalau ia sudah terbentuk. Dipakai saat proses dimatikan. */
export async function tutupBasisData(): Promise<void> {
	const koneksi = koneksiAplikasi;
	koneksiAplikasi = undefined;
	await koneksi?.tutup();
}
