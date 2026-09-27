# Spec: penghuni - Penghuni aktif yang jelas, hitungan per orang, dan Penanggung Jawab yang bisa dipindah di hari yang sama

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#238](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/238) |
| Run | `huni-v1` |
| Peta eksekusi | belum terbit (tahap peta) |
| Disalin pada | 2026-09-27 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Superuser adalah yang mengelola Unit dan Masa Huni. Dari sisi mereka, ada tiga masalah pada layar Masa Huni sebuah Unit, dan satu yang sama pada layar warga.

1. **Riwayat bercampur dengan penghuni sekarang.** Halaman "Riwayat huni" sebuah Unit menampilkan setiap Masa Huni dalam satu daftar, diurutkan menurut tanggal mulai. Masa Huni yang masih berjalan dan yang sudah lama selesai tidak dibedakan, jadi superuser tidak bisa melihat sekilas siapa yang tinggal di rumah itu sekarang. Halaman detail Unit sendiri hanya menampilkan angka, tanpa nama.
2. **Angka "Penghuni aktif saat ini" salah.** Per 2026-09-27 ada tiga penyebab, dan ketiganya terjadi di produksi (2 Unit, 5 Masa Huni):
   - Masa Huni dengan tanggal selesai hari ini atau nanti ditampilkan "Sejak X sampai Y", terlihat seperti riwayat, tetapi tetap dihitung. Halaman memberi label menurut "sudah punya tanggal selesai atau belum", sedangkan hitungan memakai "tanggal selesainya belum lewat". Dua aturan untuk satu pertanyaan. Di produksi ada 2 baris seperti ini.
   - Masa Huni yang tanggal mulainya masih di depan ikut dihitung, karena hitungan tidak melihat tanggal mulai sama sekali. Di produksi ada 1 baris seperti ini.
   - Yang dihitung adalah baris Masa Huni, bukan orang. Orang yang tercatat dua kali di unit yang sama terhitung dua kali. Di produksi ada 2 pasang Masa Huni ganda (orang yang sama, unit yang sama, rentang tumpang-tindih), satu di tiap Unit.
3. **Penanggung Jawab tidak bisa diganti di tanggal yang sama.** Superuser mengakhiri Masa Huni A (Penanggung Jawab) dengan tanggal D, lalu mencatat C mulai D dengan centang Penanggung Jawab. Pencatatan ditolak dengan pesan "Unit ini sudah punya penanggung jawab pada rentang tanggal itu ... Akhiri masa huninya lebih dahulu", padahal A sudah diakhiri. Penyebabnya, tanggal selesai adalah hari terakhir menghuni dan pemeriksaan bentrok ikut menghitung hari batas, jadi A dan C sama-sama memegang hari D.
   - Lebih parah lagi, penghuni serumah yang sudah tinggal di sana (misalnya pasangan A) **tidak pernah** bisa dijadikan Penanggung Jawab, pada tanggal berapa pun A diakhiri. Penanda Penanggung Jawab tidak punya tanggal sendiri: ia berlaku untuk seluruh masa huni baris tempatnya menempel, sehingga pasti bertabrakan dengan masa lalu A.
   - Satu-satunya jalan saat ini adalah mengakhiri Masa Huni pasangan itu lalu mencatatnya ulang, dan itu justru menambah baris riwayat.
4. **"Rumah saya" (layar warga) punya masalah label yang sama.** Daftar "Penghuni aktif yang tercatat" memakai aturan hitungan, sedangkan label periodenya memakai aturan "sudah punya tanggal selesai".

## Solution

- **Satu arti "sedang menghuni".** Seseorang sedang menghuni sebuah Unit pada hari t kalau Masa Huninya sudah mulai pada atau sebelum t dan hari terakhirnya belum lewat. Setiap angka, label, tombol, dan pemeriksaan memakai satu arti itu.
- **Halaman Penghuni per Unit dengan tiga bagian.** Halaman yang sekarang bernama "Riwayat huni" menjadi "Penghuni":
  - **Penghuni saat ini**: yang sedang menghuni hari ini, dengan aksi dan lencana Penanggung Jawab.
  - **Akan masuk**: Masa Huni yang tanggal mulainya masih di depan. Hanya tampil kalau ada, dan tidak dihitung.
  - **Riwayat huni**: Masa Huni yang hari terakhirnya sudah lewat. Terlipat secara bawaan dan tanpa lencana Penanggung Jawab.
- **Halaman detail Unit** menampilkan nama Penghuni Aktif di samping angkanya, beserta tautan ke halaman Penghuni.
- **Penghuni Aktif dihitung per orang**, bukan per Masa Huni.
- **Penanggung Jawab berpindah.** "Jadikan penanggung jawab" memindahkan penanda dari pemegang lama ke pemegang baru, langsung berlaku. Pemegang lama tetap tinggal kalau Masa Huninya belum selesai. Mencatat Masa Huni baru dengan centang Penanggung Jawab juga memindahkan penanda. Serah terima di hari yang sama dan penggantian ke penghuni serumah sama-sama bisa dilakukan.
- **Masa Huni ganda ditolak.** Orang yang sama tidak bisa punya dua Masa Huni yang harinya bersinggungan di unit yang sama. Aturan ini berlaku di formulir, impor, undangan, dan pendaftaran.
- **Satu skrip perbaikan data** membersihkan baris ganda yang sudah ada di produksi.
- **"Rumah saya"** memakai arti, pembagian bagian, dan label yang sama.

## Goals and non-goals

**Goals**

- Tidak ada lagi baris yang tampil sebagai riwayat tetapi dihitung sebagai penghuni aktif, atau sebaliknya.
- Angka Penghuni Aktif sama dengan jumlah orang berbeda yang sedang menghuni Unit itu hari ini.
- Superuser bisa memindahkan Penanggung Jawab kepada siapa pun yang sedang menghuni Unit itu, termasuk pada hari yang sama dengan hari terakhir pemegang lama.
- Penerima email tagihan sebuah Unit selalu tepat satu Masa Huni yang sedang berjalan, atau tidak ada sama sekali, dan tidak pernah ambigu.
- Data produksi bersih dari Masa Huni ganda.

**Non-goals**

- Arti tanggal selesai **tidak** berubah: tanggal itu tetap hari terakhir menghuni, termasuk di kontrak visibilitas keuangan, yang kedua ujung rentangnya inklusif.
- Penanggung Jawab **tidak** menjadi periode bertanggal tersendiri. Pertanyaan "siapa Penanggung Jawab pada tanggal lampau" dijawab oleh Audit Log, bukan oleh model data.
- Pemilik yang menyewakan rumahnya **tidak** dibedakan dari pemilik yang tinggal di sana. Keduanya Penghuni Aktif selama Masa Huninya berjalan.
- Tidak ada perubahan skema basis data.

## User stories

1. Sebagai superuser, saya ingin melihat siapa yang tinggal di sebuah Unit hari ini dalam satu bagian tersendiri, supaya saya tidak perlu memilahnya dari riwayat.
2. Sebagai superuser, saya ingin riwayat Masa Huni yang sudah selesai terlipat di bawah, supaya halaman tidak penuh oleh orang yang sudah pindah.
3. Sebagai superuser, saya ingin Masa Huni yang baru akan mulai tampil terpisah sebagai "Akan masuk", supaya saya tahu siapa yang dijadwalkan masuk tanpa mengira mereka sudah tinggal di sana.
4. Sebagai superuser, saya ingin angka Penghuni Aktif sama dengan jumlah orang di bagian "Penghuni saat ini", supaya angka dan daftar tidak saling membantah.
5. Sebagai superuser, saya ingin orang yang tercatat dua kali tetap dihitung satu, supaya kesalahan pencatatan tidak menggelembungkan angka.
6. Sebagai superuser, saya ingin melihat nama Penghuni Aktif langsung di halaman detail Unit, supaya saya tidak perlu membuka halaman lain untuk tahu siapa penghuninya.
7. Sebagai superuser, saya ingin baris yang hari terakhirnya sudah diisi tetapi belum lewat tetap berada di "Penghuni saat ini" dengan catatan hari terakhirnya, supaya saya tahu ia masih tinggal dan kapan ia keluar.
8. Sebagai superuser, saya ingin label input tanggal selesai berbunyi "Hari terakhir menghuni", supaya saya tahu tanggal yang saya isi masih dihitung sebagai hari huni.
9. Sebagai superuser, saya ingin mengakhiri Masa Huni Penanggung Jawab lama pada hari D lalu mencatat penghuni baru mulai hari D sebagai Penanggung Jawab, supaya serah terima rumah bisa dicatat pada hari terjadinya.
10. Sebagai superuser, saya ingin menjadikan penghuni serumah yang sudah tinggal di sana sebagai Penanggung Jawab, supaya penerima email tagihan bisa diganti tanpa mengakhiri dan mencatat ulang siapa pun.
11. Sebagai superuser, saya ingin pemegang lama tetap tercatat sebagai penghuni setelah penanda dipindah, supaya perpindahan Penanggung Jawab tidak mengubah siapa yang tinggal di rumah itu.
12. Sebagai superuser, saya ingin ditolak kalau mencoba menjadikan Masa Huni yang belum mulai sebagai Penanggung Jawab, beserta pesan yang menyebut tanggal mulainya, supaya Unit tidak diam-diam kehilangan penerima email sampai orang itu masuk.
13. Sebagai superuser, saya ingin peringatan merah "Belum ada penanggung jawab" saat hari ini tidak ada Penanggung Jawab yang sedang menghuni, supaya tagihan tidak terbit tanpa penerima.
14. Sebagai superuser, saya ingin peringatan kuning yang menyebut nama Penanggung Jawab dan hari terakhirnya saat hari terakhir itu sudah diisi, supaya saya ingat memindahkan penanda sebelum ia keluar.
15. Sebagai superuser, saya ingin daftar Unit tetap menandai kedua keadaan itu sebagai perlu penanggung jawab, supaya saya menemukan unit yang butuh perhatian dari satu layar.
16. Sebagai superuser, saya ingin setiap perpindahan Penanggung Jawab tercatat di Audit Log dengan pemegang lama dan pemegang baru, supaya siapa pernah memegangnya bisa dilacak.
17. Sebagai superuser, saya ingin ditolak saat mencatat Masa Huni untuk orang yang masih punya Masa Huni bersinggungan di unit yang sama, dengan pesan yang menyebut tanggal mulai paling awal yang boleh, supaya tidak tercipta baris ganda.
18. Sebagai superuser yang mengimpor warga dari XLSX, saya ingin orang yang sama yang muncul dua kali untuk unit yang sama di satu berkas dilaporkan sebagai galat baris, supaya impor tidak diam-diam menggandakan penghuni.
19. Sebagai superuser, saya ingin orang yang sama tetap bisa tercatat di dua unit berbeda pada waktu yang sama, supaya pemilik dua rumah tetap bisa dicatat.
20. Sebagai pemilik sistem, saya ingin satu skrip yang membersihkan Masa Huni ganda di produksi dan menampilkan rencananya lebih dulu tanpa menulis apa pun, supaya saya bisa memeriksa rencana itu sebelum mengizinkannya.
21. Sebagai pemilik sistem, saya ingin setiap baris yang dihapus skrip meninggalkan jejak di Audit Log dengan pelaku `system:data-fix`, supaya penghapusan itu tetap bisa dipertanggungjawabkan.
22. Sebagai warga, saya ingin halaman "Rumah saya" memisahkan rumah yang sedang saya huni, yang akan saya huni, dan yang pernah saya huni, supaya saya tidak bingung melihat masa huni lama.
23. Sebagai warga, saya ingin daftar penghuni rumah saya hanya berisi orang yang sedang menghuninya hari ini, dengan Penanggung Jawab ditandai, supaya saya tahu siapa yang menerima email tagihan.
24. Sebagai warga yang Masa Huninya belum mulai, saya ingin melihat rumah itu sebagai "Akan masuk" tanpa daftar penghuninya, supaya saya tidak melihat data rumah sebelum saya menghuninya.
25. Sebagai Penanggung Jawab baru, saya ingin email tagihan berikutnya sampai kepada saya sejak penanda dipindah, supaya tagihan rumah tidak terus dikirim ke pemegang lama.

## Implementation decisions

**1. Satu predikat "sedang menghuni pada hari t".**
- Definisinya: `tanggal mulai ≤ t` **dan** (`tanggal selesai kosong` **atau** `tanggal selesai ≥ t`), dengan t sebagai hari kalender WIB dari `Clock`.
- Predikat ini menggantikan predikat lama di modul visibilitas Masa Huni, yang hanya melihat tanggal selesai, dalam dua bentuk yang sudah ada: per baris dan sebagai kondisi SQL.
- Setiap pemakai berpindah ke predikat baru: ringkasan Unit (hitungan dan status Penanggung Jawab), status "berjalan" pada daftar Masa Huni per unit, "Rumah saya", Beranda, penerima email tagihan, serta pemeriksaan undangan dan pendaftaran.
- Kontrak visibilitas keuangan tidak berubah. Rentang hari huni dengan kedua ujung inklusif sudah benar dan sudah melihat tanggal mulai.
- *Mengapa:* akar masalah hitungan adalah dua aturan untuk satu pertanyaan. Satu predikat yang dipakai semua orang membuat keduanya tidak bisa berselisih lagi.

**2. Penghuni Aktif dihitung per orang.**
- Ringkasan Unit menghitung Warga berbeda yang punya Masa Huni sedang berjalan hari ini, bukan jumlah baris.
- Ringkasan itu juga mengembalikan nama-nama Penghuni Aktif, dengan Penanggung Jawab lebih dulu lalu urut nama, untuk halaman detail Unit.
- Istilah **Penghuni Aktif** ditambahkan ke `CONTEXT.md` (nama di kode `ActiveOccupant`, dihitung, tanpa tabel).

**3. Pembagian bagian dihitung di layanan, bukan di halaman.**
- Daftar Masa Huni per unit dari layanan dikembalikan dalam tiga kelompok:
  - `current`: sedang menghuni hari ini. Penanggung Jawab lebih dulu, lalu urut tanggal mulai.
  - `upcoming`: tanggal mulai setelah hari ini, urut tanggal mulai.
  - `history`: hari terakhir sebelum hari ini, urut hari terakhir dari yang terbaru.
- Halaman Svelte hanya merender kelompok yang diberikan dan tidak memutuskan apa pun tentang tanggal.
- Hal yang sama berlaku untuk "Rumah saya":
  - Layanan mengembalikan rumah-rumah warga dalam tiga kelompok yang sama.
  - Daftar penghuni (Penghuni Aktif hari ini, Penanggung Jawab ditandai) hanya disertakan untuk rumah di `current`.
  - Rumah `upcoming` tampil tanpa daftar penghuni, sejalan dengan kontrak visibilitas: warga tidak melihat data rumah sebelum hari pertamanya.
  - Rumah `history` juga tanpa daftar penghuni, seperti sekarang.
- *Mengapa:* bug label berasal dari halaman yang mengklasifikasi sendiri dengan aturan berbeda.

**4. Penanggung Jawab berpindah, dan berlaku sejak dipindahkan.** Keputusan ini dicatat sebagai ADR 0001.
- Penanda adalah "penerima email tagihan sekarang", bukan atribut sejarah sebuah Masa Huni. Invariannya: **per Unit, paling banyak satu baris ber-penanda di antara baris yang hari terakhirnya belum lewat atau masih kosong.**
- **Memindahkan.** Di bawah kunci baris Unit, yang sudah dipakai layanan ini, penanda dicabut dari setiap baris Unit itu yang ber-penanda dan hari terakhirnya belum lewat atau kosong, lalu dipasang pada baris tujuan. Keduanya dilakukan dalam satu transaksi.
  - Setiap jalur yang memasang penanda wajib mengambil kunci yang sama. Indeks unik parsial yang ada (penanda dan tanggal selesai kosong) tetap dipertahankan sebagai pengaman terakhir.
  - Indeks itu tidak menangkap baris ber-penanda yang tanggal selesainya sudah diisi tetapi belum lewat. Karena itu, kuncilah yang menjaga invarian ini, bukan indeks.
- **Syarat baris tujuan.** Baris tujuan harus sedang menghuni hari ini.
  - Baris `upcoming` ditolak, dengan galat yang menyebut tanggal mulainya.
  - Baris `history` ditolak, dan tombolnya memang tidak ditawarkan di sana.
  - Memindahkan penanda ke baris yang sudah memegangnya tidak mengubah apa pun dan tidak menulis Audit Log.
- **Mencatat Masa Huni baru dengan centang Penanggung Jawab** berarti mencatat lalu memindahkan, dalam transaksi yang sama. Ini hanya boleh kalau tanggal mulainya hari ini atau sebelumnya.
- **Pemeriksaan bentrok tanggal antar-Penanggung Jawab dihapus** dari mencatat, mengakhiri, dan menandai. Mengakhiri Masa Huni Penanggung Jawab tidak menyentuh penanda.
- **Baris lama.** Penanda pada baris yang hari terakhirnya sudah lewat tetap tersimpan. Penanda itu tidak ditampilkan dan tidak dibaca apa pun, jadi tidak ada migrasi data untuknya.
- **Audit Log.** Setiap perpindahan menulis satu entri `occupancy_primary_occupant_marked`, dengan `before` berisi Masa Huni dan Warga pemegang lama (atau kosong) dan `after` berisi Masa Huni dan Warga pemegang baru serta Unit-nya. Nama aksi lama dipertahankan karena nilai itu sudah tersimpan di `audit_log`.
- **Penerima email tagihan** adalah baris ber-penanda yang sedang menghuni hari ini. Pencariannya tetap diurutkan secara deterministik (tanggal mulai lalu waktu dicatat, terbaru lebih dulu) sebagai pertahanan, meskipun invarian menjamin paling banyak satu.
- **Komentar skema** tabel Masa Huni, yang sekarang menjelaskan penanda sebagai sejarah dan kontrak "Penanggung Jawab pada suatu tanggal", ditulis ulang sesuai model ini dan merujuk ADR 0001.
- *Mengapa:* glosarium sudah menyebut Penanggung Jawab sebagai Masa Huni **aktif**. Tidak ada fitur yang bertanya "Penanggung Jawab pada tanggal lampau": satu-satunya pembaca adalah penerima email hari ini. Model ini juga satu-satunya dari tiga pilihan yang menyelesaikan kasus penghuni serumah tanpa menambah baris riwayat.
- Model periode bertanggal ditolak. Model itu butuh tabel dan istilah baru tanpa ada fitur yang memakainya.

**5. Peringatan Penanggung Jawab.**
- Di halaman Penghuni:
  - **Merah** "Belum ada penanggung jawab", kalau hari ini tidak ada baris ber-penanda yang sedang menghuni.
  - **Kuning**, kalau Penanggung Jawab yang sedang menghuni sudah punya hari terakhir. Pesannya menyebut nama dan hari terakhir itu, dan meminta superuser memindahkan Penanggung Jawab ke penghuni berikutnya.
- Daftar Unit menandai kedua keadaan itu sebagai "perlu penanggung jawab", sama hati-hatinya dengan sekarang.

**6. Masa Huni ganda ditolak.**
- Masa Huni baru ditolak kalau orang yang sama sudah punya Masa Huni lain di unit yang sama yang rentang harinya bersinggungan. Kedua ujung dihitung inklusif, jadi mulai tepat pada hari terakhir Masa Huni sebelumnya juga ditolak.
- Pesan galatnya menyebut tanggal mulai paling awal yang boleh, yaitu sehari setelah hari terakhir Masa Huni yang bersinggungan. Kalau Masa Huni itu belum punya hari terakhir, pesannya meminta Masa Huni itu diakhiri lebih dahulu.
- Aturan ini dipakai oleh keempat jalur yang menciptakan Masa Huni:
  - **Formulir "Catat masa huni"** menolak dengan pesan di atas.
  - **Impor XLSX** per 2026-09-27 hanya mencatat Masa Huni untuk akun baru yang dibuat di impor yang sama, dan email yang sudah terdaftar sudah ditolak sebagai galat baris. Jadi Masa Huni ganda hanya bisa muncul dari orang yang sama yang muncul dua kali untuk unit yang sama di satu berkas. Kasus itu dilaporkan lewat mekanisme galat baris yang sudah ada, dan kalau ternyata sudah tertangkap oleh galat yang ada, cukup dikunci dengan tes.
  - **Undangan dan pendaftaran** per 2026-09-27 melewati pencatatan secara diam-diam (idempoten, tanpa galat) kalau sudah ada Masa Huni berjalan untuk orang dan unit itu. Perilaku melewati itu dipertahankan, tetapi pemeriksaannya diganti dengan aturan bersinggungan yang sama. Masa Huni yang belum mulai atau yang hari terakhirnya belum lewat juga membuatnya melewati pencatatan.
- Orang yang sama di **unit berbeda** tetap boleh bersamaan.
- Pemeriksaan ini dilakukan di bawah kunci baris Unit yang sama, supaya dua permintaan bersamaan tidak sama-sama lolos.

**7. Teks antarmuka.** Katalog `id` dan `en` sama-sama diperbarui.
- Judul halaman dan tautan dari daftar Unit menjadi "Penghuni" (sebelumnya "Riwayat huni").
- Judul bagian: "Penghuni saat ini", "Akan masuk", dan "Riwayat huni".
- Label input tanggal selesai menjadi "Hari terakhir menghuni".
- Baris di "Penghuni saat ini" yang hari terakhirnya sudah diisi berbunyi "Sejak X, hari terakhir Y". Baris riwayat tetap "Sejak X sampai Y".
- Teks final ditetapkan tiket. Spec ini hanya mengikat maknanya.

**8. Skrip perbaikan data satu kali.**
- Sebuah perintah yang dijalankan terhadap `DATABASE_URL`. Logikanya ada dalam satu fungsi yang diekspor dan diuji langsung, seperti perintah pemberian superuser, dan dibungkus satu berkas skrip tipis. Perintah ini **tidak** mendapat entri `package.json` dan **tidak** mengubah `Dockerfile`. Image produksi tidak membawa `src/`, jadi untuk dijalankan sekali di produksi, skrip dibundel di mesin orchestrator dengan cara yang sama seperti `Dockerfile` membundel `grant-superuser` (hanya `pg` dan `drizzle-orm` eksternal), disalin ke container `app` di VM, dijalankan di sana, lalu dihapus. Ini pola yang sama dengan pemeriksaan read-only yang sudah dipakai.
- **Aturan penyaringan.** Untuk setiap pasangan orang dan unit, Masa Huni diurutkan menurut waktu dicatat, dan sebuah baris dipertahankan kalau tidak bersinggungan dengan baris yang sudah dipertahankan. Baris lain dihapus.
- **Penanda ikut dipindah.** Kalau baris yang dihapus memegang penanda dan hari terakhirnya belum lewat, penanda dipindah ke baris yang dipertahankan untuk orang yang sama.
- **Audit Log.** Setiap baris yang dihapus meninggalkan satu entri Audit Log dengan pelaku `system:data-fix`, memuat seluruh nilai baris itu di `before`.
- **Tanpa `--yes`**, perintah hanya mencetak rencananya: unit, baris yang dipertahankan dan yang dihapus, serta perpindahan penanda. Perintah itu tidak menulis apa pun.
- **Dengan `--yes`**, seluruh rencana dijalankan dalam satu transaksi.
- **Jalan kedua** tidak menemukan apa pun dan tidak menulis apa pun.
- **Tanpa pengaman `localhost`**, berbeda dengan perintah Data Contoh, karena sasarannya justru produksi.
- **Eksekusi di produksi.** Dijalankan oleh orchestrator di akhir run, setelah perubahan kode ter-deploy, dan hanya dengan izin eksplisit pemilik yang diberikan saat itu setelah pemilik melihat keluaran dry-run.
- Penghapusan ini adalah pengecualian sekali pakai terhadap aturan "Masa Huni tidak pernah dihapus", disetujui pemilik karena produksi masih uji coba. Tidak ada jalur di aplikasi yang memperoleh kemampuan menghapus.

**9. Dokumen.**
- `CONTEXT.md`: arti tanggal selesai, istilah Penghuni Aktif, dan definisi Penanggung Jawab yang berpindah.
- ADR 0001, Penanggung Jawab berpindah.
- Keduanya mendarat lewat PR docs spec ini, bukan lewat tiket.

## Testing decisions

- **Tes yang baik di sini** memanggil fungsi layanan terhadap Postgres sungguhan dan memeriksa hasil yang terlihat dari luar: kelompok yang dikembalikan, angka, siapa penerima email, galat yang dilempar, dan entri Audit Log. Tes tidak memeriksa bentuk query.
- **Seam utama: layanan Masa Huni**, termasuk predikat di modul visibilitasnya. Contoh yang sudah ada: tes layanan Masa Huni dan tes visibilitas Masa Huni. Kasus wajib:
  - batas tanggal mulai (kemarin, hari ini, besok) dan hari terakhir (kemarin, hari ini, besok) untuk ketiga kelompok;
  - serah terima di hari yang sama;
  - penghuni serumah dijadikan Penanggung Jawab;
  - penanda ke baris `upcoming` ditolak;
  - mencatat dengan centang saat Penanggung Jawab lain aktif;
  - dua perpindahan bersamaan dari dua koneksi, setelah itu tetap satu penanda. Contoh tes dua koneksi sudah ada untuk mencatat Masa Huni;
  - Masa Huni ganda ditolak, termasuk yang hanya bersinggungan di hari batas;
  - orang yang sama di unit lain diterima.
- **Tes yang dibalik.** Tes yang sekarang menegaskan bahwa penghuni serumah **tidak bisa** dijadikan Penanggung Jawab diganti dengan tes yang menegaskan sebaliknya. Tes lain yang mengunci perilaku lama juga diubah sesuai keputusan di atas, bukan dihapus.
- **Layanan Unit**: hitungan per orang, nama Penghuni Aktif, dan dua keadaan "perlu penanggung jawab". Contoh yang sudah ada: tes layanan Unit.
- **Pemakai predikat lain**, masing-masing di seam tesnya sendiri: penerima email tagihan (tes penerbitan Tagihan dan tes notifikasi iuran), impor XLSX (orang yang sama dua kali untuk unit yang sama di satu berkas), Beranda, undangan, dan pendaftaran. Setiap seam minimal mendapat kasus "Masa Huni yang belum mulai tidak dihitung".
- **Skrip perbaikan data**, diuji seperti tes perintah pemberian superuser:
  - dry-run tidak menulis apa pun;
  - `--yes` menghapus baris yang tepat, memindahkan penanda, dan menulis Audit Log `system:data-fix`;
  - jalan kedua tidak mengubah apa pun.
- **Tampilan** tidak punya tes render di repo ini. Tampilan dibuktikan oleh walk orchestrator dengan Playwright MCP di atas Data Contoh. Tidak ada tes e2e baru.

## Success criteria

- Sebuah Unit berisi Masa Huni berikut:
  - A sedang menghuni tanpa hari terakhir;
  - B dengan hari terakhir hari ini;
  - C mulai besok;
  - D yang hari terakhirnya kemarin;
  - satu orang E yang tercatat dua kali dan keduanya sedang menghuni (data lama).

  Unit itu menampilkan Penghuni Aktif **3** (A, B, E). Halaman detail menyebut ketiga nama itu. Halaman Penghuni menaruh A, B, dan E di "Penghuni saat ini", dengan B bercatatan hari terakhir, C di "Akan masuk", dan D di "Riwayat huni" yang terlipat.
- A (Penanggung Jawab) diakhiri dengan hari terakhir hari ini, lalu F dicatat mulai hari ini dengan centang Penanggung Jawab. Pencatatan berhasil, penerima email tagihan hari ini adalah F, dan Audit Log memuat satu entri perpindahan dari A ke F.
- Penghuni serumah G yang sudah tinggal sejak tahun lalu dijadikan Penanggung Jawab. Pencatatan berhasil, pemegang lama tetap di "Penghuni saat ini" tanpa lencana, dan angka Penghuni Aktif tidak berubah.
- Menjadikan C (mulai besok) Penanggung Jawab ditolak dengan pesan yang menyebut tanggal mulai C.
- Mencatat Masa Huni kedua untuk A di unit yang sama ditolak dengan pesan yang sesuai keputusan 6. Mencatat A di unit lain diterima.
- Bagian "Riwayat huni" tidak menampilkan lencana Penanggung Jawab, baik di halaman admin maupun di "Rumah saya".
- Di produksi, setelah skrip dijalankan dengan `--yes`:
  - tidak ada lagi pasangan Masa Huni ganda (orang yang sama, unit yang sama, rentang bersinggungan);
  - setiap Unit paling banyak punya satu Penanggung Jawab yang sedang menghuni;
  - Audit Log memuat satu entri `system:data-fix` per baris yang dihapus.
- Gerbang mutu repo lulus.

## Out of scope

- Mengubah arti tanggal selesai menjadi "tanggal keluar".
- Periode Penanggung Jawab bertanggal, atau layar yang menjawab "siapa Penanggung Jawab pada tanggal X".
- Membedakan pemilik yang tinggal di rumahnya dari pemilik yang menyewakannya.
- Menghapus Masa Huni dari aplikasi. Skrip perbaikan data adalah satu-satunya penghapusan, sekali pakai.
- Membersihkan penanda pada baris yang hari terakhirnya sudah lewat.
- Layar penampil Audit Log.
- Tes e2e baru.
- README berbahasa Inggris. Itu spec `readme-inggris` di run yang sama.

## Further notes

- Angka produksi dalam spec ini adalah keadaan per 2026-09-27, dari pemeriksaan read-only agregat. Tidak ada data pribadi yang dibaca.
- Spec ini membatalkan sebagian `docs/spec-warga-unit-v1.md`, yaitu penanda Penanggung Jawab yang disimpan sebagai sejarah untuk menjawab "Penanggung Jawab sebuah Unit pada suatu tanggal". ADR 0001 adalah rujukan bagi pembaca spec lama.
- Kontrak visibilitas keuangan yang diterbitkan spec warga-unit tidak disentuh.
