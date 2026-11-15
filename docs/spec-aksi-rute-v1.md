# Spec: aksi-rute v1 - Satu modul menerjemahkan galat domain menjadi hasil route

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#310](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/310) |
| Run | `perdalam-v1` |
| Peta eksekusi | [#334](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/334) |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |
| Lintasan penutup | 2026-11-16, sesudah Gelombang 6 (`feat/perdalam-v1` @ `cac5bf0`): dibuat ulang dari item, yang kini memuat bagian "Catatan penyerahan" dengan klaim yang dibalik ditandai; tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-15, setiap route di grup `(app)` menerjemahkan galat domain menjadi hasil route dengan caranya sendiri.

- Ada 30 salinan pribadi fungsi yang mengubah galat menjadi `error(403)` atau `error(404)`. Isinya sama, kecuali kunci pesannya.
- Ada 8 varian fungsi penolak form yang masing-masing mendaftar cabang `instanceof` yang ia kenal. Galat domain yang lupa didaftar menjadi galat 500.
- Galat Periode terkunci dipetakan terpisah di 5 route.
- Pelengkapnya juga berulang: 90 salinan penjaga sesi yang mengalihkan ke halaman masuk, 117 salinan pembacaan field form yang dipangkas, pemasangan basis data dan jam di setiap aksi, dan 12 route yang membangun penyimpanan berkas sendiri.

Riwayatnya:

- Commit `cb96a8c` (#97): Periode terkunci menjadi galat 500 di `/admin/cash` dan `/admin/cash/new`, karena route itu hanya mengenal galat aturan kas.
- Commit `c4f0bca` (#111): penjaga pengenal bukan-UUID ditambahkan ke enam route satu per satu.

API Elysia sudah punya bentuk yang dalam: satu penangan galat yang mengubah penolakan hak menjadi 403.

## Solution

- Setiap aksi yang ditolak menampilkan pesan di form, atau halaman 403 atau 404 yang tepat, dan tidak pernah galat 500 mentah karena cabang yang terlupa.
- Pesan yang dilihat pengguna tidak berubah.

## Goals and non-goals

**Goals**

- Satu modul di seam aksi route memegang penjaga sesi, pemetaan galat domain ke hasil route, dependensi produksi, dan pembacaan field form.
- Galat domain menyatakan sendiri bagaimana ia ditolak, sehingga galat baru tertangani di semua route tanpa menyunting route.
- Semua route di grup `(app)` dimigrasi, lalu salinan pribadinya dihapus.

**Non-goals**

- Teks pesan tidak berubah, dan tetap ditentukan per route.
- Hak dan aturan domain tidak berubah.
- API Elysia tidak berubah.

## User stories

1. Sebagai Admin yang mencatat transaksi di Periode terkunci, saya ingin pesan yang menjelaskan Periode terkunci, bukan halaman galat.
2. Sebagai pengguna yang membuka tautan dengan pengenal rusak, saya ingin halaman 404, bukan galat 500.
3. Sebagai pengguna tanpa hak, saya ingin halaman 403 yang konsisten di setiap layar.
4. Sebagai pengguna yang sesinya habis, saya ingin dialihkan ke halaman masuk dari layar mana pun.
5. Sebagai pengguna, saya ingin pesan di setiap form tetap sama dengan sekarang.
6. Sebagai pengembang yang menambah galat domain, saya ingin galat itu tertangani di semua route tanpa menyunting route.
7. Sebagai pengembang yang menambah aksi baru, saya ingin cukup memanggil domain dan menyebut pesannya.
8. Sebagai pengembang, saya ingin pemetaan galat diuji sekali, di luar browser.

## Implementation decisions

**1. Modul aksi route.**

- Isinya: penjaga sesi (mengalihkan ke halaman masuk), pemetaan galat domain ke hasil route, dependensi produksi (basis data, jam, penyimpanan berkas), dan pembaca field form (teks dipangkas, opsional, dan Rupiah).
- Pemetaannya: penolakan hak menjadi 403, tidak ditemukan atau pengenal rusak menjadi 404, dan pelanggaran aturan menjadi `fail(400)` dengan pesan route itu.
- Galat domain menyatakan kategorinya sendiri, entah lewat kelas dasar atau lewat registrasi di modul ini. Galat yang tidak dikenal tetap diteruskan, supaya bug sungguhan tidak tersembunyi.
- _Mengapa:_ cabang yang terlupa sudah menghasilkan 500 di produksi, dan perbaikannya harus diulang per route.

**2. Pesan tetap milik route.** Route menyebut pesan per jenis galat, atau galat membawa kunci pesannya. Teks layar tetap lewat Paraglide.

**3. Dikerjakan bertahap: bangun, migrasi, bersihkan.**

- **Bangun:** modul dan tesnya dibangun lebih dulu, tanpa menyentuh route.
- **Migrasi:** route dimigrasi dalam beberapa kelompok menurut area. Setiap kelompok adalah tiket sendiri yang diblokir oleh tiket bangun.
- **Bersihkan:** salinan pribadi terakhir dihapus, dan sebuah penjaga (aturan lint atau tes) mencegah route mendefinisikan penerjemah galatnya sendiri lagi.
- Aksi baru dari spec lain di run ini memakai modul ini sejak awal, kalau modulnya sudah ada.

**4. API Elysia.** Penangan galatnya tetap. Kalau memungkinkan tanpa mengubah perilakunya, ia memakai tabel pemetaan yang sama.

## Testing decisions

- **Seam:** tabel pemetaan di modul aksi route, diuji in-process untuk setiap kategori galat beserta hasilnya. Tidak perlu basis data.
- **Penjaga sesi dan pembaca field** diuji di modul yang sama.
- **Tes regresi:** tes yang membuktikan galat Periode terkunci di aksi buku kas menjadi `fail(400)`, bukan 500.
- **Per kelompok migrasi:** spec e2e yang sudah ada untuk area itu tetap hijau.
- **Walk browser:** sebagai Admin, catat transaksi di Periode terkunci. Form menampilkan pesan Periode terkunci.

## Success criteria

- Tidak ada route di grup `(app)` yang mendefinisikan penerjemah galatnya sendiri, dan penjaga mencegahnya kembali.
- Galat domain baru dengan kategori yang dikenal tertangani di semua route tanpa menyunting route.
- Pesan di setiap form sama dengan sebelum run.
- Gate repo dan seluruh e2e hijau, dan walk browser lulus.

## Out of scope

- Teks pesan, hak, dan aturan domain.
- API Elysia di luar pemakaian tabel pemetaan yang sama.
- Route di grup `(public)` dan `(auth)`, kecuali yang memang sudah memakai salinan yang sama.

## Further notes

- Sumber: tinjauan arsitektur 2026-11-15, kandidat 06, dan keputusan grilling run `perdalam-v1` Q1 (seluruh kandidat dalam satu run).
- Spec ini menyentuh banyak route yang juga disunting spec lain. Urutan gelombangnya diatur di Stage 4 supaya migrasi tidak bertabrakan dengan perubahan route di spec lain.


## Catatan penyerahan (run perdalam-v1, 2026-11-16)

**1. Yang masuk.** Semua di `feat/perdalam-v1`, belum di `main` (PR run dibuka di tail, #334).

- #318 Modul aksi route: merge `d6ec16e` ke feat/perdalam-v1. `src/lib/server/route-action.ts`: `throwRouteError`, `failOrThrow`, `refusal`, `requireUser`, `requireUuidParam`, `productionDependencies`, `readText`, `readOptionalText`, `readRupiah`; `src/lib/errors.ts`: `NotFoundError`, `RuleViolationError`, `ERROR_CATEGORY`. Pilot `/admin/periods` dan `/admin/cash-categories`.
- #326 Migrasi 8 route Unit dan orang: merge `e53dd02` ke feat/perdalam-v1.
- #327 Migrasi 8 route konten dan sistem: merge `ced8776` ke feat/perdalam-v1.
- #332 Migrasi 11 route keuangan: merge `fe3bc28` ke feat/perdalam-v1.
- #333 Hapus penerjemah galat terakhir dan pasang penjaganya: merge `cac5bf0` ke feat/perdalam-v1. `tests/unit/no-route-error-translator.test.ts` dan aturan eslint `no-restricted-syntax` untuk `src/routes/**/*.ts`.

**2. Klaim spec yang dibalik atau digeser run ini.** Tidak ada yang dihapus dari badan spec di atas.

- "API Elysia ... memakai tabel pemetaan yang sama" (keputusan 4, "kalau memungkinkan"): tidak dilakukan. `api/app.ts` sengaja tetap memakai `onError`-nya sendiri dan tidak membaca `errorCategoryOf`; alasannya dicatat di doc `route-action.ts`: graf impor SvelteKit akan ikut masuk, dan jawaban API untuk pelanggaran aturan bergeser dari 500 ke 400 (#333).
- "Route di grup `(public)` dan `(auth)` di luar cakupan": `(auth)/invitations/[token]` ikut dimigrasi karena memakai salinan yang sama; route token itu tidak memakai `requireUser` (#326).
- "Galat yang tidak dikenal tetap diteruskan" dan "Galat domain baru ... tertangani tanpa menyunting route": berlaku untuk galat berkategori. Pelanggaran aturan berkategori yang tidak dinamai route kini dijawab `fail(400)` dengan kalimat formulir tidak valid milik layar itu, bukan 500 (#326, #327, #332). Tes penjaga mewajibkan setiap kelas galat service yang diekspor berkategori, kecuali `SystemCategoryMissingError`, `NoDuesRateError`, dan `CashCorrectionTargetError`, yang sengaja tidak berkategori (#318). `CashCorrectionTargetError` dinamai per `reason` lewat `refusal(...)` di `/admin/cash` (#323).
- "117 salinan pembacaan field form yang dipangkas" diganti `readText`: hanya di tempat bacaan lama memang dipangkas. Tetap ditulis tangan dan tidak dipangkas: `token`, `password`, `passwordAgain`, `fileName`, `content` (#326); isi balasan Keluhan, serta `type`, `category`, tanggal, dan jam Post, termasuk catch `RangeError` tanggal Post (#327). `readRupiah` menggantikan `readAmount` dan `parseRupiah`, menangkap hanya `TypeError` dan `RangeError` (#332).
- "sebuah penjaga (aturan lint atau tes) mencegah route mendefinisikan penerjemah galatnya sendiri": ada dua. Tes AST menolak definisi `throwAsRouteError`, `failAsRejectedForm`, `refusalOrThrow` dan `instanceof PermissionDeniedError` di `src/routes` (semua grup); aturan eslint menolak `failOrThrow` yang hasilnya dibuang, sebab wajib di-`return` (#318, #333). Penjaga tidak melarang setiap catch tulis tangan. Keduanya dibuktikan menyala lewat suntingan sementara.
- "Semua route di grup `(app)` dimigrasi": 2 pilot (#318), 8 (#326), 8 (#327), 11 (#332), 3 terakhir `/profile`, `/admin/import/template`, `/profile/notifications` (#333), ditambah `/admin/cash` (#323) dan layar Keuangan Unit (#329) lewat spec koreksi-kas. Survei #333 atas `src/routes`: tidak ada lagi definisi tiga nama penerjemah.
- Pesan: "Pesan di setiap form sama dengan sebelum run" bertahan, dengan pengecualian satu cabang: galat tidak dinamai yang dulu 500 kini 400 (di atas). Kalimat literal lama dipertahankan sebagai `() => '...'` (#333).

**3. Cacat dan tindak lanjut yang diajukan.**

- #340 (di luar run, terbuka): `rupiah-input.svelte` membuang koma desimal, `12,5` tercatat Rp 125; ditemukan walk #332, sudah ada sebelum run. Bukan cacat `readRupiah`.
- Kembalian #318: tes penjaga kategori merah terhadap kelas baru #322 karena branch dibuat sebelum #322 di-merge; ditutup dengan merge `feat/perdalam-v1` ke branch tiket dan verifikasi delta.
- Tidak ada yang diserahkan ke tail atau pemilik untuk spec ini. Impor `route-action.ts` tidak dipindah ke `dues-correction.ts`; path lama tetap sah (#333).

**4. Verifikasi.**

- #318 (`executor-fable-high`): batas otorisasi bertahan, kedua rute pilot identik perilakunya. Kembalian 1 menutup tiga temuan (blocker penjaga untuk kelas baru #322, `CashCorrectionTargetError` dijadikan tidak berkategori, peringatan dokumen untuk `{ error }` dan `failOrThrow` yang wajib di-`return`); verifikasi ulang delta menutup ketiganya.
