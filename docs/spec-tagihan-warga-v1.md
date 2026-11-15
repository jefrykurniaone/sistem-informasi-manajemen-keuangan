# Spec: tagihan-warga v1 - Tagihan dan rumah milik Warga dihitung di satu tempat, termasuk untuk superuser yang menghuni

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#306](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/306) |
| Run | `perdalam-v1` |
| Peta eksekusi | belum dibuat |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-15, pertanyaan "rumah mana milik saya, hari ini dan kapan pun, dan Tagihan mana yang boleh saya lihat" dirakit sendiri-sendiri di enam tempat: daftar "Tagihan saya", pemilih Tagihan di form Pembayaran, penjaga form Pembayaran, rute Pembayaran, dan kartu Warga di Beranda. Satu-satunya potongan yang dipakai bersama adalah visibilitas Unit, dan potongan itu menjawab "semua" untuk siapa pun yang memegang hak kelola Masa Huni, yaitu superuser. Hak admin itu ikut terbawa ke layar pribadi.

Akibatnya terlihat pada superuser yang juga menghuni rumah. Contoh: Rina adalah superuser dan menghuni A-12 sejak 1 Juni 2026. Penghuni sebelumnya meninggalkan Tagihan Januari sampai Maret yang belum dibayar. Hari ini "Tagihan saya" milik Rina menampilkan tiga Tagihan itu sebagai utangnya, dengan total menunggak Rp 450.000, Beranda bilang Rina menunggak, dan form Pembayaran menawarkannya. Commit `89948c3` pernah memperbaiki kebocoran yang sama di pemilih Tagihan, dan aturannya masih dirakit dua kali.

Status sebuah Tagihan (lunas, sebagian, belum dibayar, menunggak) dihitung oleh satu fungsi kecil, tetapi bahan bakunya ditulis ulang di setiap pemakai: jumlah teralokasi per Tagihan ada empat salinan, sisa tagihan tiga, dan "hari ini" WIB tiga. Tidak ada tes yang memastikan Beranda, Laporan Bulanan, dan "Tagihan saya" sepakat untuk data yang sama.

Form Pembayaran juga menawarkan Tagihan yang sudah lunas. Pemilihnya tidak menghitung Alokasi, jadi Tagihan lunas tampil sama dengan yang belum dibayar, dan mencentangnya mengisi besaran penuh ke kolom nominal. Uangnya tidak hilang, karena kelebihannya menjadi Saldo Titipan saat verifikasi, tetapi Warga digiring membayar sesuatu yang tidak ia utang.

## Solution

- Di layar pribadi ("Tagihan saya", kartu Warga di Beranda, dan form Pembayaran), setiap orang hanya melihat Tagihan untuk Periode di dalam Masa Huninya sendiri, apa pun perannya. Superuser dan Admin yang menghuni rumah diperlakukan sama dengan Warga lain di layar itu.
- Layar admin Unit tetap menampilkan seluruh riwayat Unit kepada superuser.
- Form Pembayaran hanya menawarkan Tagihan yang belum lunas. Tagihan yang sudah dibayar sebagian mengisi sisa tagihannya, bukan besaran penuhnya.
- Status Tagihan dan angka turunannya sama di "Tagihan saya", Beranda, dan Laporan Bulanan, karena dihitung di satu tempat.

## Goals and non-goals

**Goals**

- Satu modul menjawab pertanyaan sisi Warga: rumah yang pernah dihuni, rumah yang dihuni hari ini, dan Tagihan yang boleh dilihat di dalam Masa Huni sendiri.
- Satu modul menjawab posisi Tagihan: jumlah teralokasi, sisa, dan status, untuk sekumpulan Tagihan pada satu hari WIB.
- Cacat superuser yang menghuni rumah dan cacat Tagihan lunas di form Pembayaran diperbaiki, masing-masing diawali tes yang gagal.

**Non-goals**

- Visibilitas layar admin tidak berubah.
- Pemisahan peran Superuser dan Admin tetap. Superuser tidak mewarisi tindakan Admin (keputusan grilling Q11).
- Saldo Titipan di Beranda tetap Saldo Titipan Unit secara utuh (keputusan Q8).
- Urutan Alokasi saat verifikasi tidak berubah, dan centang Tagihan di form tetap hanya bantuan mengisi nominal, tidak dikirim bersama Pembayaran.

## User stories

1. Sebagai Warga, saya ingin "Tagihan saya" hanya memuat Tagihan untuk Periode di dalam Masa Huni saya, supaya saya tidak pernah melihat utang orang lain.
2. Sebagai superuser yang juga menghuni rumah, saya ingin layar pribadi saya memperlakukan saya seperti Warga lain, supaya tunggakan penghuni sebelumnya tidak dihitung sebagai utang saya.
3. Sebagai Admin yang juga menghuni rumah, saya ingin hal yang sama, dengan alasan yang sama.
4. Sebagai superuser, saya ingin layar admin Unit tetap menampilkan seluruh riwayat Unit, supaya pengawasan saya tidak berkurang.
5. Sebagai Warga, saya ingin total tunggakan di "Tagihan saya" hanya menjumlah Tagihan yang saya lihat, supaya angkanya bisa saya cocokkan dengan daftarnya.
6. Sebagai Warga, saya ingin kartu Tagihan di Beranda sepakat dengan "Tagihan saya", supaya saya tidak mendapat dua jawaban.
7. Sebagai Warga yang sudah pindah, saya ingin tetap melihat Tagihan dari masa saya menghuni, supaya riwayat saya tidak hilang.
8. Sebagai Warga yang pindah lalu kembali ke rumah yang sama, saya ingin hanya Tagihan di dalam kedua Masa Huni saya yang tampil, bukan Tagihan di sela-selanya.
9. Sebagai Warga yang mencatat Pembayaran, saya ingin form hanya menawarkan Tagihan yang belum lunas, supaya saya tidak membayar sesuatu yang sudah lunas.
10. Sebagai Warga yang mencatat Pembayaran, saya ingin Tagihan yang sudah dibayar sebagian mengisi sisa tagihannya, supaya nominal yang terisi adalah yang memang saya utang.
11. Sebagai Warga, saya ingin Saldo Titipan rumah saya di Beranda tetap utuh, karena saldo itu milik Unit dan akan melunasi Tagihan berikutnya.
12. Sebagai Admin, saya ingin hitungan Unit lunas di Beranda pengurus dan di Laporan Bulanan sepakat dengan status yang dilihat Warga, supaya laporan saya bisa dipertanggungjawabkan.
13. Sebagai pengembang, saya ingin satu tempat menjawab "Tagihan mana yang boleh dilihat Warga ini", supaya layar baru tidak bisa membocorkannya.
14. Sebagai pengembang, saya ingin satu tempat menghitung jumlah teralokasi, sisa, dan status Tagihan pada satu hari WIB, supaya angka tidak bisa berselisih antar-layar.

## Implementation decisions

**1. Modul tampilan Warga atas rumahnya sendiri.**

- Modul baru di samping modul visibilitas Masa Huni. Ia menjawab tiga hal untuk satu orang: rumah yang pernah dihuninya, rumah yang dihuninya hari ini (memakai predikat "sedang menghuni" yang sudah ada sejak #241), dan rentang hari Masa Huninya per Unit untuk memutuskan Tagihan mana yang terlihat. Aturan terlihatnya tetap aturan hari ini: hari pertama Periode sebuah Tagihan jatuh di dalam salah satu rentang Masa Huni orang itu, dengan kedua ujung inklusif.
- Modul ini tidak membaca peran sama sekali. Layar pribadi bertanya tentang orangnya, bukan tentang haknya.
- Pemakainya: daftar "Tagihan saya" dan totalnya, pemilih Tagihan dan penjaga form Pembayaran, rute Pembayaran, dan kartu Warga di Beranda. Salinan pribadi yang ada (daftar rumah yang pernah dihuni di kueri Tagihan, penyaringan "sedang menghuni" di modul Pembayaran dan di rutenya, dan kueri sendiri di Beranda) dihapus.
- Penjaga form Pembayaran berhenti memuat seluruh tampilan "Rumah saya", termasuk nama penghuni serumah, hanya untuk mendapat satu jawaban ya atau tidak.
- Visibilitas Unit yang ada, yang menjawab "semua" untuk pemegang hak kelola Masa Huni, tetap ada dan hanya dipakai layar riwayat admin.
- Namanya memakai istilah yang sudah ada di `CONTEXT.md` (`Resident`, `Unit`, `Occupancy`). Tidak ada istilah baru.
- _Mengapa:_ aturan yang dirakit di enam tempat sudah bocor dua kali. Satu modul yang tidak mengenal peran membuat hak admin tidak bisa lagi menyusup ke layar pribadi.

**2. Modul posisi Tagihan.**

- Untuk sekumpulan Tagihan dan satu hari WIB, modul ini mengembalikan setiap Tagihan dengan jumlah teralokasi, sisa tagihan, dan statusnya. Kosakata statusnya tetap kosakata yang sudah ada.
- Pemanggil boleh menyempitkannya ke satu orang. Penyempitan itu memakai modul tampilan Warga di keputusan 1, bukan aturan sendiri.
- "Hari ini" dibaca sekali dari modul waktu bersama, bukan dihitung ulang per pemakai.
- Pemakainya: "Tagihan saya", Beranda (kartu Warga dan kartu pengurus), penyusunan Laporan Bulanan, pemilih form Pembayaran, dan modul Alokasi. Empat salinan jumlah teralokasi, tiga salinan sisa, dan tiga salinan "hari ini" dihapus.
- Verifikasi Pembayaran tetap mengunci Tagihan terbuka sebuah Unit. Ia mendapat pintu kecil kedua ke aturan hitung yang sama, yang mengambil kuncinya. Urutan kunci verifikasi tidak berubah.
- Fungsi status murni yang ada menjadi bagian dalam modul ini dan tidak lagi dipanggil langsung oleh layar.
- _Mengapa:_ fungsi status sendirian dangkal. Pekerjaan yang sebenarnya, yaitu jumlah, sisa, dan hari, tersebar dan tidak teruji bersama.

**3. Form Pembayaran.**

- Pemilih hanya menawarkan Tagihan yang tidak dibatalkan, belum lunas, dan terlihat bagi orang itu.
- Tagihan yang sudah dibayar sebagian menampilkan sisanya. Mencentangnya menambahkan sisa itu ke kolom nominal, bukan besaran penuhnya.
- Perilaku lain form tidak berubah: centang tetap bantuan mengisi, kolom nominal tetap bisa diubah, dan pilihan Tagihan tidak dikirim.

**4. Keputusan yang dipertahankan dan dicatat.**

- Saldo Titipan di kartu Warga Beranda adalah Saldo Titipan Unit secara utuh, termasuk kelebihan bayar penghuni sebelumnya. Saldo itu milik Unit menurut `CONTEXT.md` dan otomatis dipakai untuk Tagihan berikutnya saat penerbitan.
- Peran tidak berubah. Superuser yang perlu tindakan Admin memegang dua peran.

**5. Tanpa perubahan skema.** Tidak ada migrasi.

## Testing decisions

- **Seam:** interface modul tampilan Warga dan modul posisi Tagihan, diuji terhadap PostgreSQL nyata dengan harness yang ada (satu skema per berkas tes). Tes yang baik hanya memeriksa apa yang dikembalikan interface.
- **Skenario wajib modul tampilan Warga:** pindah keluar; pindah lalu kembali ke Unit yang sama dengan jeda; Unit tanpa Masa Huni; superuser yang menghuni rumah dengan Tagihan penghuni sebelumnya yang belum dibayar (tes ini ditulis lebih dulu dan harus gagal sebelum perbaikan); Admin yang menghuni rumah.
- **Skenario wajib modul posisi Tagihan:** belum dibayar, sebagian, lunas, menunggak di batas jatuh tempo WIB, dan Tagihan yang dibatalkan.
- **Tes silang:** untuk satu set data, hitungan di Beranda, angka iuran di Laporan Bulanan, dan status di "Tagihan saya" sepakat.
- **Form Pembayaran:** tes di interface pemilih bahwa Tagihan lunas tidak ditawarkan dan Tagihan sebagian membawa sisanya. Tes ini ditulis lebih dulu dan harus gagal sebelum perbaikan.
- **Ganti, jangan tumpuk:** tes aturan per layar yang lama (termasuk regresi `89948c3`) ditulis ulang di seam baru, lalu salinannya di tes layar dihapus. Tes layar hanya memeriksa susunan.
- **Prior art:** tes kueri Tagihan, tes modul Pembayaran, tes Beranda, dan tes penyusunan Laporan Bulanan yang sudah ada.
- **Walk browser:** masuk sebagai superuser yang punya Masa Huni di data contoh. "Tagihan saya" hanya menampilkan Tagihan Masa Huninya sendiri, dan form Pembayaran tidak menawarkan Tagihan lunas.

## Success criteria

- Superuser yang Masa Huninya dimulai sesudah penghuni sebelumnya meninggalkan Tagihan belum dibayar tidak melihat Tagihan itu di "Tagihan saya", di total tunggakannya, di kartu Warga Beranda, atau di form Pembayaran. Layar Keuangan Unit di admin tetap menampilkannya.
- Form Pembayaran tidak menawarkan Tagihan lunas, dan Tagihan sebagian mengisi sisanya.
- Satu tes membuktikan Beranda, Laporan Bulanan, dan "Tagihan saya" sepakat.
- Jumlah teralokasi per Tagihan dihitung di satu modul saja, dan tidak ada pemakai lain yang menjumlah Alokasi per Tagihan sendiri.
- Tidak ada layar pribadi yang memakai visibilitas Unit yang menjawab "semua".
- Gate repo hijau dan walk browser di atas lulus.

## Out of scope

- Visibilitas layar admin dan model peran.
- Penyempitan Saldo Titipan ke Masa Huni.
- Mengikat Pembayaran ke Tagihan pilihan Warga.
- Penulisan Masa Huni dan Penanggung Jawab (spec `masa-huni`).
- Penerjemahan galat di route (spec `aksi-rute`).

## Further notes

- Sumber: tinjauan arsitektur 2026-11-15, kandidat 01 dan 02, serta keputusan grilling run `perdalam-v1`: Q3 dan Q10 (layar pribadi superuser), Q8 (Saldo Titipan), Q11 (peran), dan Q15 (Tagihan lunas di form).
- ADR-0001 tidak tersentuh.
- Prinsip run: perilaku yang terlihat tidak berubah selain keputusan di atas. Cacat yang ditemukan di luar area tiket menjadi issue berlabel `run:perdalam-v1` dan masuk gelombang berikutnya.

