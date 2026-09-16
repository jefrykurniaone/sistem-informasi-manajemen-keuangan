import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';

/**
 * Skema basis data. Setiap tabel aplikasi diekspor dari berkas ini, dan `drizzle-kit`
 * membacanya lewat `schema` di `drizzle.config.ts`.
 *
 * Konvensi yang ditetapkan di sini dan diikuti setiap tabel berikutnya:
 *
 * - **Nama kolom tidak ditulis dua kali.** `casing: 'snake_case'` mengubah nama properti
 *   TypeScript menjadi nama kolom SQL (`dibuatPada` menjadi `dibuat_pada`). Setelan itu harus
 *   ada di dua tempat sekaligus — `drizzle.config.ts` untuk pembuatan migrasi dan panggilan
 *   `drizzle()` di `src/lib/server/db/index.ts` untuk kueri saat berjalan. Kalau hanya satu yang
 *   punya, kueri akan menyebut kolom yang tidak ada di basis data.
 * - **Nama tabel ditulis apa adanya** dalam bentuk `snake_case` Indonesia, karena nama tabel
 *   muncul di berkas migrasi dan di psql, bukan hanya di TypeScript.
 * - **Kunci primer adalah `uuid`**, bukan urutan bilangan bulat: nomor tagihan dan nomor
 *   pembayaran tidak boleh bisa ditebak dari alamat halaman tetangga.
 * - **Nilai uang adalah `bigint` dengan `mode: 'number'`**, bukan `integer`. Batas `integer`
 *   (`int4`) adalah 2.147.483.647 rupiah; akumulasi buku kas satu komplek selama belasan tahun
 *   bisa melewatinya, dan sebuah kolom yang meluap lebih mahal daripada delapan bita per baris.
 *   `mode: 'number'` membuat driver mengembalikan `number`, bukan `string`, dan `.$type<Rupiah>()`
 *   membuat tipe uang di `src/lib/money.ts` ikut sampai ke hasil kueri.
 * - **Cap waktu selalu `withTimezone`**, supaya tidak ada baris yang maknanya bergantung pada
 *   zona waktu proses yang kebetulan menulisnya.
 */

/**
 * Tabel percobaan milik tiket rangka basis data. Ia tidak punya arti domain: tugasnya hanya
 * membuktikan bahwa migrasi benar-benar berjalan dan sebuah baris bisa ditulis lalu dibaca
 * kembali lewat perkakas uji. Tiket yang memasang tabel domain pertama boleh menghapusnya
 * beserta migrasi penghapusnya.
 */
export const percobaanRangka = pgTable('percobaan_rangka', {
	id: uuid().primaryKey().defaultRandom(),
	keterangan: text().notNull(),
	nilai: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
	dibuatPada: timestamp({ withTimezone: true }).notNull().defaultNow()
});
