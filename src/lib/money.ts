/**
 * Nilai uang untuk seluruh aplikasi: bilangan bulat rupiah, tanpa satuan pecahan.
 *
 * Keputusan yang ditetapkan di sini dan dipakai setiap spec berikutnya:
 *
 * 1. **Bilangan bulat rupiah, bukan sen.** Rupiah tidak punya satuan pecahan yang dipakai di
 *    dunia nyata, jadi tidak ada faktor 100 di mana pun. Sebuah `/ 100` atau `* 100` yang
 *    muncul di kode keuangan adalah tanda kesalahan, bukan konversi satuan.
 * 2. **`number`, bukan `bigint`.** Nilai terbesar yang bisa ditampung `number` tanpa kehilangan
 *    presisi adalah `Number.MAX_SAFE_INTEGER` (9.007.199.254.740.991 rupiah, sekitar sembilan
 *    kuadriliun). Kas satu komplek tidak akan mendekatinya dalam hitungan abad. `bigint` menukar
 *    kenyamanan yang besar (literal, `JSON.stringify`, aritmetika campuran, serialisasi form
 *    SvelteKit) dengan margin yang tidak akan terpakai. Batas aman tetap dijaga di `rupiah()`,
 *    sehingga nilai yang melewatinya ditolak, bukan dibulatkan diam-diam.
 * 3. **Tipe bermerek.** `Rupiah` adalah `number` yang diberi merek, sehingga sebuah `number`
 *    biasa tidak bisa masuk ke parameter bernilai uang tanpa melewati `rupiah()`. Hasil
 *    aritmetika (`a + b`) kembali menjadi `number` biasa dan harus dibungkus ulang dengan
 *    `rupiah(a + b)` — itu disengaja: pembungkusan ulang adalah tempat pemeriksaan bilangan
 *    bulat dan batas aman terjadi.
 * 4. **Masukan pecahan ditolak, tidak dibulatkan.** `rupiah(150.5)` dan `uraiRupiah('150,50')`
 *    melempar galat. Pembulatan diam-diam adalah cara uang hilang tanpa jejak; menolak masukan
 *    memaksa pemanggil memutuskan sendiri apa yang dimaksudnya.
 *
 * Di basis data nilai ini disimpan sebagai `bigint` (`int8`), bukan `integer` (`int4`): batas
 * `int4` adalah 2.147.483.647 rupiah, dan akumulasi buku kas satu komplek selama belasan tahun
 * bisa melewatinya. Lihat `src/lib/server/db/schema/index.ts`.
 */

declare const merekRupiah: unique symbol;

/** Nilai uang dalam rupiah penuh. Selalu bilangan bulat dalam rentang aman `number`. */
export type Rupiah = number & { readonly [merekRupiah]: 'Rupiah' };

/** Awalan mata uang yang dipakai `formatRupiah` dan diterima `uraiRupiah`. */
const AWALAN = 'Rp';

/** Pemisah ribuan Indonesia. Koma adalah pemisah desimal dan karena itu selalu ditolak. */
const PEMISAH_RIBUAN = '.';

/**
 * Bentuk teks yang diterima `uraiRupiah`:
 * tanda minus opsional, awalan `Rp` opsional, lalu digit polos (`150000`) atau digit yang
 * dikelompokkan dengan benar per tiga (`150.000`, `1.234.567`). Koma, titik desimal, dan
 * pengelompokan yang salah (`1234.567`) tidak cocok dan karena itu ditolak.
 */
const POLA_RUPIAH = /^(-?)(?:Rp\s*)?(\d{1,3}(?:\.\d{3})+|\d+)$/;

/**
 * Membungkus sebuah `number` menjadi `Rupiah`.
 *
 * @throws {TypeError} kalau nilainya bukan bilangan bulat berhingga — termasuk setiap pecahan,
 *   yang ditolak dan tidak pernah dibulatkan.
 * @throws {RangeError} kalau nilainya bilangan bulat tetapi di luar rentang aman `number`,
 *   sehingga aritmetika berikutnya akan kehilangan presisi.
 */
export function rupiah(nilai: number): Rupiah {
	if (!Number.isInteger(nilai)) {
		throw new TypeError(
			`Nilai rupiah harus bilangan bulat, bukan ${nilai}. Rupiah tidak punya satuan pecahan, dan pembulatan tidak dilakukan diam-diam.`
		);
	}
	if (!Number.isSafeInteger(nilai)) {
		throw new RangeError(
			`Nilai rupiah ${nilai} di luar rentang aman ${Number.MAX_SAFE_INTEGER}; aritmetika di atasnya akan kehilangan presisi.`
		);
	}
	return nilai as Rupiah;
}

/**
 * Memformat nilai uang menjadi teks Indonesia, misalnya `Rp 1.500.000` dan `-Rp 25.000`.
 *
 * Pengelompokan dikerjakan sendiri, bukan lewat `Intl.NumberFormat`, supaya hasilnya tidak
 * bergantung pada versi data ICU yang kebetulan terpasang di Node, Bun, atau container — mereka
 * berbeda dalam hal spasi biasa versus spasi tanpa putus setelah `Rp`, dan pengujian yang
 * membandingkan teks persis akan ikut berbeda.
 */
export function formatRupiah(nilai: Rupiah): string {
	const tanda = nilai < 0 ? '-' : '';
	return `${tanda}${AWALAN} ${kelompokkanRibuan(Math.abs(nilai))}`;
}

/**
 * Mengurai teks menjadi `Rupiah`. Menerima keluaran `formatRupiah` dan digit polos.
 *
 * @throws {TypeError} kalau teksnya tidak berbentuk rupiah bulat — termasuk setiap bentuk
 *   pecahan seperti `150,50`, yang ditolak dan tidak pernah dibulatkan.
 * @throws {RangeError} kalau nilainya di luar rentang aman `number`.
 */
export function uraiRupiah(teks: string): Rupiah {
	const cocok = POLA_RUPIAH.exec(teks.trim());
	if (!cocok) {
		throw new TypeError(
			`"${teks}" bukan nilai rupiah yang sah. Bentuk yang diterima: "150000", "150.000", "${AWALAN} 150.000", "-${AWALAN} 150.000". Pecahan tidak diterima.`
		);
	}
	const [, tanda, angka] = cocok;
	return rupiah(Number(`${tanda}${angka.replaceAll(PEMISAH_RIBUAN, '')}`));
}

/** Menyisipkan pemisah ribuan ke dalam digit sebuah bilangan bulat tak bertanda. */
function kelompokkanRibuan(nilai: number): string {
	const digit = String(nilai);
	let hasil = '';
	for (let akhir = digit.length; akhir > 0; akhir -= 3) {
		const potongan = digit.slice(Math.max(0, akhir - 3), akhir);
		hasil = hasil === '' ? potongan : `${potongan}${PEMISAH_RIBUAN}${hasil}`;
	}
	return hasil;
}
