# Spec: keluhan - laporan warga dan siklus penanganannya

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#6](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/6) |
| Run | `komplek-v1` |
| Peta eksekusi | [#47](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/47) |
| Disalin pada | 2026-09-16 |
| Lintasan penutup | 2026-09-20 — klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Keluhan warga — lampu jalan mati, saluran air tersumbat, pagar rusak, satpam tidak ada di pos —
saat ini disampaikan lewat pesan pribadi ke ketua RT atau dilempar ke grup WhatsApp. Yang terjadi
setelahnya tidak terlihat: warga tidak tahu apakah keluhannya dibaca, pengurus tidak punya daftar
apa saja yang masih menggantung, dan keluhan yang terlewat baru muncul lagi sebagai kemarahan di
rapat warga.

## Solution

Warga melaporkan keluhan lewat aplikasi, dengan kategori dan foto kalau ada. Keluhan itu punya
status yang bergerak dari baru sampai selesai, dan setiap perubahan status memberi tahu pelapornya
lewat email. Pengurus punya satu daftar berisi semua yang belum selesai, dengan umur keluhan
terlihat, sehingga yang mandek tidak bisa bersembunyi.

Keluhan bersifat pribadi secara bawaan — hanya pelapor dan pengurus yang melihatnya — dengan pilihan
menjadikannya terlihat semua warga saat melapor.

## Goals and non-goals

**Goals**

- Setiap keluhan punya pemilik, status, dan riwayat yang bisa dibaca kemudian.
- Warga tahu keluhannya dibaca, tanpa harus bertanya.
- Pengurus punya satu daftar kerja yang menunjukkan mana yang mandek.
- Penolakan selalu punya alasan yang sampai ke pelapor.
- Privasi bawaan yang aman, dengan pilihan sadar untuk membukanya.

**Non-goals**

- Tidak ada keluhan anonim.
- Tidak ada target waktu penyelesaian yang mengikat.
- Tidak ada penugasan ke pengurus tertentu.

## User stories

1. Sebagai warga, saya ingin melaporkan keluhan dengan judul, kategori, dan uraian.
2. Sebagai warga, saya ingin melampirkan sampai tiga foto, supaya pengurus melihat masalahnya tanpa
   saya jelaskan panjang.
3. Sebagai warga, saya ingin memilih apakah keluhan saya terlihat semua warga atau hanya pengurus,
   saat melapor.
4. Sebagai warga, saya ingin melihat daftar keluhan saya sendiri beserta statusnya.
5. Sebagai warga, saya ingin menerima email saat status keluhan saya berubah.
6. Sebagai warga, saya ingin menambahkan tanggapan pada keluhan saya, misalnya menambahkan
   informasi yang terlewat.
7. Sebagai warga, saya ingin membaca tanggapan pengurus pada keluhan saya.
8. Sebagai warga, saya ingin melihat keluhan warga lain yang ditandai terlihat umum, supaya saya
   tidak melaporkan hal yang sama dua kali.
9. Sebagai warga, saya tidak ingin keluhan pribadi saya terlihat tetangga.
10. Sebagai warga, saya ingin menarik kembali keluhan saya selama belum ditangani.
11. Sebagai admin, saya ingin menerima email saat ada keluhan baru masuk.
12. Sebagai admin, saya ingin melihat daftar keluhan yang belum selesai, terurut dari yang paling
    lama menunggu.
13. Sebagai admin, saya ingin melihat umur setiap keluhan, supaya yang tertinggal tujuh hari
    terlihat jelas.
14. Sebagai admin, saya ingin menyaring keluhan menurut status dan kategori.
15. Sebagai admin, saya ingin mengubah status keluhan menjadi ditinjau, dikerjakan, lalu selesai.
16. Sebagai admin, saya ingin menolak keluhan dengan alasan wajib, supaya pelapor tidak ditinggalkan
    tanpa penjelasan.
17. Sebagai admin, saya ingin menambahkan tanggapan yang dibaca pelapor.
18. Sebagai admin, saya ingin sistem menolak perpindahan status yang tidak masuk akal, misalnya dari
    selesai kembali ke baru.
19. Sebagai superuser, saya ingin melihat siapa mengubah status apa dan kapan.
20. Sebagai admin, saya ingin melihat berapa keluhan masuk dan selesai bulan ini, supaya ada yang
    bisa dilaporkan di rapat warga.

## Implementation decisions

**Status sebagai mesin keadaan, bukan kolom bebas.** Status yang sah: `baru`, `ditinjau`,
`dikerjakan`, `selesai`, `ditolak`, dan `ditarik`. Perpindahan yang diizinkan ditetapkan secara
eksplisit di lapisan service; perpindahan lain ditolak. `ditolak` mensyaratkan alasan, dan
penolakan tanpa alasan gagal di lapisan service, bukan hanya di formulir. `ditarik` hanya bisa
dilakukan pelapor dan hanya selama status masih `baru`. Alasannya: kolom status bebas akan menerima
nilai apa pun yang diketik layar mana pun, dan aturan "penolakan harus beralasan" yang hanya hidup
di formulir akan hilang begitu ada jalan kedua menuju data yang sama.

> [!note] Dibalik oleh run `komplek-v1`
> Keenam nilainya tersimpan berbahasa Inggris — `new`, `reviewing`, `working`, `resolved`,
> `rejected`, `withdrawn` — ditetapkan koreksi glosarium pada #42 (`66e8307`,
> `src/lib/server/db/schema/complaint.ts`). Mesin keadaannya mendarat apa adanya di
> `src/lib/server/services/complaint/state-machine.ts` (#43, `f3e598b`), dengan 29 dari 36 pasangan
> berurutan ditolak dan setiap tepi membawa pelakunya (`handler` atau `reporter`); satu tepi yang
> mungkin diharapkan pembaca **sengaja tidak ada**, yaitu `reviewing -> resolved`.

**Riwayat status disimpan, bukan hanya status terakhir.** Setiap perpindahan menghasilkan satu baris
berisi status lama, status baru, pelaku, waktu, dan catatan. Alasannya: pertanyaan yang benar-benar
ditanyakan di rapat warga adalah "berapa lama ini menggantung", dan itu tidak bisa dijawab oleh
kolom status terakhir.

**Visibilitas ditetapkan saat melapor dan dipaksakan di lapisan service.** Sebuah keluhan `pribadi`
hanya bisa dibaca pelapornya dan pemegang peran admin atau superuser; sebuah keluhan `umum` bisa
dibaca setiap warga yang sudah masuk, tetapi tidak pernah publik tanpa akun. Penyaringan itu ada di
satu fungsi yang dipakai semua jalur baca. Pelapor boleh menurunkan keluhannya dari `umum` menjadi
`pribadi`, tetapi tidak sebaliknya — sesuatu yang sudah terlihat tetangga tidak bisa ditarik kembali
dengan mengubah satu kolom, dan berpura-pura bisa akan menyesatkan.

> [!note] Dibalik oleh run `komplek-v1`
> Kedua nilainya tersimpan berbahasa Inggris, `private` dan `public` (#42, `66e8307`,
> `src/lib/server/db/schema/complaint.ts`). Aturan satu arahnya mendarat apa adanya sebagai
> `visibilityOnlyLowers` di `src/lib/server/services/complaint/index.ts`, dijaga kepemilikan baris
> dan bukan aksi izin, dengan baris audit `complaint_visibility_changed`; penyaringan bacanya ada di
> `visibility.ts` dan lingkup kosong menjadi `` sql`false` ``, bukan `where` yang hilang (#43,
> `f3e598b`).

**Tidak ada keluhan anonim.** Keluhan anonim tidak bisa ditindaklanjuti karena pengurus tidak bisa
bertanya balik, dan mengundang penyalahgunaan di komunitas sekecil ini. Privasi sudah dijaga oleh
visibilitas bawaan `pribadi`.

**Tanggapan adalah rangkaian pesan sederhana.** Satu tabel tanggapan milik keluhan, berisi penulis,
isi, dan waktu. Tidak ada balasan bersarang dan tidak ada penyuntingan. Tanggapan pada keluhan
`pribadi` mengikuti visibilitas keluhannya.

**Umur keluhan dihitung, bukan disimpan.** Selisih antara waktu sekarang menurut port `Clock` dan
waktu perpindahan status terakhir. Daftar admin menyorot yang melewati ambang yang ditetapkan
sebagai tetapan, bukan kebijakan yang bisa diatur — belum ada yang meminta itu bisa diatur.

**Lampiran lewat port penyimpanan.** Maksimal tiga berkas gambar, dibuka lewat tautan bertanda
tangan berumur pendek, karena foto keluhan sering memuat rumah tetangga dan pelat nomor kendaraan.

**Email.** Dua jenis: keluhan baru kepada seluruh pemegang peran admin, dan perubahan status kepada
pelapor. Keduanya lewat antrean email spec fondasi. Email perubahan status kepada pelapor tidak bisa
dimatikan, karena ia adalah jawaban atas sesuatu yang diminta warga itu sendiri; email keluhan baru
kepada admin bisa diatur per admin.

> [!note] Dibalik oleh run `komplek-v1`
> `new-complaint` mendarat sebagai jenis **memilih-masuk yang mati secara bawaan**
> (`src/lib/server/services/subscription/kinds.ts`), jadi ia tidak sampai ke "seluruh pemegang peran
> admin": penerimanya hanya warga berlangganan yang akunnya memegang `admin`, dan seorang admin tidak
> menerima apa pun sampai ia menyalakannya sendiri. Perubahan status juga tidak selalu mengirim —
> `withdrawComplaint` sengaja tidak memicu, jadi pelapor tidak dikirimi email atas penarikannya
> sendiri — dan uraian keluhan tidak pernah masuk email. #46 (`66b3b38`),
> `src/lib/server/services/complaint/notification.ts`.

**Audit.** Setiap perubahan status dan setiap perubahan visibilitas masuk audit log spec fondasi,
selain masuk riwayat status keluhan itu sendiri.

## Testing decisions

- **Mesin keadaan** diuji sebagai tabel kasus lengkap: untuk setiap pasangan status asal dan tujuan,
  diizinkan atau ditolak. Ini satu pengujian berparameter.
- **Alasan wajib** diuji langsung di lapisan service: menolak keluhan tanpa alasan gagal meski
  dipanggil di luar formulir.
- **Penarikan oleh pelapor** diuji: berhasil saat masih `baru`, ditolak setelah `ditinjau`, dan
  ditolak kalau pemanggilnya bukan pelapor.
- **Visibilitas** diuji sebagai tabel kasus antara peran pembaca, pemilik keluhan, dan visibilitas
  keluhan, untuk daftar maupun pembacaan satu keluhan dengan pengenal yang ditebak. Termasuk kasus
  bahwa keluhan `umum` tetap tidak terbaca tanpa masuk.
- **Perpindahan visibilitas satu arah** diuji: `umum` menjadi `pribadi` berhasil, sebaliknya
  ditolak.
- **Umur keluhan** diuji dengan jam palsu yang dimajukan tujuh hari, membuktikan keluhan yang mandek
  muncul sebagai tersorot di daftar admin.
- **Email** diuji: keluhan baru mengantre satu email per admin, perubahan status mengantre satu
  email ke pelapor, dan admin yang mematikan preferensinya tidak menerima apa pun.
- Playwright dipakai untuk satu alur: warga melapor dengan satu foto, admin memindahkan statusnya
  sampai selesai, warga melihat statusnya berubah.

## Success criteria

- Warga dapat melaporkan keluhan dengan kategori dan sampai tiga foto, dan melihatnya di daftar
  keluhannya.
- Keluhan bawaan bersifat pribadi; warga lain tidak dapat membukanya meski alamatnya ditebak.
- Keluhan yang ditandai umum terlihat warga lain yang sudah masuk, dan tidak terlihat tanpa masuk.
- Admin menerima email saat keluhan baru masuk; pelapor menerima email setiap kali statusnya
  berubah.
- Perpindahan status yang tidak sah ditolak, termasuk saat dipanggil di luar antarmuka.
- Menolak keluhan tanpa alasan gagal.
- Daftar admin terurut dari yang paling lama menunggu dan menyorot keluhan yang menggantung lebih
  dari tujuh hari.
- Riwayat sebuah keluhan menampilkan setiap perpindahan status beserta pelaku dan waktunya.
- Halaman terbaca dan bisa dipakai pada lebar 390 piksel, termasuk unggah foto dari kamera ponsel.

## Out of scope

Keluhan anonim, penugasan ke pengurus tertentu, target waktu penyelesaian yang mengikat, eskalasi
otomatis, penilaian kepuasan setelah selesai, penggabungan keluhan kembar, lampiran video,
notifikasi push, dan integrasi WhatsApp.

## Further notes

Diblokir oleh spec fondasi saja. Tidak menyentuh uang dan tidak menyentuh unit, jadi bisa dijalankan
bersamaan dengan spec lain. Kalau nanti keluhan perlu dikaitkan ke rumah pelapor untuk pemetaan,
itu penambahan yang berdiri sendiri dan bukan bagian run ini.
