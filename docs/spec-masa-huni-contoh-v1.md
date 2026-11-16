# Spec: masa-huni-contoh v1 - Masa Huni Data Contoh mulai tanggal 1 supaya Warga melihat Tagihan bulan berjalan

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#342](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/342) |
| Run | `tambal-v1` |
| Peta eksekusi | [#345](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/345) |
| Tiket | [#338](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/338) |
| Disalin pada | 2026-11-16, dari `main` @ `79e7ce9` |
| Lintasan penutup | 2026-11-16, sesudah Gelombang 2 (`feat/tambal-v1` @ `4b30173`): dibuat ulang dari item, yang kini memuat bagian "Catatan penyerahan" dengan klaim yang dibalik ditandai; tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-16, Data Contoh memulai setiap Masa Huni pada hari perintah semai dijalankan. Tagihan Data Contoh adalah Tagihan bulan berjalan, dan seorang Warga hanya melihat Tagihan yang hari pertama Periodenya jatuh di dalam Masa Huninya. Akibatnya, kalau semai dijalankan sesudah tanggal 1, tidak ada satu pun Warga Data Contoh yang melihat Tagihan rumahnya:

- "Tagihan saya" kosong, dengan total tunggakan Rp 0.
- Form Pembayaran Warga tidak menawarkan Tagihan apa pun.
- Beranda Warga tidak menunjukkan Tagihan rumahnya.

Teramati di walk Gelombang 3 run perdalam-v1 (#334), 2026-11-15: `warga01` (A-01) dan `warga11` (B-01) sama-sama melihat "Rumah Anda belum memiliki tagihan yang terlihat di sini." Untuk mengukur #328, walker harus mencatat Masa Huni tambahan bertanggal 1 dengan tangan. Walk dan demo layar Warga memakai data yang kosong. Produksi tidak terdampak.

## Solution

Pada hari apa pun semai dijalankan, setiap Warga Data Contoh punya Masa Huni yang mulai tanggal 1 bulan itu (WIB). Warga langsung melihat Tagihan bulan berjalan rumahnya di "Tagihan saya", di form Pembayaran, dan di Beranda, tanpa langkah tambahan.

## Goals and non-goals

**Goals**

- Masa Huni Data Contoh mulai pada hari pertama bulan semai, menurut kalender WIB.
- Warga Data Contoh melihat Tagihan bulan berjalan rumahnya, apa pun tanggal semainya.

**Non-goals**

- Data Contoh tetap satu bulan kalender, sesuai glossary. Masa Huni tidak mulai pada bulan sebelumnya, dan tidak ada Tagihan bulan sebelumnya (keputusan Q1).
- Persetujuan Pendaftaran tetap memulai Masa Huni pada hari persetujuan. Layanan Pendaftaran dan modul Masa Huni tidak berubah (keputusan Q2).
- Tanggal Pembayaran, Transaksi Kas, saldo awal, dan Post Data Contoh tidak berubah: tetap di bulan berjalan dan tidak sesudah hari ini.
- Aturan Tagihan mana yang terlihat oleh Warga tidak berubah.

## User stories

1. Sebagai developer yang menyemai Data Contoh pada tanggal 16, saya ingin `warga01` langsung melihat Tagihan bulan ini di "Tagihan saya", supaya walk layar Warga tidak memakai data kosong.
2. Sebagai walker, saya ingin form Pembayaran Warga menawarkan Tagihan rumahnya sesudah semai, supaya alur Pembayaran bisa dicoba tanpa mencatat Masa Huni tambahan.
3. Sebagai walker, saya ingin Beranda Warga menampilkan Tagihan rumahnya sesudah semai, supaya ringkasan Warga bisa diperiksa dengan data yang terisi.
4. Sebagai developer yang menyemai pada tanggal 1, saya ingin hasil yang sama seperti sekarang, supaya perbaikan ini tidak bergantung pada tanggal.
5. Sebagai Superuser yang membuka daftar Penghuni sebuah Unit Data Contoh, saya ingin melihat Masa Huni yang mulai tanggal 1 bulan ini, supaya tanggalnya cocok dengan Tagihan yang terlihat Warga.
6. Sebagai pemilik, saya ingin persetujuan Pendaftaran di produksi tetap memulai Masa Huni pada hari persetujuan, supaya perbaikan Data Contoh tidak mengubah perilaku produksi.
7. Sebagai developer, saya ingin semua tanggal uang Data Contoh tetap di bulan berjalan dan tidak sesudah hari ini, supaya buku kas dan Pembayaran Data Contoh tetap masuk akal.

## Implementation decisions

- **Hanya perintah Data Contoh yang berubah** (Q2). Warga tetap lahir dari alur Pendaftaran seperti sekarang. `approveRegistration` dan modul Masa Huni tidak disentuh.
- **Mekanismenya dipilih eksekutor**, dari dua jalan yang per 2026-11-16 sudah didukung kode:
  - Langkah pendaftaran memakai clock tersendiri yang dibekukan pada tanggal 1 bulan semai, WIB. Perintah semai sudah menerima `Clock` yang disuntikkan. Konsekuensinya, Pendaftaran dan baris Audit Log langkah itu bisa bertanggal 1, dan itu diterima.
  - Atau Masa Huni ditulis lebih dulu dengan tanggal mulai eksplisit. Penulisan Masa Huni oleh persetujuan melewati Masa Huni yang tumpang tindih tanpa galat.
- **Clock nyata tetap menentukan** bulan semai dan batas "tidak sesudah hari ini" untuk setiap tanggal uang. Hari pertama bulan dihitung lewat modul waktu dengan kalender WIB, bukan jam mesin, karena jam mesin ini UTC+8.
- Penanggung Jawab tetap dipasang seperti sekarang.

## Testing decisions

- **Seam:** tes perintah Data Contoh yang sudah ada, yang clock-nya dipatok tanggal 20. Tambahkan dua penegasan: setiap Masa Huni Data Contoh mulai tanggal 1 bulan itu, dan seorang Warga Data Contoh melihat Tagihan rumahnya lewat bacaan "Tagihan saya" yang sama dengan yang dipakai layar. Tes yang baik membaca lewat layanan, bukan lewat SQL ke kolom tanggal saja.
  - Menangkap: tanggal mulai yang salah, dan Warga yang tidak melihat Tagihan rumahnya.
  - Tidak menangkap: layar itu sendiri. Itu ditutup walk.
- **Walk** oleh orchestrator lewat Playwright MCP, sesudah semai ulang pada tanggal yang bukan 1.
- **Prior art:** tes Data Contoh yang memakai `FakeClock`.

## Success criteria

- Sesudah semai pada tanggal yang bukan 1, `warga01` melihat Tagihan bulan berjalan A-01 di "Tagihan saya", dan form Pembayaran menawarkan Tagihan itu.
- Daftar Penghuni Unit A-01 menunjukkan Masa Huni yang mulai tanggal 1 bulan berjalan.
- Tes Data Contoh menegaskan tanggal mulai dan Tagihan yang terlihat, dan hijau dengan clock tanggal 20.
- Layanan Pendaftaran dan Masa Huni tidak berubah.
- Gerbang hijau.

## Out of scope

- Tagihan dari bulan sebelum semai, atau perluasan Data Contoh menjadi lebih dari satu bulan.
- Perubahan aturan Tagihan mana yang terlihat oleh Warga.
- Perubahan Pendaftaran di produksi.

## Further notes

- Asal: #338. Diputuskan di grilling run `tambal-v1`, 2026-11-16 (Q1, Q2).
- Perintah semai hanya dijalankan orchestrator. Executor tidak pernah menyemai basis data dev.



## Catatan penyerahan (run tambal-v1, 2026-11-16)

**1. Yang masuk.** Semuanya di `feat/tambal-v1`. Isinya masuk `main` lewat PR run yang dibuka di tail peta #345.

- **#338**, merge `a2426d8` (commit tiket `e032516`). `scripts/seed-dev.ts` menjalankan kedua langkah Pendaftaran dengan `registrationClock(clock)`, yaitu clock yang dibekukan pada awal tanggal 1 bulan semai, WIB.
  - Instan itu dibangun dari `Date.UTC` dikurangi offset WIB, lalu diperiksa lewat `civilDayOf`.
  - Semua langkah lain tetap memakai clock nyata.
  - `README.md` menyebut bahwa setiap Masa Huni mulai tanggal 1.
  - Tes baru di `tests/unit/seed-dev.test.ts` memakai clock tanggal 20. Isinya: tanggal mulai, Tagihan `warga01` lewat `invoicesForUser`, dan tanggal uang di dalam bulan.

**2. Klaim spec yang dibalik atau digeser run ini.** Tidak ada yang dihapus dari badan spec di atas.

- **Dibalik.** Keputusan implementasi "Atau Masa Huni ditulis lebih dulu dengan tanggal mulai eksplisit", yang disebut sudah didukung kode, ternyata tidak bisa dipakai. `recordOccupancy` butuh `residentId`, sedangkan baris `residents` baru lahir di dalam `approveRegistration`. Yang dipakai adalah clock yang dibekukan (#338).
- **Digeser.** Kriteria sukses "`warga01` ... dan form Pembayaran menawarkan Tagihan itu", juga cerita pengguna 2.
  - Tagihan A-01 sudah Lunas di Data Contoh: tiga Pembayaran terverifikasi berjumlah Rp 200.000. Akibatnya, form `warga01` dengan benar menulis "Tidak ada tagihan yang belum lunas untuk rumah ini."
  - Bagian form Pembayaran diukur dengan `warga11` (B-01, terbayar 90.000 dari 150.000). Form menawarkan "2026-11 · sisa Rp 60.000 dari Rp 150.000".
  - Bagian "Tagihan saya" `warga01` tetap berlaku seperti tertulis. Tiket #338 dikoreksi dengan cara yang sama.
- **Ditambahkan, bukan dibalik.** Konsekuensi "Pendaftaran dan baris Audit Log langkah itu bisa bertanggal 1" juga berlaku untuk baris `residents` dan antrean email Data Contoh. Akun `user` tetap bertanggal hari semai.

**3. Cacat dan tindak lanjut yang diajukan.** Tidak ada. Tidak ada yang diserahkan ke pemilik untuk spec ini.

**4. Verifikasi.**

- **Gerbang penuh** di `a2426d8`, mulai 09:52:36 WIB: `check` 0 galat, `lint`, `test` 2750/2750, `build`. E2e 48/48.
- **Walk** lewat Playwright MCP, sesudah semai 2026-11-16. Error konsol 0 di setiap halaman.
  - `warga01`: `/invoices` menampilkan "Tagihan 2026-11 / Lunas / Rp 150.000".
  - `warga11`: `/payments/new` menawarkan Tagihan 2026-11.
  - Superuser: Penghuni A-01 menampilkan "Budi Santoso / Pemilik / Sejak 2026-11-01 / Penanggung jawab".

