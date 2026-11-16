# Spec: kolom-rupiah v1 - Kolom rupiah menolak masukan yang bukan rupiah utuh, tidak mengubahnya diam-diam

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#344](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/344) |
| Run | `tambal-v1` |
| Peta eksekusi | [#345](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/345) |
| Tiket | [#340](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/340) |
| Disalin pada | 2026-11-16, dari `main` @ `79e7ce9` |
| Lintasan penutup | 2026-11-16, sesudah Gelombang 2 (`feat/tambal-v1` @ `4b30173`): dibuat ulang dari item, yang kini memuat bagian "Catatan penyerahan" dengan klaim yang dibalik ditandai; tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-16, kolom nominal rupiah membuang setiap karakter yang bukan angka saat diketik atau ditempel. Kolom yang sama dipakai enam formulir: Transaksi Kas baru, Tarif, Pengembalian, Pembayaran Warga, saldo awal, dan Pembayaran tunai Admin. Masukan yang bukan rupiah utuh berubah diam-diam menjadi bilangan lain, lalu tercatat tanpa peringatan:

| Diketik atau ditempel | Tercatat |
| --- | --- |
| `12,5` | Rp 125 |
| `1.500.000,00` (salinan dari m-banking) | Rp 150.000.000 |
| `150rb` | Rp 150 |
| `-150.000` | Rp 150.000 |

Kasus pertama teramati di walk Gelombang 4 run perdalam-v1 (#334), 2026-11-15, di Pembayaran tunai: mengisi `12,5` mencatat Rp 125 untuk B-02.

Server punya aturan "pecahan ditolak" lewat `parseRupiah`, tetapi masukan sudah berubah sebelum sampai ke server. Penolakan server hanya tercapai kalau nilai yang dikirim diubah lewat DOM. Sesudah ditolak pun, kolom terisi ulang dengan versi yang karakternya sudah dibuang, sehingga kiriman ulang tetap mencatat bilangan yang salah.

## Solution

Kolom rupiah tidak pernah lagi mengubah masukan menjadi bilangan lain.

- Teks yang bukan rupiah utuh tetap terlihat apa adanya, kolom menampilkan pesan di bawahnya, dan formulir tidak bisa dikirim sampai teksnya diperbaiki.
- Mengetik angka tetap dikelompokkan per ribuan seperti sekarang.
- Kalau pemeriksaan di peramban dilewati, server tetap menolak, dan kolom diisi ulang dengan teks yang diketik.

## Goals and non-goals

**Goals**

- Kolom menerima persis teks yang diterima `parseRupiah`, kecuali tanda minus: angka, angka dengan titik ribuan, spasi pemisah, dan awalan "Rp".
- Koma (termasuk `,00`), titik desimal, huruf, dan tanda minus membuat kolom tidak valid. Teksnya tetap terlihat, satu pesan bersama tampil di bawah kolom, dan kirim diblokir.
- Kalau pemeriksaan klien dilewati, teks mentah sampai ke server. Teks mentah yang dikembalikan server tampil apa adanya.
- Berlaku di keenam formulir lewat komponen bersama.

**Non-goals**

- `parseRupiah` tidak berubah. `,00` tetap ditolak (Q4), dan keputusan "pecahan ditolak, bukan dibulatkan" di modul uang tetap berlaku.
- Pesan server per rute tidak berubah (Q5).
- Tidak ada pola galat per kolom untuk kolom selain rupiah.
- Aturan nominal lebih dari nol, atau tidak negatif untuk Tarif, tetap dipegang server. Kolom kosong tetap ditangani formulir seperti sekarang.

## User stories

1. Sebagai Admin yang mengetik `12,5` di Pembayaran tunai, saya ingin kolom menolak dan memberi tahu alasannya, supaya Rp 125 tidak tercatat diam-diam.
2. Sebagai Warga yang menempel `1.500.000,00` dari m-banking, saya ingin diberi tahu bahwa `,00` harus dihapus, supaya Pembayaran saya tidak tercatat Rp 150.000.000.
3. Sebagai Admin yang mengetik `150rb`, saya ingin kolom menolak, supaya Rp 150 tidak tercatat sebagai pengganti Rp 150.000.
4. Sebagai Admin yang mengetik `-150.000`, saya ingin kolom menolak, karena arah uang ditentukan kategori, bukan tanda nominal.
5. Sebagai pengguna yang mengetik `1500000`, saya ingin kolom tetap menampilkan `1.500.000` sambil saya mengetik, seperti sekarang.
6. Sebagai pengguna yang menempel `Rp 1.500.000` atau `1 500 000`, saya ingin kolom menerimanya sebagai 1.500.000, seperti sekarang.
7. Sebagai pengguna pembaca layar, saya ingin kolom yang tidak valid ditandai dan pesannya terhubung ke kolom itu.
8. Sebagai pengguna yang kirimannya ditolak server, saya ingin kolom menampilkan teks yang saya ketik, bukan versi yang sudah diubah.
9. Sebagai superuser di form Tarif, saldo awal, atau Pengembalian, saya ingin perlakuan yang sama seperti di form Pembayaran.

## Implementation decisions

- **Satu aturan** (Q3, Q9). Tata bahasa kolom adalah tata bahasa `parseRupiah` tanpa tanda minus. Kolom mengambil aturan itu dari modul uang, bukan menulis pola kedua yang bisa menyimpang. `parseRupiah` sendiri tidak berubah.
- **Logika kolom diletakkan di modul TypeScript murni yang diuji unit**, karena tes unit repo ini tidak me-render komponen. Modul itu memilah teks:
  - teks valid menghasilkan angka untuk dikirim dan teks berkelompok untuk ditampilkan;
  - teks tidak valid tetap apa adanya.
- **Saat teks valid**, kolom mengelompokkan ribuan dan menjaga posisi caret seperti sekarang. Saat teks tidak valid, kolom tidak mengubah teksnya.
- **Kapan pesan muncul.** Mengetik angka biasa tidak pernah memunculkan pesan. Pesan muncul paling lambat saat kolom ditinggalkan atau saat formulir dikirim, dan eksekutor boleh memunculkannya lebih awal. Kirim diblokir selama teks tidak valid.
- **Pesan:** satu kunci baru bersama untuk kolom rupiah, di kedua katalog bahasa (Q5). Teksnya "Nominal harus rupiah utuh, misalnya 150.000, tanpa koma, huruf, atau tanda minus. Hapus ,00 kalau ada." Tanpa em dash.
- **Penandaan:** pesan tampil di bawah kolom, kolom diberi `aria-invalid`, dan pesannya terhubung ke kolom. Kirim diblokir lewat validasi bawaan formulir, sehingga peramban memfokuskan kolom.
- **Nilai yang dikirim.** Kalau teks tidak valid, nilai yang dikirim adalah teks mentah, sehingga server menolaknya dengan pesan rute yang sudah ada. Nilai awal yang dikembalikan server ditampilkan apa adanya.
- **Antarmuka komponen untuk keenam pemakainya tidak berubah.** Pesan dan penandaan dipegang komponen sendiri, jadi formulir pemakainya tidak perlu disunting.

## Testing decisions

- **Seam 1: modul logika kolom, diuji unit.**
  - Tabel masukan dan hasilnya (valid, angka, tampilan) mencakup `12,5`, `1.500.000,00`, `150rb`, `-150.000`, `12.5`, `Rp 1.500.000`, `1 500 000`, dan `1500000`.
  - Kesamaan dengan `parseRupiah`: setiap teks yang valid di kolom juga diterima `parseRupiah` dengan angka yang sama.
  - Prior art: tes modul uang.
- **Seam 2: satu spec e2e baru di Pembayaran tunai Admin.**
  - Mengetik `12,5` memunculkan pesan, dan kirim tidak menghasilkan Pembayaran.
  - Mengetik `150.000` mencatat Pembayaran.
  - Spec ini menambah login ke suite e2e. Sejak #336, suite memakai 20 login per run dari batas 30 per menit.
- **Tidak tertangkap:** lima formulir lain. Mereka memakai komponen yang sama, dan walk mencoba dua di antaranya: Pembayaran Warga dan Transaksi Kas baru.

## Success criteria

- Di formulir yang memakai kolom rupiah, mengetik `12,5`, `1.500.000,00`, `150rb`, atau `-150.000` menampilkan pesan bersama di bawah kolom. Teksnya tetap terlihat, dan formulir tidak terkirim.
- Mengetik `1500000` menampilkan `1.500.000`, dan nominalnya tercatat Rp 1.500.000.
- Kiriman yang melewati pemeriksaan klien dengan teks `12,5` ditolak server, dan kolom menampilkan `12,5`.
- Tes unit dan e2e hijau, dan gerbang hijau.

## Out of scope

- Menerima `,00`, atau perubahan `parseRupiah`.
- Pola galat per kolom untuk kolom selain rupiah.
- Perubahan pesan server per rute.

## Further notes

- Asal: #340. Diputuskan di grilling run `tambal-v1`, 2026-11-16 (Q3, Q4, Q5, Q9).



## Catatan penyerahan (run tambal-v1, 2026-11-16)

**1. Yang masuk.** Semuanya di `feat/tambal-v1`. Isinya masuk `main` lewat PR run yang dibuka di tail peta #345.

- **#340**, merge `4b30173` (commit tiket `c22ef67`).
  - `src/lib/money.ts` mengekspor `matchRupiahText` dan `RupiahTextShape`.
  - `src/lib/rupiah-field.ts` (baru) mengekspor `RupiahField`, `readRupiahField`, `editRupiahField`, `countDigits`, dan `caretAfterDigits`.
  - `rupiah-input.svelte` memakai validasi bawaan formulir dan memasang pesan bersama `rupiahInput_invalid`.
  - Tes baru: `tests/unit/rupiah-field.test.ts` dan `tests/e2e/rupiah-input.spec.ts`.

**2. Klaim spec yang dibalik atau digeser run ini.** Tidak ada yang dihapus dari badan spec di atas.

- **Digeser.** "`parseRupiah` sendiri tidak berubah" berlaku untuk perilakunya: `tests/unit/money.test.ts` hijau tanpa diubah. Badannya kini `matchRupiahText` ditambah `rupiah()`, supaya kolom dan server memakai satu penerapan tata bahasa yang sama.
- **Ditambahkan, keputusan eksekutor.** Titik pengelompokan yang ditulis kolom sendiri tidak dibaca sebagai titik desimal (`editRupiahField`).
  - Tanpa itu, mengetik `0` di ujung `1.500` menghasilkan `1.5000`, yang ditolak, sehingga kolom berkelompok tidak bisa diketiki lagi.
  - Perlakuan ini hanya berlaku kalau tampilan sebelumnya persis keluaran `groupThousands` dan suntingannya hanya menyisipkan angka. `12.` lalu `5` tetap ditolak.
- **Dipertajam.** "Pesan muncul paling lambat saat kolom ditinggalkan atau saat formulir dikirim": pesan muncul tepat saat `blur` atau event `invalid`, tidak lebih awal. Kirim tetap diblokir sejak teks menjadi tidak valid.
- **Ditambahkan.** Angka di atas `Number.MAX_SAFE_INTEGER` dianggap tidak valid di kolom, sejalan dengan `rupiah()` yang menolaknya di server. Pesan bersama tidak menyebut batas itu.
- **Bukti digeser.** Kriteria "Mengetik `1500000` ... nominalnya tercatat Rp 1.500.000".
  - Walk mengukur tampilan `1.500.000` dan nilai tersembunyi `1500000` tanpa mengirim.
  - Pencatatan lewat kolom dibuktikan e2e dengan `150.000`.

**3. Cacat dan tindak lanjut yang diajukan.**

- #347, di luar run: hint nominal di `/admin/payments/cash` tidak terhubung ke kolomnya lewat `aria-describedby`. Cacat ini sudah ada sebelum run, berada di luar surface #340, dan diserahkan ke pemilik.

**4. Verifikasi.**

- **Gerbang penuh** di `4b30173`, mulai 10:15:35 WIB: `check` 0 galat, `lint`, `test` 2798/2798, `build`. E2e 50/50.
- **Walk** lewat Playwright MCP. Semua teks diketik per karakter, dan jumlah Pembayaran sebelum dan sesudah walk sama.
  - `12,5`, `1.500.000,00`, `150rb`, dan `-150.000` di `/admin/payments/cash`: teks tetap terlihat, `aria-invalid="true"`, pesan bersama tampil, dan tidak ada POST.
  - `1500000` menampilkan `1.500.000`.
  - Kiriman `novalidate` `12,5` dijawab 400 dengan pesan rute, dan kolom terisi ulang `12,5`.
  - `/payments/new` (`warga01`) dan `/admin/cash/new`: pesan sama, dan kirim diblokir.

