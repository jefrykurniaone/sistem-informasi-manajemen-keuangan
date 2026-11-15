# Spec: koreksi-kas v1 - Satu penulis buku kas, saldo awal yang bisa diperbaiki, Pembatalan verifikasi dan Pembatalan Pengembalian

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#308](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/308) |
| Run | `perdalam-v1` |
| Peta eksekusi | belum dibuat |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-15, buku kas punya empat masalah, dan koreksi iuran punya dua.

**Buku kas.**

- "Append-only, dan setiap penulisan memeriksa Periodenya" adalah konvensi yang tersebar di lima perintah tulis dalam tiga modul, bukan satu seam.
- Saldo awal sengaja tidak memeriksa Periode, dengan anggapan tanggalnya selalu sebelum aplikasi dipakai. Tidak ada yang menegakkan anggapan itu, padahal `CLAUDE.md` menulis bahwa setiap jalur tulis memeriksa Periodenya. Kalau saldo awal belum pernah dicatat, superuser bisa mencatatnya di Periode yang sudah terkunci oleh Laporan Bulanan yang terbit, dan angka laporan beku itu tidak lagi cocok dengan buku kas.
- Saldo awal yang salah tidak bisa diperbaiki. Koreksi bisa membaliknya, tetapi sesudah itu saldo awal yang benar ditolak, karena pemeriksaan "sudah ada" ikut menghitung baris yang sudah dikoreksi.
- Koreksi boleh membalik baris apa pun, termasuk pemasukan "Iuran warga" dari verifikasi Pembayaran dan pengeluaran Pengembalian. Sisi iuran tidak ikut berubah: Pembayaran tetap terverifikasi, Alokasinya tetap ada, Tagihan tetap lunas, dan angka iuran di Laporan Bulanan tidak lagi cocok dengan baris kategorinya. Koreksi dipegang Admin, sementara koreksi iuran dipegang superuser, jadi tidak ada satu hak yang mencakup pembalikan utuh.
- Tes daftar ekspor yang menjaga sifat append-only memaku seluruh modul, termasuk fungsi baca. Akibatnya penyusunan Laporan Bulanan menyalin jumlah bertanda dan rentang bulan.

**Koreksi iuran.**

- Tidak ada jalan untuk membatalkan Pembayaran yang terlanjur diverifikasi. Status terverifikasi tidak punya transisi keluar.
- Pembatalan Tagihan, pelepasan Alokasi, dan Pengembalian masing-masing mengulang pemeriksaan hak, pemeriksaan alasan, pencarian Warga pelaku, dan baris Audit Log. Bentuk JSON baris Audit Log itu dibaca riwayat koreksi lewat nama field tanpa tipe, jadi field yang diganti namanya tampil kosong tanpa ada tes yang gagal. Penelusuran sisa Pembayaran dari yang tertua juga ada tiga kali.

## Solution

- Superuser bisa membatalkan verifikasi Pembayaran yang ternyata tidak sah dari layar Keuangan Unit. Pembayaran menjadi ditolak dengan alasan, Tagihan yang dilunasinya kembali belum lunas, buku kas mendapat Koreksi pada tanggal aslinya, dan orang yang mencatat Pembayaran itu menerima email penolakan.
- Superuser bisa membatalkan Pengembalian yang salah catat dari layar yang sama. Saldo Titipan Unit kembali, dan buku kas mendapat Koreksi.
- Koreksi di buku kas menolak baris "Iuran warga" dan memberi tahu bahwa baris itu dibalik lewat Keuangan Unit.
- Saldo awal yang berlaku hanya satu. Kalau salah, Koreksi membaliknya lalu superuser mencatat yang benar. Tanggalnya harus di Periode terbuka dan tidak sesudah Transaksi Kas paling awal.
- Riwayat koreksi di Keuangan Unit menampilkan kedua pembatalan baru.

## Goals and non-goals

**Goals**

- Satu modul penulis buku kas memegang satu-satunya perintah tulis Transaksi Kas, penjaga Periode, aturan tanda, dan aturan baris mana yang boleh dikoreksi.
- Satu modul koreksi iuran memegang Pembatalan Tagihan, pelepasan Alokasi, Pengembalian, Pembatalan verifikasi, Pembatalan Pengembalian, bentuk catatan Audit Log-nya yang bertipe, dan bacaan riwayat koreksi.
- Kedua pembatalan baru, aturan saldo awal, dan penolakan Koreksi atas baris "Iuran warga".

**Non-goals**

- Tidak ada status Pembayaran baru. Pembayaran yang dibatalkan verifikasinya berstatus ditolak (keputusan Q18).
- Pembayaran yang sudah ditolak tidak bisa diverifikasi lagi. Kalau uangnya kemudian benar-benar masuk, Warga mencatat Pembayaran baru.
- Aturan tanggal Koreksi tidak berubah: Koreksi memakai tanggal baris aslinya dan menunggu Periodenya dibuka.
- Tidak ada email untuk Pembatalan Pengembalian. Hari ini pun tidak ada email Pengembalian.
- Pemeriksaan hari terima dan hari Pengembalian, yang membaca hari UTC, tidak diubah.

## User stories

1. Sebagai superuser, saya ingin membatalkan verifikasi Pembayaran yang uangnya ternyata tidak pernah masuk, supaya buku kas dan Tagihan kembali benar.
2. Sebagai superuser, saya ingin pembatalan itu melepas semua Alokasi Pembayaran tersebut, termasuk yang dibuat otomatis oleh penerbitan, supaya tidak ada Tagihan yang tetap lunas oleh uang yang tidak ada.
3. Sebagai superuser, saya ingin pembatalan ditolak kalau sebagian Pembayaran itu sudah keluar lewat Pengembalian, dan pesannya menyebut Pengembalian mana, supaya saya tahu apa yang harus diurus dulu.
4. Sebagai superuser, saya ingin pembatalan ditolak kalau Periode baris kasnya terkunci, dan pesannya mengatakan Periode mana yang perlu dibuka.
5. Sebagai Warga yang mencatat Pembayaran itu, saya ingin menerima email penolakan berisi alasannya, supaya saya tahu Pembayaran saya tidak lagi dihitung.
6. Sebagai Admin yang mencatat Pembayaran tunai, saya ingin menerima email yang sama, seperti pada penolakan biasa.
7. Sebagai superuser, saya ingin membatalkan Pengembalian yang salah catat, supaya Saldo Titipan Unit kembali.
8. Sebagai Admin, saya ingin Koreksi di buku kas menolak baris "Iuran warga" dengan pesan yang jelas, supaya saya tidak membuat buku kas dan Tagihan berselisih.
9. Sebagai superuser, saya ingin melihat daftar Pembayaran terverifikasi milik sebuah Unit di Keuangan Unit, supaya saya bisa memilih yang mau dibatalkan.
10. Sebagai superuser, saya ingin riwayat koreksi menampilkan Pembatalan verifikasi dan Pembatalan Pengembalian beserta alasan dan pelakunya.
11. Sebagai superuser yang memindahkan pencatatan manual ke aplikasi, saya ingin mencatat saldo awal sekali, bertanggal hari terakhir buku manual, dengan nominal saldo kas terakhirnya.
12. Sebagai superuser yang salah memasukkan saldo awal, saya ingin membaliknya dengan Koreksi lalu mencatat yang benar.
13. Sebagai superuser, saya ingin saldo awal ditolak kalau tanggalnya jatuh di Periode terkunci atau sesudah Transaksi Kas paling awal, supaya saldo berjalan tidak pernah dimulai dari nol di tengah jalan.
14. Sebagai pengembang, saya ingin satu-satunya perintah tulis Transaksi Kas berada di satu modul, supaya penjaga Periode tidak bisa terlewat.
15. Sebagai pengembang, saya ingin riwayat koreksi membaca catatan yang ditulis dengan tipe yang sama, supaya nama field yang diganti langsung membuat tes gagal.

## Implementation decisions

**1. Penulis buku kas.**

- Satu modul memegang satu-satunya perintah tulis Transaksi Kas, penjaga Periode, aturan tanda (arah baris dibaca dari Kategori Kas-nya, kecuali Koreksi yang berlawanan), dan aturan baris mana yang boleh dikoreksi.
- Jenis entri yang lewat modul ini: catatan manual Admin, pemasukan "Iuran warga" dari verifikasi, pengeluaran Pengembalian, Koreksi, saldo awal, dan Koreksi yang ditulis kedua pembatalan baru.
- Fungsi baca (jumlah bertanda dan rentang bulan) pindah ke modul baca yang diekspor. Penyusunan Laporan Bulanan memakainya, dan salinannya dihapus.
- Tes daftar ekspor sekarang hanya memaku permukaan tulis modul ini. Saksi append-only yang memotret setiap baris lalu menjalankan setiap penulisan tetap ada dan mencakup jenis entri baru.
- _Mengapa:_ penjaga Periode yang hanya berupa konvensi sudah terlewat sekali, di saldo awal.

**2. Aturan baris yang boleh dikoreksi.**

- Setiap baris tetap menerima paling banyak satu Koreksi.
- Baris di Kategori Kas "Iuran warga" (pemasukan, pengeluaran Pengembalian, dan Koreksi di kategori itu) hanya bisa dikoreksi oleh Pembatalan verifikasi atau Pembatalan Pengembalian. Koreksi biasa menolaknya dengan pesan yang menunjuk ke Keuangan Unit, dan tombol Koreksi tidak ditawarkan pada baris itu di buku kas.
- Baris saldo awal tetap bisa dikoreksi dengan Koreksi biasa.

**3. Saldo awal.**

- Saldo awal yang berlaku adalah baris saldo awal yang belum dikoreksi. Mencatat saldo awal ditolak selama masih ada yang berlaku.
- Tanggalnya harus jatuh di Periode terbuka.
- Tanggalnya tidak boleh sesudah Transaksi Kas paling awal di luar kategori saldo awal, kalau sudah ada transaksi seperti itu.
- Data yang sudah ada tidak diperiksa ulang. Aturan ini hanya berlaku saat mencatat.
- Kunci kategori saldo awal yang ada tetap dipakai, supaya dua permintaan bersamaan tidak sama-sama lolos.

**4. Modul koreksi iuran.**

- Satu modul memegang Pembatalan Tagihan, pelepasan Alokasi, Pengembalian, Pembatalan verifikasi, Pembatalan Pengembalian, dan bacaan riwayat koreksi.
- Bagian yang dipakai bersama: hak `correctDues` (hanya superuser), alasan wajib yang tidak kosong sesudah dipangkas, pencarian Warga pelaku, dan catatan Audit Log bertipe, satu tipe per tindakan. Riwayat koreksi membaca lewat tipe yang sama.
- Penelusuran sisa Pembayaran dari yang tertua menjadi satu fungsi, dipakai oleh penerbitan (saat Saldo Titipan dipakai untuk Tagihan baru) dan oleh Pengembalian.

**5. Pembatalan verifikasi (`unverify`).**

- Masukan: sebuah Pembayaran dan alasan.
- Dalam satu transaksi, dengan urutan kunci yang sama dengan pelepasan Alokasi (Pembayaran dulu, lalu Tagihan):
  - Ditolak kalau Pembayaran tidak berstatus terverifikasi.
  - Ditolak kalau ada Pengembalian yang mengambil dari sisa Pembayaran itu dan belum dibatalkan. Pesannya menyebut Pengembalian tersebut.
  - Semua Alokasi Pembayaran itu dilepas, termasuk yang dibuat penerbitan. Status Tagihan mengikuti, karena status dihitung.
  - Baris pemasukan kasnya dibalik dengan Koreksi bertanggal sama dengan baris aslinya, lewat penulis buku kas. Kalau Periodenya terkunci, pembatalan ditolak. Superuser lalu membuka Periode, dan Admin menerbitkan revisi Laporan Bulanan.
  - Baris kas itu ditemukan lewat catatan Audit Log verifikasi, yang menyimpan id barisnya. Baris kas memang sengaja tidak menyimpan tautan ke Pembayaran. Kalau catatan itu tidak ada, pembatalan ditolak.
  - Pembayaran menjadi ditolak: field verifikasinya dikosongkan dan alasan penolakannya diisi alasan pembatalan, dalam satu perintah ubah yang memenuhi CHECK yang ada.
  - Satu catatan Audit Log ditulis, berisi keadaan sebelum dan sesudah serta Alokasi yang dilepas.
- Sesudah transaksi tersimpan, email `payment-rejected` dikirim ke orang yang mencatat Pembayaran itu. Kegagalan email tidak pernah menggagalkan pembatalan, mengikuti aturan spec `pemberitahuan`.
- Tidak perlu migrasi.

**6. Pembatalan Pengembalian (`reverse` pada `Refund`).**

- Satu Pengembalian adalah satu baris Pengembalian beserta satu baris pengeluaran kasnya, sesuai definisi di `CONTEXT.md`. Satu tindakan Pengembalian di layar yang mengambil dari dua Pembayaran tersimpan sebagai dua Pengembalian.
- Masukan: sebuah Pengembalian dan alasan. Pengeluaran kasnya dibalik dengan Koreksi bertanggal sama, lewat penulis buku kas, dan Periodenya harus terbuka.
- "Sudah dibatalkan" diturunkan dari ada tidaknya Koreksi pada baris kas Pengembalian itu. Tidak ada kolom baru.
- Saldo Titipan hanya mengurangi Pengembalian yang belum dibatalkan. Invarian "terverifikasi = teralokasi + Saldo Titipan + Pengembalian yang berlaku" diperbarui di tes invarian uang.
- Satu catatan Audit Log ditulis per pembatalan.

**7. Layar Keuangan Unit.**

- Daftar Pembayaran terverifikasi milik Unit, dengan tanggal terima, nominal, cara bayar, pencatat, dan ringkasan Alokasinya. Setiap baris punya aksi "Batalkan verifikasi" dengan dialog alasan.
- Setiap Pengembalian punya aksi "Batalkan Pengembalian" dengan dialog alasan.
- Riwayat koreksi menampilkan kedua jenis pembatalan.
- Teks layar dan pesan galat lewat Paraglide, `id` dan `en` simetris, tanpa em dash.

**8. Hak.** Kedua pembatalan memakai `correctDues`. Admin tetap memegang Koreksi untuk baris di luar "Iuran warga".

**9. Glosarium.** Istilah **Pembatalan verifikasi** (`unverify`) dan **Pembatalan Pengembalian** (`reverse` pada `Refund`) sudah ditambahkan ke `CONTEXT.md` di branch dokumen run ini, bersama definisi Kategori Kas "Iuran warga" yang diperbarui.

## Testing decisions

- **Seam:** interface penulis buku kas dan interface modul koreksi iuran, diuji terhadap PostgreSQL nyata.
- **Penulis buku kas:** satu tes Periode terkunci per jenis entri, saksi append-only yang mencakup jenis entri baru, dan tes daftar ekspor yang hanya memaku permukaan tulis.
- **Saldo awal:** Periode terkunci ditolak; tanggal sesudah Transaksi Kas paling awal ditolak; saldo awal kedua ditolak selama yang pertama berlaku; sesudah Koreksi, saldo awal baru diterima. Tes Periode terkunci ditulis lebih dulu dan harus gagal sebelum perbaikan.
- **Pembatalan verifikasi:** skenario grilling, yaitu Pembayaran Rp 600.000 yang melunasi Tagihan Oktober, sisanya dipakai penerbitan untuk Tagihan November, dan Rp 100.000 diambil Pengembalian. Pembatalan ditolak selama Pengembalian itu berlaku, lalu berhasil sesudah Pengembalian dibatalkan. Kedua Tagihan kembali belum lunas, buku kas berimbang, dan Saldo Titipan Unit benar. Skenario lain: belum terverifikasi, dibatalkan dua kali, dan Periode terkunci.
- **Tes kunci:** koneksi kedua memegang kunci baris Pembayaran (`for no key update`), lalu pembatalan harus menunggu. Ini membuktikan urutan kunci yang sama dengan pelepasan Alokasi dan penerbitan.
- **Koreksi biasa:** menolak baris pemasukan "Iuran warga", baris Pengembalian, dan baris Koreksi di kategori itu. Tes ini ditulis lebih dulu dan harus gagal sebelum perbaikan.
- **Invarian uang:** tes urutan acak yang ada diperluas dengan Pembatalan verifikasi dan Pembatalan Pengembalian.
- **Riwayat koreksi:** dibaca dari catatan yang benar-benar ditulis oleh penulisnya, bukan dari data buatan.
- **Walk browser:** sebagai superuser di Keuangan Unit, batalkan verifikasi sebuah Pembayaran di data contoh. Tagihannya kembali belum lunas, riwayat koreksi bertambah satu baris, dan buku kas di Admin menampilkan Koreksi tanpa tombol Koreksi pada baris "Iuran warga".

## Success criteria

- Hanya satu modul yang menulis Transaksi Kas, dan setiap jenis entri ditolak di Periode terkunci.
- Saldo awal di Periode terkunci atau sesudah Transaksi Kas paling awal ditolak, dan saldo awal yang sudah dikoreksi bisa diganti.
- Koreksi biasa menolak setiap baris "Iuran warga".
- Pembatalan verifikasi dan Pembatalan Pengembalian bekerja seperti di keputusan 5 dan 6, dan tes invarian uang tetap hijau dengan keduanya.
- Riwayat koreksi menampilkan kedua pembatalan, dan membaca catatan lewat tipe yang sama dengan penulisnya.
- Gate repo hijau dan walk browser lulus.

## Out of scope

- Status Pembayaran baru dan verifikasi ulang Pembayaran yang ditolak.
- Email untuk Pembatalan Pengembalian.
- Pemeriksaan hari terima dan hari Pengembalian yang membaca hari UTC.
- Posisi Tagihan sisi Warga (spec `tagihan-warga`).
- Modul pengumuman email (spec `pemberitahuan`). Pembatalan verifikasi memanggil pengirim email penolakan yang sudah ada.
- Penerjemahan galat di route (spec `aksi-rute`). Aksi baru di layar Keuangan Unit memakai modul itu kalau sudah tersedia.

## Further notes

- Sumber: tinjauan arsitektur 2026-11-15, kandidat 04 dan 08, serta keputusan grilling run `perdalam-v1`: Q4 dan Q12 (saldo awal), Q5 dan Q16 sampai Q24 (pembatalan).
- Fakta dari scout, per 2026-11-15: status Pembayaran disimpan sebagai teks dengan CHECK `pending`, `verified`, `rejected`; pelepasan Alokasi menghapus barisnya dengan catatan Audit Log; satu baris Pengembalian ditulis per Pembayaran yang diambil, masing-masing dengan baris kasnya sendiri; dan baris kas tidak menyimpan tautan ke Pembayaran.
- Spec ini menyentuh invarian uang dan urutan kunci. Tiket-tiketnya dinilai high-consequence di Stage 3.
- **Data produksi yang sudah ada.** Sebelum run ini, Admin boleh mengoreksi baris "Iuran warga". Kalau produksi sudah punya Koreksi atas baris Pengembalian, keputusan 6 membuat Pengembalian itu terhitung batal dan Saldo Titipan Unitnya naik. Kalau sudah ada Koreksi atas baris pemasukan iuran, Pembayaran-nya tetap terverifikasi dan kasnya tetap berselisih. Pemeriksaan baca-saja atas produksi, dan penanganan apa pun yang dibutuhkan, adalah langkah pemilik sesudah run ditutup. Perbaikan data di produksi hanya dijalankan sesudah dry run-nya diposting dan disetujui.

