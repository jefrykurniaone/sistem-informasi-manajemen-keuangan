# Spec: pemberitahuan v1 - Satu modul untuk email sesudah perubahan tersimpan, tautan berhenti berlangganan, dan job yang menjelaskan dirinya

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#309](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/309) |
| Run | `perdalam-v1` |
| Peta eksekusi | [#334](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/334) |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-15, setiap modul pemberitahuan (iuran, Keluhan, Laporan Bulanan, dan Post) mengerjakan sendiri langkah yang sama: mencari penerima, menyaring Langganan, membangun tautan dari origin, menambahkan tautan berhenti berlangganan, menetapkan bahasa, memasukkan email ke antrean, dan menjaga supaya kegagalannya tidak membatalkan perubahan yang sudah tersimpan. Keempatnya tidak sepakat tentang langkah terakhir:

- Iuran dan Keluhan menangkap kegagalannya sendiri.
- Laporan Bulanan menyerahkannya ke tempat pemanggilan.
- Post tidak menangkapnya sama sekali. Kalau pengiriman pemberitahuan gagal sesudah Post terbit, Admin mendapat galat 500 untuk Post yang sudah terbit. Mengulang menghasilkan "sudah terbit", dan karena email hanya dikirim pada penerbitan pertama, subscriber yang tersisa tidak pernah dikirimi.

Ada juga salinan dan selisih lain:

- Email `new-post` dan `new-complaint` termasuk jenis opt-in tetapi tidak membawa tautan berhenti berlangganan. Yang membawanya hanya Laporan Bulanan, padahal story 22 di spec kas-laporan meminta "berhenti berlangganan lewat satu tautan di email".
- Kueri email pencatat Pembayaran dan email pelapor Keluhan sama persis. Konstanta bahasa `'id'` ditulis tiga kali. Nama jenis email berasal dari dua kosakata: sebagian template menurunkannya dari daftar jenis Langganan, sebagian lagi menulis teks literal yang harus cocok dengan tangan.
- Menambah satu jenis email opt-in menyentuh sekitar sembilan berkas.

Job terjadwal punya masalah serupa:

- Menambah satu job menyentuh sekitar enam tempat.
- Halaman job di admin menurunkan ulang penanda Periode dengan regex sendiri dan mengenali kegagalan iuran dari teks nama galat.
- Job mendaftar dua kali, saat modulnya diimpor dan di `hooks.server.ts`. Tesnya mengimpor modul job secara langsung, tidak lewat `hooks.server.ts`, jadi job yang modulnya lupa diimpor `hooks.server.ts` tetap lolos gate padahal tidak ada di produksi.

## Solution

- Menerbitkan Post tidak pernah gagal karena email. Kegagalan email dicatat, dan perubahan yang sudah tersimpan tetap dilaporkan berhasil.
- Setiap email jenis opt-in membawa tautan berhenti berlangganan.
- Halaman job di admin tampil sama seperti sekarang.

## Goals and non-goals

**Goals**

- Satu modul mengirim email tentang perubahan yang sudah tersimpan, dan memegang aturan Langganan, tautan berhenti berlangganan, bahasa, antrean, dan aturan tidak-pernah-gagal.
- Satu kosakata nama jenis email.
- Definisi job membawa fakta tampilannya sendiri, dan `hooks.server.ts` menjadi satu-satunya tempat pendaftaran.

**Non-goals**

- Antrean email dan worker-nya sudah dalam dan tidak diubah.
- Nama job tidak berubah. Nama job bersifat permanen.
- Bahasa per Warga belum disimpan. Semua email tetap berbahasa Indonesia.
- Jenis email baru di luar tautan berhenti berlangganan tidak ditambahkan.

## User stories

1. Sebagai Admin, saya ingin menerbitkan Post selalu dilaporkan berhasil kalau Post-nya memang terbit, meski pengiriman email gagal, supaya saya tidak menerbitkan ulang.
2. Sebagai Warga yang berlangganan Post baru, saya ingin email tetap sampai ke semua subscriber walau satu pengiriman gagal di tengah jalan.
3. Sebagai Warga, saya ingin setiap email yang bisa saya matikan membawa tautan berhenti berlangganan, supaya saya bisa berhenti tanpa masuk aplikasi.
4. Sebagai Warga, saya ingin email wajib (Tagihan terbit, Pembayaran diverifikasi atau ditolak, perubahan status Keluhan saya) tetap sampai walau saya mematikan email opt-in.
5. Sebagai Admin, saya ingin perubahan status Keluhan, penerbitan Laporan Bulanan, dan verifikasi Pembayaran tidak pernah dilaporkan gagal karena email.
6. Sebagai superuser, saya ingin job yang gagal tetap tercatat gagal di halaman job, supaya penjadwal mengulangnya.
7. Sebagai superuser, saya ingin halaman job menampilkan nama, Periode, dan penjelasan kegagalan seperti sekarang.
8. Sebagai pengembang, saya ingin menambah jenis email opt-in cukup dengan payload, penerima, template, dan teksnya, tanpa menyalin aturan Langganan.
9. Sebagai pengembang, saya ingin job yang tidak terdaftar di `hooks.server.ts` membuat tes gagal.
10. Sebagai pengembang, saya ingin menambah job cukup dengan satu definisi dan teksnya.

## Implementation decisions

**1. Modul pengumuman.**

- Satu modul duduk di depan antrean email. Masukannya jenis email, pembangun payload, dan penerima (daftar yang sudah diketahui, atau penentu penerima).
- Modul ini memegang:
  - penyaringan Langganan, dengan aturan wajib atau opt-in dari daftar jenis Langganan yang ada;
  - tautan berhenti berlangganan bertanda tangan untuk setiap jenis opt-in, dengan mekanisme token yang ada;
  - basis tautan dari origin yang dikonfigurasi, tidak pernah dari header permintaan;
  - bahasa (`id`, sampai bahasa per Warga disimpan);
  - satu baris antrean per penerima.
- **Aturan tidak-pernah-gagal adalah satu helper milik modul ini**, dipakai di setiap tempat pemanggilan sesudah perubahan tersimpan. Karena aturannya berada di tempat pemanggilan, ia tetap berlaku untuk pengirim yang disuntikkan lewat pengaturan, seperti yang sudah dilakukan penerbitan Laporan Bulanan hari ini. Kegagalan dicatat ke console.
- Badan job (misalnya pengiriman Laporan Bulanan terjadwal) memakai varian yang melempar galat, supaya penjadwal mencatat run itu gagal dan mengulangnya.
- _Mengapa:_ empat salinan satu aturan sudah berselisih, dan salah satunya meninggalkan cacat.

**2. Satu kosakata nama jenis.**

- Nama jenis email diturunkan dari daftar jenis Langganan yang ada, dan template menyebut jenisnya dari daftar itu, bukan teks literal.
- Daftar jenis email di tes job tetap menjadi penjaga untuk jenis baru, sesuai `CLAUDE.md`.

**3. Modul pemberitahuan domain menyusut.**

- Iuran, Keluhan, Laporan Bulanan, dan Post masing-masing hanya menyusun payload dan menyebut penerimanya.
- Kueri email pencatat dan email pelapor menjadi satu.
- Penerbitan Post, perubahan status Keluhan, penerbitan Laporan Bulanan, dan verifikasi Pembayaran memakai helper tidak-pernah-gagal.
- Pembatalan verifikasi dari spec `koreksi-kas` mengirim email `payment-rejected` lewat jalur yang sama.

**4. Tautan berhenti berlangganan.** Template `new-post` dan `new-complaint` mendapat tautan berhenti berlangganan, dengan teks Paraglide `id` dan `en` yang simetris dan tanpa em dash.

**5. Definisi job.**

- Definisi sebuah job membawa nama permanennya, jadwal, fungsi run, kunci teks tampilan, pemformat Periode dari jadwalnya, dan jenis kegagalan yang dikenalnya.
- Pendaftaran hanya terjadi lewat komposisi di `hooks.server.ts`, lewat fungsi `register…Jobs` yang idempoten milik modul pemiliknya. Pendaftaran saat modul diimpor dihapus.
- Penjadwal mendaftar definisi beserta run terakhirnya. Halaman job di admin merender dari definisi, tanpa regex Periode dan tanpa mencocokkan teks nama galat.
- Tes job memanggil fungsi komposisi yang sama dengan `hooks.server.ts`, lalu memeriksa daftar nama yang diharapkan.

## Testing decisions

- **Seam:** interface modul pengumuman, diamati lewat baris antrean email di PostgreSQL nyata. Ini seam yang sudah dipakai tes notifikasi hari ini.
- **Skenario wajib:** jenis opt-in hanya sampai ke yang berlangganan; jenis wajib sampai ke semua penerima; setiap jenis opt-in membawa tautan berhenti berlangganan yang sah; helper tidak-pernah-gagal dengan pengirim yang melempar galat meninggalkan perubahan tersimpan dan tidak meneruskan galatnya.
- **Cacat Post:** tes penerbitan Post dengan pengirim yang gagal ditulis lebih dulu dan harus gagal sebelum perbaikan.
- **Ganti, jangan tumpuk:** tes Langganan dan penangkapan galat per modul diganti tes di modul pengumuman. Tes domain hanya memeriksa payload dan pilihan penerima.
- **Job:** tes komposisi memeriksa nama yang diharapkan lewat jalur yang sama dengan `hooks.server.ts`. Tes ini ditulis lebih dulu dengan satu job yang hanya mendaftar saat modulnya diimpor, dan harus gagal.
- **Walk browser:** halaman job di admin sebagai superuser menampilkan nama, Periode, dan penjelasan kegagalan yang sama dengan sebelum run.

## Success criteria

- Penerbitan Post yang pengiriman emailnya gagal tetap dilaporkan berhasil, dan kegagalannya tercatat di console.
- Email `new-post` dan `new-complaint` membawa tautan berhenti berlangganan yang berfungsi.
- Tidak ada modul pemberitahuan domain yang menyaring Langganan, membangun tautan berhenti berlangganan, atau menangkap galat sendiri.
- Job hanya terdaftar lewat `hooks.server.ts`, dan job yang tidak terdaftar di sana membuat tes gagal.
- Halaman job tidak memakai regex Periode atau pencocokan teks nama galat.
- Gate repo hijau dan walk browser lulus.

## Out of scope

- Antrean email, worker, dan pengirim SMTP.
- Bahasa email per Warga.
- Inti penjadwal (lease, backoff, pembersihan), yang sudah dalam.
- Pemilihan penerima email Tagihan (spec `masa-huni`). Spec ini hanya mengubah cara email itu dikirim.

## Further notes

- Sumber: tinjauan arsitektur 2026-11-15, kandidat 05 dan 09, serta keputusan grilling run `perdalam-v1`: Q6 (tautan berhenti berlangganan) dan Q7 (aturan tidak-pernah-gagal, dengan pengecualian badan job).
- Contoh yang sudah benar hari ini: penerbitan Laporan Bulanan menangkap kegagalan email revisinya di tempat pemanggilan, dengan alasan yang tertulis di komentarnya. Spec ini menjadikan cara itu satu helper untuk semua.

