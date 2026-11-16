# Spec: indeks-koreksi v1 - Satu Koreksi per Transaksi Kas menjadi fakta basis data

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#343](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/343) |
| Run | `tambal-v1` |
| Peta eksekusi | [#345](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/345) |
| Tiket | [#339](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/339) |
| Disalin pada | 2026-11-16, dari `main` @ `79e7ce9` |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-16, aturan "sebuah Transaksi Kas dikoreksi paling banyak satu kali" hanya dipegang penulis buku kas. Penulis itu mengunci baris yang dikoreksi, lalu memeriksa apakah baris itu sudah punya Koreksi. Basis data tidak mengenal aturan itu, dan kolom yang menunjuk baris yang dikoreksi tidak punya index sama sekali. Akibatnya:

- Sejak #329, setiap bacaan Saldo Titipan mencari Koreksi Pengembalian tanpa index. Pemeriksaan "sudah dikoreksi" di penulis juga berjalan tanpa index.
- Jalur tulis baru yang lupa mengunci baris bisa menulis Koreksi kedua, dan tidak ada yang menolaknya. Penulis sendiri mencatat bahwa "satu Koreksi per baris" bukan fakta basis data.
- Admin yang mengoreksi baris yang sudah dikoreksi membaca saran "koreksilah baris koreksi itu". Sejak #323 saran itu keliru untuk Saldo awal, karena Koreksi atas Koreksi Saldo awal ditolak.
- Entri Koreksi di glossary tidak menyebut batas satu kali, padahal layar sudah menyatakannya.

## Solution

Basis data menolak Koreksi kedua untuk baris yang sama. Kalau penolakan itu sampai ke aplikasi, Admin dan superuser melihat pesan "sudah pernah dikoreksi" yang sudah ada, bukan halaman galat. Pesan untuk Admin tidak lagi memberi saran yang keliru. Pencarian Koreksi sebuah baris memakai index.

## Goals and non-goals

**Goals**

- Satu index unik parsial atas kolom penunjuk Koreksi, yang hanya berlaku untuk baris Koreksi, dibuat lewat satu migrasi aditif.
- Penulis buku kas menerjemahkan pelanggaran index itu menjadi galat domain "sudah pernah dikoreksi" yang sudah ada. Setiap layar yang sudah memetakan galat itu tetap menampilkan pesannya.
- Teks pesan Admin untuk baris yang sudah dikoreksi dibersihkan dari saran yang keliru.
- Entri Koreksi di glossary menyebut batasnya.
- Komentar kode yang menyatakan aturan ini "bukan fakta basis data" diperbarui.

**Non-goals**

- Kunci baris di penulis tetap menjadi mekanisme utama aturan ini. Index adalah jaring pengaman, dan tidak ada kunci yang dihapus.
- Cabang kode lama yang menoleransi lebih dari satu Koreksi per baris, untuk data dari sebelum penulis menolaknya, tidak dibersihkan.
- Perilaku Koreksi, Pembatalan verifikasi, dan Pembatalan Pengembalian tidak berubah.
- Catatan pemilik lain dari run perdalam-v1 (kosakata label status di layar Keuangan Unit dan komentar batas tipis dari #337) tidak dikerjakan di sini.

## User stories

1. Sebagai pemilik, saya ingin basis data sendiri menolak Koreksi kedua untuk satu Transaksi Kas, supaya aturan itu tetap benar walau kelak ada jalur tulis baru yang lupa mengunci baris.
2. Sebagai Admin yang mencoba mengoreksi baris yang sudah dikoreksi, saya ingin pesan yang menyatakan bahwa satu transaksi hanya bisa dikoreksi satu kali, tanpa saran yang tidak berlaku untuk baris itu.
3. Sebagai superuser yang membatalkan verifikasi Pembayaran atau membatalkan Pengembalian yang baris kasnya sudah dikoreksi, saya ingin pesan yang sama seperti sekarang, bukan halaman galat, juga ketika penolakannya datang dari basis data.
4. Sebagai Warga yang membuka Saldo Titipan rumahnya, saya ingin halamannya tetap cepat saat buku kas bertambah panjang.
5. Sebagai pembaca glossary, saya ingin entri Koreksi menyebut bahwa sebuah Transaksi Kas dikoreksi paling banyak satu kali.
6. Sebagai developer, saya ingin komentar di penulis buku kas dan di skema menyatakan bahwa aturan ini kini fakta basis data, supaya tidak ada yang menambah pemeriksaan ganda atau mengira aturannya longgar.

## Implementation decisions

- **Index unik parsial** atas kolom penunjuk Koreksi, hanya untuk baris yang penunjuknya terisi (Q6). Index ini juga melayani pencarian "Koreksi untuk baris X", jadi index biasa terpisah tidak diperlukan.
- **Satu migrasi aditif** dengan nomor berikutnya.
  - Produksi diperiksa baca-saja pada 2026-11-16, sebelum perencanaan: 1 Transaksi Kas, 0 Koreksi, dan tidak ada duplikat. Index akan terbentuk tanpa perbaikan data.
  - Pemeriksaan yang sama diulang sesudah deploy.
- **Penerjemahan pelanggaran index** (Q7). Pelanggaran unik PostgreSQL berkode 23505. Penulis buku kas mengenali pelanggaran index ini dari nama index-nya, bukan dari kodenya saja, lalu melemparkan galat domain "sudah pernah dikoreksi" yang sudah ada.
  - Transaksi PostgreSQL batal begitu pelanggaran terjadi. Eksekutor memilih cara yang tetap bisa menyebut Koreksi yang sudah ada, misalnya savepoint di sekitar insert lalu membaca Koreksi itu. Kalau galat dibuat tanpa menyebutnya, eksekutor menjelaskan alasannya.
  - Pelanggaran unik lain, misalnya kunci primer, tidak diterjemahkan.
- **Kunci baris tetap ada dan tetap terjadi lebih dulu.** Jalur normal tidak pernah mencapai index. Pelanggaran index hanya terjadi kalau ada penulis yang melewati kunci.
- **Pesan Admin** (Q11) menjadi "Transaksi itu sudah pernah dikoreksi, dan satu transaksi hanya bisa dikoreksi satu kali." Pesan diperbarui di kedua katalog bahasa, dengan kunci yang tetap simetris.
- **Glossary** (Q8, Q10): entri Koreksi mendapat kalimat "Sebuah Transaksi Kas dikoreksi paling banyak satu kali."

## Testing decisions

- **Seam 1:** tes skema buku kas yang sudah ada.
  - Insert Koreksi kedua langsung ke basis data untuk baris yang sama ditolak, dengan nama index yang diharapkan.
  - Baris yang bukan Koreksi (penunjuknya kosong) tidak dibatasi.
  - Daftar constraint dan index yang ditegaskan tes skema ikut diperbarui.
- **Seam 2:** tes Koreksi di penulis. Pelanggaran index sampai ke pemanggil sebagai galat "sudah pernah dikoreksi".
  - Jalur normal tidak bisa memicu pelanggaran, karena kunci baris menghalanginya. Eksekutor memilih cara memicunya dan menjelaskannya.
  - Lebih baik lewat penulis yang sebenarnya. Tes atas fungsi penerjemah saja diterima kalau jalur penulis tidak bisa dipicu secara deterministik.
- Tes yang sudah ada untuk "sudah pernah dikoreksi", termasuk tes kunci dengan koneksi kedua, tetap hijau tanpa diubah.
- Yang tidak tertangkap adalah migrasi di produksi. Itu dibuktikan oleh langkah `migrate` saat deploy dan pemeriksaan baca-saja sesudahnya.

## Success criteria

- Migrasi baru membuat index unik parsial dan berjalan bersih di basis data dev yang berisi Data Contoh.
- Insert Koreksi kedua untuk satu baris ditolak basis data.
- Pelanggaran itu sampai ke pemanggil sebagai galat "sudah pernah dikoreksi", tidak pernah sebagai 500.
- Mengoreksi baris yang sudah dikoreksi di layar buku kas menampilkan pesan Admin yang baru.
- Glossary memuat kalimat batasnya.
- Gerbang hijau.
- Sesudah deploy, index ada di produksi.

## Out of scope

- Pembersihan cabang lama yang menoleransi Koreksi ganda.
- Catatan pemilik lain dari run perdalam-v1.
- Index lain pada buku kas.

## Further notes

- Asal: #339, ditemukan verifikasi kedua #329 (Fable). Teks pesan lama tercatat sebagai catatan terbuka di #323.
- Diputuskan di grilling run `tambal-v1`, 2026-11-16 (Q6, Q7, Q8, Q10, Q11).

