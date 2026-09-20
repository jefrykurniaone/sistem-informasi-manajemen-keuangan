# Spec: iuran - tarif, tagihan, pembayaran, alokasi, saldo titipan

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#3](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/3) |
| Run | `komplek-v1` |
| Peta eksekusi | [#47](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/47) |
| Disalin pada | 2026-09-16 |
| Lintasan penutup | 2026-09-20 — klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Iuran bulanan komplek saat ini dicatat di buku dan spreadsheet bendahara. Warga tidak tahu apakah
ia masih menunggak sampai ditanya. Bendahara tidak tahu siapa saja yang belum bayar tanpa menelusuri
catatan satu per satu. Warga yang membayar tiga bulan sekaligus dicatat di margin buku, dan bulan
berikutnya tidak ada yang ingat.

Setiap kesalahan di bagian ini adalah kesalahan uang orang lain, dan kesalahan uang yang ditemukan
terlambat tidak bisa diperbaiki tanpa merusak kepercayaan.

## Solution

Tagihan iuran terbit otomatis setiap awal bulan untuk setiap rumah yang wajib ditagih, dengan
besaran menurut tarif yang berlaku saat itu. Warga melihat tagihannya, mencatat pembayarannya
beserta foto bukti transfer, dan menunggu verifikasi. Admin memverifikasi; pada saat itu juga uang
masuk ke buku kas dan dialokasikan ke tagihan yang dibayar.

Warga yang membayar lebih dari kewajibannya tidak kehilangan kelebihannya: sisanya menjadi saldo
titipan rumah, yang otomatis memotong tagihan berikutnya saat terbit.

## Goals and non-goals

**Goals**

- Tagihan terbit sendiri, tepat satu kali per rumah per bulan, tanpa ada yang perlu ingat.
- Besaran tagihan mengikuti tarif yang berlaku pada bulan itu, dan kenaikan tarif tidak mengubah
  tagihan lama.
- Rumah yang dibebaskan dari iuran tidak ditagih, dengan periode pembebasan yang jelas.
- Warga tahu tanpa bertanya: berapa tagihannya, mana yang sudah lunas, berapa total tunggakannya.
- Pembayaran selalu punya bukti dan selalu punya yang memverifikasi.
- Kelebihan bayar tidak pernah hilang.
- Uang iuran yang masuk ke kas dan status lunas sebuah tagihan tidak bisa saling bertentangan.

**Non-goals**

- Tidak ada payment gateway; pembayaran adalah transfer manual dan tunai.
- Tidak ada denda keterlambatan.
- Tidak ada penagihan pro-rata untuk warga yang masuk di tengah bulan.

## User stories

1. Sebagai superuser, saya ingin menetapkan tarif iuran bulanan beserta tanggal mulai berlakunya,
   supaya kenaikan iuran hasil rapat warga bisa dijadwalkan.
2. Sebagai superuser, saya ingin melihat riwayat tarif, supaya saya bisa menjelaskan kenapa tagihan
   tahun lalu berbeda dengan tahun ini.
3. Sebagai superuser, saya ingin mengubah tarif yang belum berlaku, tetapi tidak bisa mengubah
   tarif yang sudah dipakai menagih.
4. Sebagai warga, saya ingin tagihan bulan ini terbit sendiri, supaya saya bisa membayar tanpa
   menunggu diingatkan.
5. Sebagai warga, saya ingin menerima email saat tagihan saya terbit, berisi besarannya dan tanggal
   jatuh temponya.
6. Sebagai warga, saya ingin melihat daftar tagihan saya beserta statusnya, supaya saya tahu apa
   yang masih harus saya bayar.
7. Sebagai warga, saya ingin melihat total tunggakan saya dalam satu angka, supaya saya tidak perlu
   menjumlahkan sendiri.
8. Sebagai warga, saya ingin mencatat pembayaran saya dengan memilih tagihan yang saya bayar,
   mengisi nominal dan tanggal transfer, dan mengunggah foto bukti.
9. Sebagai warga, saya ingin membayar beberapa bulan sekaligus dalam satu transfer, karena itu yang
   biasa saya lakukan.
10. Sebagai warga, saya ingin membayar di muka meski tagihannya belum terbit, dan kelebihannya
    tersimpan atas nama rumah saya.
11. Sebagai warga, saya ingin melihat status pembayaran saya — menunggu, terverifikasi, atau
    ditolak beserta alasannya.
12. Sebagai warga, saya ingin menerima email saat pembayaran saya diverifikasi, supaya saya punya
    bukti dari sisi pengurus.
13. Sebagai warga, saya ingin membatalkan pembayaran yang salah saya catat, selama belum
    diverifikasi.
14. Sebagai admin, saya ingin melihat antrean pembayaran yang menunggu verifikasi beserta foto
    buktinya.
15. Sebagai admin, saya ingin memverifikasi sebuah pembayaran, dan alokasinya ke tagihan terjadi
    sekaligus tanpa saya menghitung manual.
16. Sebagai admin, saya ingin menolak pembayaran dengan alasan, supaya warga tahu apa yang harus
    diperbaiki.
17. Sebagai admin, saya ingin mencatat pembayaran tunai atas nama warga yang menyetor langsung,
    dan pembayaran itu langsung terverifikasi.
18. Sebagai admin, saya ingin melihat daftar rumah yang menunggak beserta besarannya, supaya
    penagihan bisa diarahkan.
19. Sebagai superuser, saya ingin menandai sebuah rumah bebas-tagih sejak tanggal tertentu sampai
    tanggal tertentu atau tanpa batas, supaya rumah yang ditinggalkan pemiliknya tidak terus
    ditagih.
20. Sebagai superuser, saya ingin membatalkan sebuah tagihan dengan alasan, dan pembatalan itu
    tidak pernah menghapus barisnya.
21. Sebagai superuser, saya ingin sistem menolak pembatalan tagihan yang sudah menyerap pembayaran,
    dan memberi tahu saya bahwa alokasinya harus dilepas lebih dulu.
22. Sebagai superuser, saya ingin melepas alokasi sebuah pembayaran dari sebuah tagihan, dan uang
    itu kembali menjadi saldo titipan rumah.
23. Sebagai superuser, saya ingin mengembalikan saldo titipan sebuah rumah kepada warga yang pindah,
    dan pengembalian itu tercatat sebagai uang keluar.
24. Sebagai superuser, saya ingin memicu penerbitan tagihan secara manual, supaya saya bisa
    mengujinya tanpa menunggu tanggal 1.
25. Sebagai admin, saya ingin melihat riwayat lengkap sebuah tagihan — siapa membayar berapa, kapan
    diverifikasi, siapa yang memverifikasi.

## Implementation decisions

**Tarif berversi, bukan angka tunggal.** Sebuah Tarif punya besaran dan tanggal mulai berlaku.
Tagihan menyimpan besarannya sendiri saat terbit, bukan menunjuk ke Tarif. Alasannya: menaikkan
iuran tidak boleh mengubah angka tagihan yang sudah terbit dan sudah dibayar, dan menunjuk ke Tarif
membuat laporan tahun lalu berubah setiap kali rapat warga menaikkan iuran. Tarif yang sudah pernah
dipakai tidak bisa diubah, hanya digantikan oleh tarif baru dengan tanggal berlaku setelahnya.

**Penerbitan tagihan adalah pekerjaan terjadwal yang idempoten.** Setiap tanggal 1, satu Tagihan
diterbitkan untuk setiap Unit aktif yang tidak sedang bebas-tagih, untuk periode bulan itu, dengan
jatuh tempo tanggal 5. Kunci uniknya adalah pasangan Unit dan periode, dipaksakan oleh basis data.
Menjalankan pekerjaan itu dua kali tidak menghasilkan tagihan ganda; menjalankannya terlambat
menghasilkan tagihan yang sama. Alasannya: pekerjaan terjadwal akan dijalankan ulang — setelah
mati listrik, setelah deploy, oleh superuser yang menekan tombol karena ragu — dan tagihan ganda
adalah kesalahan yang dilihat seratus warga sekaligus.

**Bebas-tagih adalah periode, bukan saklar.** Sebuah Pembebasan menunjuk satu Unit, punya tanggal
mulai dan tanggal selesai yang boleh kosong, dan alasan. Penerbitan tagihan melewatkan Unit yang
periodenya tertutup Pembebasan. Pembebasan yang ditetapkan mundur **tidak** membatalkan tagihan
yang sudah terbit secara otomatis; superuser membatalkannya satu per satu. Alasannya: pembatalan
mundur otomatis akan membatalkan tagihan yang ternyata sudah dibayar, dan itu menghilangkan uang
yang sudah masuk kas.

> [!note] Dibalik oleh run `komplek-v1`
> "Periodenya tertutup Pembebasan" diuji pada satu hari saja, bukan atas seluruh bulan:
> `issueForUnit` menanyakan `isUnitExemptOn(transaction, unit.id, plan.issuanceDay)` dengan
> `issuanceDay = firstDayOfPeriod(period)`, jadi **Pembebasan yang mulai di tengah bulan tidak
> menghentikan Tagihan bulan itu** dan
> menjalankan pekerjaannya terlambat tetap menghasilkan Tagihan yang sama. #25 (`51c0489`) menulis
> `src/lib/server/services/dues/exemption.ts`, #26 (`84667cd`) menulis `invoice.ts` dan
> `issuance.ts` di direktori yang sama.

**Pembayaran dan alokasi adalah dua hal yang berbeda.** Sebuah Pembayaran adalah satu setoran uang
dengan nominal, tanggal terima, bukti, pencatat, dan status. Sebuah Alokasi memetakan sebagian
nominal Pembayaran ke satu Tagihan. Satu Pembayaran boleh punya banyak Alokasi. Jumlah seluruh
Alokasi sebuah Pembayaran tidak pernah melebihi nominalnya; sisanya adalah saldo titipan. Alasannya:
warga membayar Rp300.000 untuk tiga bulan yang dua di antaranya belum terbit — tanpa pemisahan ini,
tidak ada tempat untuk menaruh uang yang belum punya tagihan.

**Saldo titipan milik Unit, bukan orang.** Ia adalah selisih antara jumlah Pembayaran terverifikasi
sebuah Unit dan jumlah Alokasinya — sebuah angka yang dihitung, bukan kolom yang disimpan dan
di-update, sehingga tidak bisa melenceng dari transaksinya. Saat tagihan baru terbit, saldo titipan
Unit dipakai otomatis untuk melunasinya. Saat masa huni berakhir dan masih ada saldo, superuser
mencatat pengembalian sebagai uang keluar yang mengonsumsi saldo itu.

> [!note] Dibalik oleh run `komplek-v1`
> Rumusnya bersuku tiga, bukan dua: `creditBalanceOfUnit` = Σ Pembayaran terverifikasi − Σ Alokasi −
> Σ Pengembalian, sesudah #30 (`6c2d24d`) menambahkan tabel `refunds` (migrasi `0010_refund`) yang
> menyimpan Pengembalian **per Pembayaran**. Sisa sebuah Pembayaran karena itu
> `amount − allocations − refunds`, dan setiap pembelanja saldo titipan harus lewat
> `lockUnallocatedVerifiedPayments` dan mengurangi keduanya — baca
> `src/lib/server/services/dues/credit-balance.ts` dan `credit-refund.ts`. Sifat "dihitung, bukan
> kolom yang disimpan" sendiri mendarat apa adanya: saldo titipan tidak punya tabel.

**Verifikasi adalah satu transaksi yang tidak bisa setengah jalan.** Memverifikasi sebuah Pembayaran
melakukan tiga hal sekaligus: mengubah statusnya menjadi terverifikasi, membuat satu Transaksi Kas
masuk pada kategori sistem "Iuran warga" bertanggal tanggal terima uang, dan membuat Alokasi ke
tagihan-tagihan yang dipilih. Ketiganya berhasil bersama atau gagal bersama. **Transaksi Kas masuk
untuk iuran tidak pernah dibuat dengan cara lain.** Alasannya: kalau bendahara bisa mengetik kas
masuk iuran secara bebas, saldo kas dan status tagihan akan berbeda, dan tidak ada cara menentukan
mana yang benar.

**Alokasi otomatis, tertua lebih dulu.** Saat warga memilih membayar tanpa menentukan tagihan, atau
saat saldo titipan dipakai, alokasi berjalan dari tagihan tertua yang belum lunas. Warga tetap bisa
memilih tagihan tertentu secara eksplisit.

> [!note] Dibalik oleh run `komplek-v1`
> Pilihan eksplisit warga tidak pernah sampai ke pengalokasi: #28 (`f3bdda6` + `de49ac9`) tidak
> menyimpan Tagihan yang dicentang di `/payments/new` — `src/lib/server/services/dues/payment.ts`
> hanya menulis satu baris `payments` berstatus `pending` — jadi yang dilayani lebih dulu adalah
> Tagihan yang **pengurus** sebut eksplisit saat verifikasi, tertua di antara mereka, lalu sisanya
> terus dari yang tertua (#29, `efe9a81` + `282a81e`,
> `src/lib/server/services/dues/allocation.ts`). Kebijakannya *lebih dulu*, bukan *saja*.

**Pembatalan tagihan menolak yang punya alokasi.** Membatalkan sebuah Tagihan menandainya `void`
beserta alasan dan pelakunya; barisnya tidak pernah dihapus. Kalau Tagihan itu punya Alokasi,
pembatalan ditolak dengan pesan yang menyebut langkah yang harus dilakukan lebih dulu: melepas
alokasinya, yang mengembalikan uang itu menjadi saldo titipan Unit. Alasannya: membatalkan bersama
alokasinya membuat uang lenyap dari sisi tagihan tanpa jejak, dan sejak saat itu saldo kas tidak
lagi sama dengan jumlah alokasi.

**Status tagihan dihitung, bukan disimpan.** Lunas, sebagian, atau belum bayar adalah perbandingan
antara besaran Tagihan dan jumlah Alokasinya. Menunggak adalah belum lunas dan sudah lewat jatuh
tempo. Tidak ada kolom status yang bisa tertinggal dari kenyataan.

**Bukti pembayaran lewat port penyimpanan.** Berkas bukti disimpan lewat port `FileStore` dari spec
fondasi dan hanya bisa dibuka lewat tautan bertanda tangan berumur pendek, karena bukti transfer
memuat nomor rekening dan nama pemiliknya.

**Audit.** Verifikasi, penolakan, pembatalan tagihan, pelepasan alokasi, perubahan tarif, penetapan
pembebasan, dan pengembalian saldo semuanya masuk audit log dari spec fondasi.

**Email.** Dua jenis: tagihan terbit dan pembayaran diverifikasi. Keduanya dikirim ke penanggung
jawab Unit yang aktif saat itu, lewat antrean email spec fondasi, dan keduanya tidak bisa dimatikan
warga karena menyangkut uang miliknya sendiri.

> [!note] Dibalik oleh run `komplek-v1`
> Hanya `invoice-issued` yang dikirim ke penanggung jawab Unit yang aktif; `payment-verified`
> dikirim ke **pencatat Pembayaran** (`payments.recordedBy`), penyimpangan yang dicatat saat dispatch
> #31 (`d2b03a9`) karena badan tiketnya menyebut pencatat — pada alur warga biasa keduanya orang yang
> sama. Jenisnya juga tiga, bukan dua: kedua jenis wajib itu ditambah `payment-rejected` yang
> transaksional, juga ke pencatatnya. Baca `src/lib/server/services/dues/notification.ts`.

## Testing decisions

Pengujian di sini adalah pertahanan utama spec ini. Semuanya berjalan di lapisan service terhadap
PostgreSQL nyata, dengan jam palsu, karena setiap aturan di atas bergantung pada tanggal.

- **Idempotensi penerbitan.** Menjalankan penerbitan dua kali untuk periode yang sama menghasilkan
  jumlah tagihan yang sama. Menjalankannya untuk periode yang berbeda menghasilkan tagihan baru.
- **Tarif berversi.** Tagihan Januari memakai tarif lama meski tarif baru ditetapkan pada Februari;
  pengujian ini gagal kalau ada yang mengubah Tagihan menjadi menunjuk ke Tarif.
- **Bebas-tagih.** Unit yang dibebaskan tidak menerima tagihan selama periodenya, dan menerima lagi
  sesudahnya. Pembebasan yang ditetapkan mundur tidak mengubah tagihan yang sudah terbit.
- **Alokasi banyak-ke-satu.** Satu pembayaran Rp300.000 terhadap tiga tagihan Rp100.000 melunasi
  ketiganya dan menyisakan saldo titipan nol.
- **Bayar di muka.** Satu pembayaran Rp300.000 saat hanya ada satu tagihan Rp100.000 melunasinya dan
  menyisakan saldo titipan Rp200.000; penerbitan bulan berikutnya memakai saldo itu dan tagihan baru
  langsung lunas.
- **Atomisitas verifikasi.** Sebuah kegagalan yang disuntikkan di tengah verifikasi meninggalkan
  pembayaran tetap berstatus menunggu, tanpa transaksi kas dan tanpa alokasi.
- **Pembatalan tagihan.** Tagihan tanpa alokasi bisa dibatalkan; tagihan dengan alokasi ditolak;
  setelah alokasinya dilepas, pembatalan berhasil dan saldo titipan Unit bertambah sebesar alokasi
  yang dilepas.
- **Invarian uang.** Untuk sebuah Unit, jumlah pembayaran terverifikasi selalu sama dengan jumlah
  alokasi ditambah saldo titipan ditambah pengembalian — diuji sebagai pernyataan yang dijalankan
  setelah rangkaian aksi acak yang panjang, bukan hanya pada satu skenario yang dipilih tangan.
- **Penyaringan menurut masa huni.** Penghuni baru tidak melihat tagihan dari sebelum masa huninya,
  memakai fungsi yang diterbitkan spec warga-unit.
- Playwright dipakai untuk satu alur: warga mencatat pembayaran dengan bukti, admin memverifikasi,
  warga melihat tagihannya lunas.

## Success criteria

- Menjalankan penerbitan tagihan dua kali untuk bulan yang sama tidak menghasilkan tagihan ganda.
- Tagihan yang terbit sebelum kenaikan tarif tetap menunjukkan besaran lama.
- Rumah yang berstatus bebas-tagih tidak muncul dalam hasil penerbitan.
- Warga dapat mengunggah bukti transfer dan melihat pembayarannya berstatus menunggu.
- Verifikasi oleh admin, dalam satu aksi, mengubah status pembayaran, menambah satu baris kas masuk
  bertanggal tanggal terima uang, dan melunasi tagihan yang dipilih.
- Pembayaran Rp300.000 atas satu tagihan Rp100.000 menyisakan saldo titipan Rp200.000, dan tagihan
  bulan berikutnya terbit langsung lunas.
- Percobaan membatalkan tagihan yang sudah menyerap pembayaran ditolak dengan pesan yang menyebut
  apa yang harus dilakukan lebih dulu.
- Melepas alokasi mengembalikan nilainya ke saldo titipan rumah, terlihat di layar admin.
- Daftar penunggak menampilkan rumah dan besarannya, dan hanya bisa dibuka oleh admin.
- Email tagihan terbit dan email pembayaran diverifikasi tertangkap Mailpit dengan besaran yang
  benar.

## Out of scope

Payment gateway dan pembayaran daring, denda keterlambatan, penagihan pro-rata, iuran yang berbeda
per blok atau tipe rumah, tagihan selain iuran bulanan rutin, cicilan, pengingat otomatis berulang
untuk penunggak, laporan keuangan (milik spec kas-laporan).

## Further notes

Diblokir oleh spec fondasi dan spec warga-unit. Kategori kas "Iuran warga" yang dipakai verifikasi
adalah kategori sistem yang didefinisikan spec kas-laporan; urutan pengerjaannya ditetapkan di peta
eksekusi agar kategori itu sudah ada sebelum verifikasi pertama dijalankan.
