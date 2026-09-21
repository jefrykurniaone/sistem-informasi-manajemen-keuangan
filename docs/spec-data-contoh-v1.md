# Spec: data-contoh - Perintah Data Contoh satu bulan

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#130](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/130) |
| Run | `poles-v1` |
| Peta eksekusi | [#146](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/146) |
| Riset pendukung | [docs/research-ui-ux-v1.md](./research-ui-ux-v1.md) |
| Disalin pada | 2026-09-20 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Basis data pengembangan berisi sisa percobaan dari dua puluh dua gelombang: unit setengah terisi,
pembayaran tanpa tagihan, dan akun yang kata sandinya tidak diingat siapa pun. Menunjukkan aplikasi
kepada calon pengurus berarti menyiapkan data lagi dengan tangan, dan setiap percobaan fitur baru
dimulai dari keadaan yang tidak bisa diulang. Tidak ada satu perintah untuk kembali ke keadaan yang
dikenal.

## Solution

Satu perintah membuat Data Contoh untuk bulan berjalan: seluruh isi basis data dihapus, lalu diisi
satu komplek kecil yang hidup: dua puluh Unit, dua puluh lima Warga dengan Masa Huni, akun
pengurus dan admin, Tarif yang berlaku, Tagihan bulan ini dalam campuran lunas, sebagian, dan
menunggak, Pembayaran dalam tiga status, Kategori Kas dengan Transaksi Kas masuk dan keluar,
beberapa Post, dan Keluhan dalam berbagai status beserta Tanggapannya. Semua akun bisa dipakai
masuk dengan satu kata sandi yang tercetak di dokumentasi. Perintah itu menolak berjalan di luar
basis data lokal.

> [!note] Dibalik oleh run `poles-v1`
> "Seluruh isi basis data dihapus" tidak berlaku bulat-bulat: dua baris `cash_categories` yang
> membawa `system_key` (disemai migrasi `drizzle/0009_cash_report.sql`) tidak ikut di-`TRUNCATE`,
> karena `createCashCategory` tidak pernah menulis `system_key` dan tanpa kedua baris itu
> `recordOpeningBalance` serta setiap verifikasi Pembayaran melempar `SystemCategoryMissingError`.
> Reset menjalankan `delete from cash_categories where system_key is null` di transaksi yang sama;
> `PRESERVED_TABLES` di `scripts/seed-dev.ts` mendaftarkan `cash_categories` dan `scaffold_probe`
> (#144, PR #165).

## Goals and non-goals

**Goals**

- Satu perintah, hasil yang sama setiap kali, dari keadaan apa pun.
- Setiap layar aplikasi punya sesuatu untuk ditampilkan setelah perintah dijalankan, termasuk
  Beranda kedua peran.
- Data mematuhi aturan domain: Tagihan dari Tarif yang berlaku, Alokasi tidak melebihi Pembayaran,
  Saldo Titipan positif hanya dari Pembayaran terverifikasi, Transaksi Kas kategori iuran hanya
  dari verifikasi Pembayaran.
- Tidak mungkin dijalankan pada basis data produksi tanpa sengaja.

**Non-goals**

- Tidak ada data lebih dari satu bulan; tidak ada Periode terkunci atau Laporan Bulanan lama.
- Tidak ada Data Contoh untuk pengujian otomatis; tes tetap membuat datanya sendiri.
- Tidak ada pemuatan dari berkas eksternal; isinya tertanam di perintah.

## User stories

1. Sebagai pengembang, saya ingin menjalankan satu perintah dan mendapat basis data yang berisi
   satu komplek lengkap untuk bulan berjalan.
2. Sebagai pengembang, saya ingin perintah itu menghapus semua yang ada, termasuk akun, supaya
   hasilnya tidak bergantung pada apa yang tersisa.
3. Sebagai pengembang, saya ingin masuk sebagai superuser, admin, atau salah satu warga dengan
   kata sandi yang sama dan tercatat.
4. Sebagai pengembang, saya ingin perintah menolak berjalan bila basis data bukan lokal atau
   lingkungan produksi, dan meminta bendera `--yes` sebelum menghapus.
5. Sebagai pengurus yang mencoba aplikasi, saya ingin melihat Tagihan yang lunas, sebagian lunas,
   dan menunggak, supaya layar Menunggak dan Beranda tidak kosong.
6. Sebagai pengurus yang mencoba, saya ingin ada Pembayaran yang menunggu verifikasi dengan bukti
   gambar, supaya saya bisa mencoba memverifikasi dan menolak.
7. Sebagai pengurus yang mencoba, saya ingin buku kas berisi pemasukan iuran dari verifikasi dan
   pengeluaran seperti kebersihan dan keamanan, dengan saldo awal, supaya saldo berjalan masuk akal.
8. Sebagai pengurus yang mencoba, saya ingin beberapa Post terbit dan satu draf, bertipe kegiatan
   dan pengumuman, dengan Sampul pada sebagian.
9. Sebagai pengurus yang mencoba, saya ingin Keluhan dalam setiap status dengan Tanggapan dan
   Riwayat Status, sebagian umum dan sebagian pribadi.
10. Sebagai warga yang mencoba, saya ingin salah satu akun warga punya Saldo Titipan, satu
    menunggak, dan satu lunas, supaya ketiga keadaan Beranda terlihat.
11. Sebagai pengembang, saya ingin job terjadwal tidak tiba-tiba menerbitkan Tagihan ganda setelah
    Data Contoh dibuat.

## Implementation decisions

**Perintah adalah skrip di direktori skrip, dijalankan lewat `bun run db:seed-dev -- --yes`.**
Mengikuti pola perintah pemberian superuser yang ada: skrip mandiri, memakai lapisan service, bukan
menulis SQL langsung ke tabel, supaya aturan domain ditegakkan oleh kode yang sama yang dipakai
aplikasi. Alasannya: Data Contoh yang dibuat lewat SQL langsung melewati invarian uang dan sudah
terbukti memicu job penerbitan Tagihan liar (gotcha wave 17).

**Pengaman tiga lapis.** Menolak bila `NODE_ENV` adalah `production`; menolak bila host
`DATABASE_URL` bukan `localhost`, `127.0.0.1`, atau `db`; menolak tanpa bendera `--yes`. Pesan
penolakan menyebut alasan.

**Penghapusan memakai urutan kunci asing yang ada,** dari tabel anak ke induk, dalam satu
transaksi, termasuk tabel akun better-auth, riwayat job, antrean email, dan ember pembatas laju.
Riwayat job dihapus dengan sengaja: baris `job_runs` adalah kunci klaim job, dan Data Contoh yang
menyisakan klaim bulan ini membuat job penerbitan menolak berjalan, sementara yang menghapusnya
tanpa menerbitkan Tagihan membuat job menerbitkan ulang. Karena itu skrip menerbitkan Tagihan bulan
ini lewat service penerbitan yang sama dengan job, sehingga klaim bulan ini tercatat dan job tidak
mengulang.

**Akun dibuat lewat better-auth,** bukan disisipkan langsung, supaya kata sandi ter-hash dengan
cara yang sama dan masuk benar-benar bekerja. Email ditandai terverifikasi dan Pendaftaran disetujui
oleh skrip. Akun: `superuser@komplek.local` (superuser, juga admin), `admin@komplek.local` (admin),
`warga01@komplek.local` sampai `warga25@komplek.local`. Kata sandi semua akun `kata-sandi-dummy-123`,
dicetak di README bagian pengembangan lokal.

**Isi yang deterministik.** Tidak ada pengacakan; nama, blok, nominal, dan tanggal tertanam sebagai
tabel di skrip supaya dua orang yang menjalankannya mendapat basis data yang sama dan dokumentasi
bisa menyebut "Unit A-03 menunggak". Tanggal relatif terhadap bulan berjalan WIB dari modul waktu
spec `waktu-rupiah`: skrip yang dijalankan bulan depan menghasilkan bulan depan.

**Skala.** 20 Unit di blok A dan B; 25 Warga (lima Unit punya dua penghuni); 1 Tarif aktif
`150000`; 20 Tagihan bulan ini: 10 lunas, 4 sebagian, 6 belum bayar yang 3 di antaranya
menunggak; sekitar 30 Pembayaran (transfer dan tunai; terverifikasi, menunggu, ditolak) dengan bukti
gambar kecil yang disimpan lewat `FileStore`; 1 Saldo Awal, 6 Kategori Kas, sekitar 40 Transaksi
Kas termasuk satu Koreksi; 6 Post (4 terbit, 1 draf, 1 arsip; separuh kegiatan) dengan 2 Sampul;
10 Keluhan yang mencakup setiap status, dengan Tanggapan dan satu Lampiran.

> [!note] Dibalik oleh run `poles-v1`
> Pecahan Tagihan yang mendarat (#144, PR #165): 13 lunas (bukan 10 — sepuluh Unit A ditambah tiga
> Unit B yang lunas setelah pembayaran pertamanya ditolak), 4 sebagian (`SEED_PAYMENTS` di
> `scripts/seed-data.ts`, masing-masing berutang 60.000 menunggu verifikasi Pembayaran), 3 belum
> bayar sama sekali. Karena setiap Tagihan jatuh tempo tanggal 5, `invoiceStatus` menandai ketujuh
> Unit yang masih berutang sebagai `overdue` begitu tanggal itu lewat, bukan hanya tiga —
> `/admin/overdue` memuat tujuh baris (`OVERDUE_UNIT_LABELS`), tidak pernah tiga. "Sekitar 30
> Pembayaran" mendarat tepat 30 (22 terverifikasi, 5 menunggu, 3 ditolak). "Sekitar 40 Transaksi
> Kas" mendarat 51: 26 pengeluaran (`SEED_CASH_EXPENSES` — satu di antaranya dikoreksi tapi tetap
> tercatat, buku kas itu append-only) + 1 Koreksi + 1 Saldo Awal + 23 baris pemasukan iuran dari
> verifikasi Pembayaran, dengan saldo kas penutup Rp 5.000.000.

**Skrip berjalan di luar Vite,** jadi ia memakai penyelesaian alias yang sama dengan skrip
superuser (gotcha wave 17 tentang `$app/server`); bila skrip superuser memakai shim, skrip ini
memakainya juga, dan cara menjalankannya didokumentasikan sekali di README.

> [!note] Dibalik oleh run `poles-v1`
> `scripts/grant-superuser.ts` **tidak** butuh shim — doc comment-nya sengaja melarang skrip itu
> mengimpor `auth.ts`. `scripts/seed-dev.ts` butuh shim untuk alasan sendiri: ia mengimpor
> `src/lib/server/auth.ts` (untuk `signUpEmail`, supaya kata sandi ter-hash sama seperti
> pendaftaran sungguhan) yang mengimpor modul maya `$app/server` di baris pertama. Perintahnya
> `bun --tsconfig-override scripts/tsconfig.seed.json scripts/seed-dev.ts`, dengan
> `scripts/app-server-shim.ts` dan `scripts/tsconfig.seed.json` disimpan di `scripts/`, bukan
> `.claude/scratch/` (#144, PR #165).

## Testing decisions

- **Skrip diuji terhadap basis data uji** dengan pola satu schema per berkas tes: setelah
  dijalankan, jumlah baris per tabel sesuai skala; setiap invarian uang yang sudah diuji di tempat
  lain dipenuhi (Alokasi tidak melebihi Pembayaran, Saldo Titipan hanya dari terverifikasi);
  menjalankannya dua kali menghasilkan jumlah yang sama.
- **Pengaman** diuji sebagai tabel kasus: `NODE_ENV=production`, host jauh, dan tanpa `--yes`
  masing-masing menolak dengan pesan tanpa menyentuh basis data.
- **Masuk dengan akun Data Contoh** adalah kriteria walk Playwright MCP orchestrator setelah
  skrip dijalankan pada basis data pengembangan, bersama pemeriksaan Beranda kedua peran.
- Prior art: `tests/unit/bootstrap-superuser.test.ts`, `tests/unit/db-harness.test.ts`,
  `tests/unit/unit-money-invariant.test.ts`.

## Success criteria

- `bun run db:seed-dev -- --yes` pada basis data lokal selesai tanpa galat dan mencetak ringkasan
  jumlah per entitas.
- Tanpa `--yes`, atau dengan `NODE_ENV=production`, perintah keluar dengan kode 1 dan pesan.
- Masuk sebagai `superuser@komplek.local` dan `warga01@komplek.local` berhasil.
- Beranda admin dan warga, layar Menunggak, Verifikasi Pembayaran, Buku Kas, Kelola Post, dan Semua
  Keluhan menampilkan data.
- Job penerbitan Tagihan tidak menerbitkan Tagihan kedua untuk bulan ini setelah skrip.
- Empat perintah gerbang lulus.

## Out of scope

- Data bulan lalu, Periode terkunci, Laporan Bulanan.
- Data untuk lingkungan staging atau produksi.
- Perintah "hapus saja" tanpa mengisi.

## Further notes

Spec ini mendarat terakhir: Beranda (spec `shell-beranda`) dan Post ber-HTML (spec `post-editor`)
harus ada supaya Data Contoh mengisi bentuk data yang baru, dan modul waktu (spec `waktu-rupiah`)
memberi bulan WIB. Tiketnya menyentuh `package.json` untuk skrip baru, jadi run-exclusive.
