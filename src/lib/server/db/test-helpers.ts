import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll } from 'vitest';
import { bacaAlamatBasisData, buatKoneksi, type BasisData, type Koneksi } from './index';

/**
 * Perkakas uji basis data: satu skema PostgreSQL bersih per berkas pengujian.
 *
 * ## Kontrak
 *
 * `basisDataUji()` dipanggil sekali di puncak sebuah berkas pengujian. Ia mendaftarkan kait
 * `beforeAll` dan `afterAll`, lalu mengembalikan pegangan yang `db`-nya siap dipakai di dalam
 * setiap `it`. Berkas itu mendapat skema PostgreSQL miliknya sendiri, sudah termigrasi dan
 * kosong, dan skema itu dihapus seluruhnya setelah berkasnya selesai.
 *
 * ## Mengapa skema per berkas, bukan transaksi yang digulung balik
 *
 * Membungkus setiap pengujian di dalam satu transaksi lalu menggulungnya balik adalah cara yang
 * paling cepat, dan cara itu **sengaja tidak dipakai**. Spec keuangan menulis ke buku kas yang
 * hanya-tambah, dan aturannya adalah aturan tentang komit: nomor urut yang diambil saat komit,
 * kunci baris yang dipegang sampai komit, pemicu yang menolak pembaruan setelah komit, dan
 * pekerjaan terjadwal yang mengambil kunci untuk satu periode. Semua itu tidak bisa diuji dari
 * dalam sebuah transaksi yang tidak pernah komit — pengujiannya akan lulus terhadap perilaku
 * yang tidak pernah terjadi di produksi. Di dalam skema sendiri, pengujian komit sungguhan,
 * membaca kembali apa yang dikomitnya, dan tetap tidak terlihat oleh berkas lain.
 *
 * Membersihkan dengan `truncate` di antara pengujian juga ditolak: ia berbagi satu ruang nama,
 * jadi dua berkas yang berjalan bersamaan — dan Vitest memang menjalankan berkas secara paralel —
 * akan saling menghapus barisnya. Skema per berkas memberi isolasi yang sama tanpa memaksa
 * pengujian berjalan berurutan.
 *
 * Harganya: migrasi dijalankan ulang untuk setiap berkas pengujian. Selama migrasinya masih
 * puluhan berkas SQL, biayanya di bawah satu detik per berkas. Kalau suatu saat terasa, langkah
 * berikutnya adalah menyiapkan satu skema contoh sekali lalu menyalinnya, bukan kembali ke
 * penggulungan balik.
 *
 * ## Basis data mana
 *
 * `TEST_DATABASE_URL`, yang wajib berbeda dari `DATABASE_URL`. Perkakas ini menghapus skema dan
 * membuat basis data; menunjuknya ke basis data yang sama dengan server pengembangan adalah
 * kesalahan yang mahal, jadi ia ditolak di sini alih-alih dibiarkan berjalan. Basis data uji
 * dibuat otomatis kalau belum ada, sehingga `docker compose up db` lalu `bun run test` cukup
 * tanpa langkah pasang tangan.
 */

/** Nama tabel jurnal migrasi di dalam skema uji. Ikut terhapus bersama skemanya. */
const TABEL_MIGRASI = '__migrasi__';

/** Kode galat PostgreSQL untuk basis data yang tidak ada. */
const BASIS_DATA_TIDAK_ADA = '3D000';

/**
 * Kode galat PostgreSQL yang berarti "basis datanya sudah ada" ketika dua berkas pengujian yang
 * berjalan paralel berlomba membuatnya. `42P04` datang dari pemeriksaan nama, `23505` dari indeks
 * unik `pg_database_datname_index` ketika lomba itu kalah tipis; keduanya sama-sama berarti
 * pekerjaannya sudah dikerjakan berkas lain.
 */
const BASIS_DATA_SUDAH_ADA = ['42P04', '23505'];

/** Pegangan yang dikembalikan `basisDataUji()`. */
export interface BasisDataUji {
	/** Basis data berkas ini. Baru tersedia setelah `beforeAll` berjalan. */
	readonly db: BasisData;
	/** Nama skema PostgreSQL milik berkas ini, berguna saat membaca pesan galat. */
	readonly skema: string;
}

/**
 * Menyiapkan skema PostgreSQL bersih untuk berkas pengujian yang memanggilnya.
 *
 * ```ts
 * const basis = basisDataUji();
 *
 * it('menyimpan baris', async () => {
 *   await basis.db.insert(percobaanRangka).values({ keterangan: 'satu', nilai: rupiah(1) });
 * });
 * ```
 */
export function basisDataUji(): BasisDataUji {
	const skema = `uji_${randomUUID().replaceAll('-', '')}`.slice(0, 40);
	let koneksi: Koneksi | undefined;

	beforeAll(async () => {
		const alamat = alamatUji();
		await pastikanBasisDataAda(alamat);
		koneksi = buatKoneksi(alamat, { options: `-c search_path=${skema}` });
		await siapkanSkema(koneksi.db, skema);
	});

	afterAll(async () => {
		if (!koneksi) {
			return;
		}
		await koneksi.db.execute(sql.raw(`drop schema if exists "${skema}" cascade`));
		await koneksi.tutup();
	});

	return {
		skema,
		get db() {
			if (!koneksi) {
				throw new Error(
					'Basis data uji belum siap. basisDataUji() harus dipanggil di puncak berkas pengujian, dan db-nya hanya boleh dipakai di dalam it() atau beforeEach, bukan di ruang lingkup modul.'
				);
			}
			return koneksi.db;
		}
	};
}

/** Membaca `TEST_DATABASE_URL` dan menolak kalau ia menunjuk ke basis data server pengembangan. */
function alamatUji(): string {
	const alamat = bacaAlamatBasisData('TEST_DATABASE_URL');
	if (alamat === process.env.DATABASE_URL?.trim()) {
		throw new Error(
			'TEST_DATABASE_URL sama persis dengan DATABASE_URL. Perkakas uji membuat dan menghapus skema, jadi ia menolak berjalan di atas basis data server pengembangan. Isi TEST_DATABASE_URL dengan basis data tersendiri, misalnya komplek_test.'
		);
	}
	return alamat;
}

/** Membuat skema berkas ini, memastikan `search_path` benar-benar menunjuk ke sana, lalu migrasi. */
async function siapkanSkema(db: BasisData, skema: string): Promise<void> {
	await db.execute(sql.raw(`create schema if not exists "${skema}"`));

	// `search_path` disetel saat koneksi dibuka, ketika skemanya belum ada. Pemeriksaan ini
	// membuktikan ia benar-benar berlaku sekarang; tanpanya, sebuah kesalahan setelan akan
	// menaruh tabel di `public` dan isolasi antar berkas hilang tanpa satu pun pengujian gagal.
	const hasil = await db.execute<{ skema: string | null }>(sql`select current_schema() as skema`);
	if (hasil.rows[0]?.skema !== skema) {
		throw new Error(
			`search_path tidak menunjuk ke skema uji: current_schema() adalah ${hasil.rows[0]?.skema}, seharusnya ${skema}.`
		);
	}

	await migrate(db, {
		migrationsFolder: path.resolve(process.cwd(), 'drizzle'),
		migrationsSchema: skema,
		migrationsTable: TABEL_MIGRASI
	});
}

/**
 * Membuat basis data uji kalau ia belum ada, dengan menyambung ke basis data pemeliharaan
 * `postgres` pada peladen yang sama. Jalur normal tidak membayar apa pun: pembuatan hanya dicoba
 * setelah sambungan pertama ditolak dengan `3D000`.
 */
async function pastikanBasisDataAda(alamat: string): Promise<void> {
	const koneksi = buatKoneksi(alamat);
	try {
		await koneksi.db.execute(sql`select 1`);
		return;
	} catch (galat) {
		if (kodeGalat(galat) !== BASIS_DATA_TIDAK_ADA) {
			throw galat;
		}
	} finally {
		await koneksi.tutup();
	}
	await buatBasisData(alamat);
}

/** Menjalankan `create database` lewat basis data pemeliharaan `postgres`. */
async function buatBasisData(alamat: string): Promise<void> {
	const tujuan = new URL(alamat);
	const nama = decodeURIComponent(tujuan.pathname.slice(1));
	tujuan.pathname = '/postgres';

	const koneksi = buatKoneksi(tujuan.toString());
	try {
		await koneksi.db.execute(sql.raw(`create database "${nama.replaceAll('"', '""')}"`));
	} catch (galat) {
		// Dua berkas pengujian yang berjalan paralel bisa sama-sama sampai di sini.
		const kode = kodeGalat(galat);
		if (!kode || !BASIS_DATA_SUDAH_ADA.includes(kode)) {
			throw galat;
		}
	} finally {
		await koneksi.tutup();
	}
}

/**
 * Mengambil `code` dari galat PostgreSQL, atau `undefined` kalau bentuknya bukan itu.
 *
 * Drizzle membungkus galat driver di dalam galatnya sendiri, jadi kodenya ada di rantai `cause`,
 * bukan di galat paling luar.
 */
function kodeGalat(galat: unknown): string | undefined {
	let sekarang: unknown = galat;
	while (sekarang instanceof Error) {
		if ('code' in sekarang && typeof sekarang.code === 'string') {
			return sekarang.code;
		}
		sekarang = sekarang.cause;
	}
	return undefined;
}
