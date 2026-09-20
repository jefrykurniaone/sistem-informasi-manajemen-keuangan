# Spec: kas-laporan - buku kas, periode, laporan bulanan berversi

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#4](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/4) |
| Run | `komplek-v1` |
| Peta eksekusi | [#47](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/47) |
| Disalin pada | 2026-09-16 |
| Lintasan penutup | 2026-09-20 — klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Laporan keuangan komplek hari ini adalah kertas yang ditempel di pos satpam atau foto spreadsheet
yang dikirim ke grup WhatsApp. Angkanya diketik ulang dari buku bendahara, jadi tidak ada yang bisa
membuktikan bahwa jumlahnya benar. Warga yang bertanya "uangnya ke mana" tidak punya tempat untuk
mencari jawabannya, dan bendahara yang jujur pun tidak punya cara membuktikan dirinya jujur.

Yang lebih buruk: laporan yang sudah dibagikan bisa diketik ulang dengan angka berbeda bulan
berikutnya, dan tidak ada yang tahu.

## Solution

Sebuah buku kas yang hanya bisa ditambah, tidak pernah diubah atau dihapus. Setiap rupiah yang
masuk dan keluar adalah satu baris bertanggal, berkategori, dan berpencatat. Kesalahan diperbaiki
dengan transaksi pembalik, bukan dengan menghapus.

Setiap bulan punya periode. Ketika laporan bulanan diterbitkan, periodenya dikunci: angka yang sudah
dibaca warga tidak bisa berubah diam-diam lagi. Kalau ternyata ada nota yang terlewat, superuser
membuka kuncinya dan menerbitkan laporan revisi bernomor dengan alasan yang terlihat semua warga.

## Goals and non-goals

**Goals**

- Setiap rupiah punya barisnya sendiri, dan baris itu tidak pernah berubah setelah dibuat.
- Saldo kas adalah hasil penjumlahan transaksi, bukan angka yang disimpan dan bisa melenceng.
- Laporan bulanan dihasilkan dari buku kas, bukan diketik.
- Laporan yang sudah dibaca warga tidak bisa berubah tanpa jejak.
- Warga bisa melihat ke mana uang komplek pergi, per kategori.
- Warga yang berlangganan menerima ringkasan laporan lewat email.
- Tidak ada warga yang dipermalukan namanya di depan warga lain karena menunggak.

**Non-goals**

- Tidak ada pembukuan berpasangan dengan akun debit dan kredit.
- Tidak ada anggaran, target, atau perbandingan rencana versus realisasi.
- Tidak ada ekspor PDF.

## User stories

1. Sebagai superuser, saya ingin mengelola kategori kas — nama dan tipenya masuk atau keluar —
   supaya kategori pengeluaran baru seperti perbaikan gerbang tidak butuh deploy.
2. Sebagai superuser, saya ingin menonaktifkan kategori yang tidak dipakai lagi tanpa menghapusnya,
   supaya transaksi lama tetap punya kategori.
3. Sebagai superuser, saya ingin sistem menolak penghapusan atau perubahan tipe kategori sistem
   "Iuran warga", karena alur verifikasi pembayaran bergantung padanya.
4. Sebagai admin, saya ingin mencatat pengeluaran — gaji satpam, kebersihan, perbaikan — dengan
   tanggal, kategori, keterangan, dan nominal.
5. Sebagai admin, saya ingin melampirkan foto nota atau kuitansi pada pengeluaran, supaya
   pengeluaran punya bukti seperti pemasukan punya bukti.
6. Sebagai admin, saya ingin mencatat pemasukan selain iuran — donasi, sewa fasilitas, sumbangan
   kegiatan.
7. Sebagai admin, saya ingin sistem menolak saya mencatat kas masuk pada kategori "Iuran warga"
   secara manual, supaya saldo kas dan status tagihan tidak bisa bertentangan.
8. Sebagai admin, saya ingin memperbaiki transaksi yang salah dengan membuat transaksi pembalik
   yang menunjuk ke transaksi aslinya, supaya koreksinya terlihat, bukan disembunyikan.
9. Sebagai admin, saya ingin melihat buku kas berurutan tanggal dengan saldo berjalan, supaya saya
   bisa mencocokkannya dengan rekening.
10. Sebagai admin, saya ingin menyaring buku kas menurut periode dan kategori.
11. Sebagai superuser, saya ingin mencatat saldo awal kas pada tanggal mulai pemakaian aplikasi,
    supaya saldo berjalan cocok dengan uang yang benar-benar ada.
12. Sebagai admin, saya ingin melihat pratinjau laporan bulan berjalan kapan saja, supaya saya tidak
    terkejut di akhir bulan.
13. Sebagai admin, saya ingin menerbitkan laporan bulanan, dan penerbitan itu mengunci periodenya.
14. Sebagai admin, saya ingin sistem menolak transaksi baru bertanggal di periode yang terkunci,
    supaya laporan yang sudah dibaca tetap benar.
15. Sebagai superuser, saya ingin membuka kunci sebuah periode dengan alasan, supaya nota yang baru
    ditemukan bisa masuk.
16. Sebagai warga, saya ingin melihat bahwa sebuah laporan adalah revisi, nomor revisinya, dan
    alasan revisinya, supaya saya tahu angka mana yang berlaku.
17. Sebagai warga, saya ingin menerima email pemberitahuan saat sebuah laporan direvisi, kalau saya
    berlangganan laporan.
18. Sebagai warga, saya ingin membuka laporan bulanan dan melihat saldo awal, rincian pemasukan per
    kategori, rincian pengeluaran per kategori, dan saldo akhir.
19. Sebagai warga, saya ingin melihat ringkasan iuran bulan itu — berapa rumah lunas, berapa belum,
    berapa yang terkumpul — tanpa melihat nama siapa pun.
20. Sebagai warga, saya ingin menelusuri satu kategori pengeluaran dan melihat transaksi apa saja di
    dalamnya, supaya angka besar bisa saya periksa sendiri.
21. Sebagai warga, saya ingin berlangganan laporan bulanan lewat email dan menerimanya setiap bulan
    tanpa membuka aplikasi.
22. Sebagai warga, saya ingin berhenti berlangganan kapan saja lewat satu tautan di email.
23. Sebagai admin, saya ingin melihat daftar rumah yang menunggak, sesuatu yang tidak muncul di
    laporan yang dilihat warga.
24. Sebagai superuser, saya ingin memicu pengiriman email laporan bulanan secara manual, supaya
    saya bisa mengujinya tanpa menunggu bulan berikutnya.

## Implementation decisions

**Buku kas satu sisi, hanya bisa ditambah.** Sebuah Transaksi Kas punya tanggal terima uang, tipe
masuk atau keluar, kategori, nominal, keterangan, lampiran opsional, pencatat, dan waktu pencatatan.
Tidak ada operasi ubah dan tidak ada operasi hapus di lapisan service — bukan sekadar tidak ada
tombolnya. Alasannya: pembukuan berpasangan lebih benar secara akuntansi, tetapi bendahara RT bukan
akuntan, dan salah memilih akun pada setiap entri lebih merusak daripada yang dicegahnya. Yang
benar-benar dibutuhkan adalah jaminan bahwa angka tidak berubah di belakang punggung warga, dan itu
datang dari sifat hanya-bisa-ditambah, bukan dari jumlah sisi.

**Koreksi adalah transaksi pembalik yang menunjuk asalnya.** Sebuah koreksi adalah Transaksi Kas
bertipe berlawanan dengan nominal yang sama, menyimpan rujukan ke transaksi yang dikoreksi dan
alasannya. Buku kas menampilkan keduanya. Alasannya: koreksi yang tidak terlihat sama saja dengan
penghapusan.

**Saldo adalah hasil penjumlahan.** Saldo kas dan saldo per periode dihitung dari transaksi, tidak
pernah disimpan sebagai kolom yang diperbarui. Kolom saldo yang diperbarui akan melenceng dari
transaksinya suatu hari, dan tidak ada cara mengetahui kapan itu terjadi.

**Kategori adalah master data dengan satu pengecualian.** Kategori punya nama, tipe, dan status
aktif. Kategori sistem "Iuran warga" dibuat oleh migrasi, tidak bisa dihapus, tidak bisa berganti
tipe, dan **tidak menerima pencatatan manual** — satu-satunya jalan uang masuk ke kategori itu
adalah verifikasi pembayaran dari spec iuran.

> [!note] Dibalik oleh run `komplek-v1`
> Pengecualiannya dua, bukan satu, dan aturannya digeneralisasi: migrasi `0009_cash_report` (#32,
> `49f3bad`) menyemai `dues` **dan** `opening-balance`, keduanya dicari lewat `SYSTEM_CATEGORY_KEY`
> dan bukan lewat nama tampilannya, dan **setiap** kategori sistem menolak pencatatan manual (#34,
> `fc4bf14`) — entri manual ke `opening-balance` akan melewati kunci baris milik #33 (`8a21da9`).
> Penghapusan tidak ditolak per kasus melainkan tidak ada sama sekali: `src/lib/server/services/cash/`
> tidak mengekspor satu pun operasi hapus kategori, dan sebuah pengujian menjaga daftar ekspornya.

**Periode adalah entitas dengan status.** Satu Periode per bulan kalender, berstatus terbuka atau
terkunci. Transaksi Kas bertanggal di dalam periode terkunci ditolak. Penerbitan laporan mengunci
periodenya. Alasannya: penguncian adalah satu-satunya hal yang membuat laporan yang sudah dibaca
punya arti.

> [!note] Dibalik oleh run `komplek-v1`
> Baris `periods` tidak ada untuk setiap bulan kalender: ia dibuat saat dibutuhkan oleh tulisan uang
> pertama di bulan itu. `requireOpenPeriodFor(transaction, clock, occurredOn)` di
> `src/lib/server/services/cash/period.ts` (#35, `cf35211`) membuat baris yang belum ada dalam
> keadaan `open` lewat penyisipan spekulatif lalu menguncinya `for share`, jadi bulan yang belum
> pernah menerima uang tidak punya baris sama sekali. Nilai statusnya tersimpan `open`/`locked`, dan
> urutan kuncinya tunggal — baris uang dulu, Periode kedua.

**Basis kas, dan dua angka yang berbeda.** Transaksi Kas bertanggal pada tanggal uang diterima atau
dikeluarkan, bukan pada periode tagihan yang dilunasinya. Akibatnya "iuran terkumpul untuk periode
Januari" dan "kas masuk bulan Januari" adalah dua angka yang berbeda, dan laporan menampilkan
**keduanya dengan label yang jelas** alih-alih memilih salah satu. Menyembunyikan salah satunya
akan membuat warga yang menjumlahkan sendiri menemukan selisih yang tidak bisa dijelaskan.

**Laporan berversi.** Sebuah Laporan Bulanan adalah terbitan dari satu Periode, punya nomor revisi,
waktu terbit, penerbit, dan alasan revisi untuk revisi kedua dan seterusnya. Angka-angkanya
dibekukan pada saat terbit sehingga laporan revisi 1 tetap bisa dibaca setelah revisi 2 ada.
Membuka kunci periode tidak menghapus laporan mana pun. Alasannya: kalau laporan ditimpa diam-diam,
penguncian periode kehilangan seluruh manfaatnya.

> [!note] Dibalik oleh run `komplek-v1`
> Yang dibekukan adalah kedelapan angka ditambah `category_breakdown` `jsonb` (satu baris per
> kategori per arah); yang **dihitung ulang saat dibaca** adalah pratinjau pengurus dan setiap baris
> transaksi di balik sebuah kategori — terpaksa, karena `monthly_reports` sengaja tidak punya kunci
> asing ke `cash_transactions`. Muatannya karena itu membawa angka beku dan angka hidup
> berdampingan dan mengatakannya ketika keduanya berbeda. Nomor revisi **diturunkan, tidak pernah
> dialokasikan** — `coalesce(max(revision), 0) + 1` dibaca sesudah `lockPeriod` memegang
> `for update`, jadi penerbitan yang gagal tidak menghabiskan nomor. #32 (`49f3bad`) dan #36
> (`8be3c03`), di `src/lib/server/services/report/`.

**Privasi penunggak.** Laporan yang dilihat warga menampilkan jumlah rumah yang lunas dan belum
lunas serta total terkumpul — tidak pernah nama. Daftar nama penunggak adalah layar terpisah yang
hanya bisa dibuka admin.

> [!note] Dibalik oleh run `komplek-v1`
> Penjagaannya lebih keras daripada yang diminta, dan itu memangkas user story 20:
> `src/lib/server/services/report/resident-payload.ts` (#36, `8be3c03`) **menolak penelusuran
> kategori sistem `dues` secara menyeluruh, untuk semua peran**, karena satu barisnya adalah
> pembayaran satu rumah dan daftarnya dibaca terhadap jumlah rumah belum lunas menjadi daftar
> penunggak lewat pengurangan. Nama penerbit laporan juga dikecualikan dari muatan warga.

**Email laporan bulanan.** Sebuah pekerjaan terjadwal, berjalan setelah periode ditutup, mengirim
ringkasan angka dan tautan ke halaman laporan kepada setiap warga yang berlangganan — bukan
lampiran. Pengiriman memakai antrean email spec fondasi sehingga ratusan penerima bisa dicoba ulang
satu per satu tanpa memblokir apa pun. Setiap email membawa tautan berhenti berlangganan yang
bekerja tanpa perlu masuk. Revisi laporan memicu email pemberitahuan kepada pelanggan yang sama.

**Saldo awal.** Dicatat sebagai satu Transaksi Kas masuk berkategori sistem tersendiri pada tanggal
mulai pemakaian, hanya boleh ada satu, dan hanya bisa dibuat superuser. Riwayat keuangan sebelum
tanggal itu tidak diimpor.

**Audit.** Penerbitan laporan, pembukaan kunci periode, koreksi, perubahan kategori, dan pencatatan
saldo awal masuk audit log spec fondasi.

## Testing decisions

- **Sifat hanya-bisa-ditambah** diuji sebagai ketiadaan jalan: lapisan service tidak menyediakan
  operasi ubah atau hapus transaksi, dan pengujian menyatakan itu, sehingga penambahan operasi
  semacam itu kelak akan menggagalkan pengujian.
- **Saldo berjalan** diuji terhadap rangkaian transaksi masuk dan keluar yang panjang, termasuk
  koreksi, dan dibandingkan dengan jumlah yang dihitung terpisah.
- **Penguncian periode** diuji dari dua arah: transaksi bertanggal di periode terkunci ditolak;
  setelah dibuka kunci, transaksi yang sama diterima.
- **Basis kas** diuji dengan skenario pembayaran terlambat: tagihan Januari dilunasi 20 Februari,
  dan pengujian membuktikan laporan Januari yang sudah terbit tidak berubah angkanya sementara kas
  masuk muncul di Februari, dan kedua angka ringkasan iuran benar.
- **Versi laporan** diuji dengan menerbitkan, membuka kunci, menambah transaksi, menerbitkan ulang,
  lalu membuktikan revisi 1 masih bisa dibaca dengan angka lamanya.
- **Kategori sistem** diuji: percobaan menghapusnya, mengubah tipenya, dan mencatat kas masuk
  manual padanya, ketiganya ditolak.
- **Privasi** diuji sebagai tabel kasus peran terhadap muatan laporan: muatan untuk warga tidak
  pernah memuat nama warga lain atau pengenal unit dalam ringkasan tunggakan.
- **Email langganan** diuji dengan jam palsu: pekerjaan bulanan mengantre tepat satu email per
  pelanggan, dan menjalankannya dua kali tidak mengantre dua kali.
- Playwright dipakai untuk satu alur: admin menerbitkan laporan, warga membukanya dan melihat
  rincian kategori.

## Success criteria

- Buku kas menampilkan transaksi berurutan tanggal dengan saldo berjalan yang cocok dengan
  penjumlahan manual.
- Tidak ada cara di antarmuka maupun di lapisan service untuk mengubah atau menghapus transaksi;
  koreksi menghasilkan dua baris yang keduanya terlihat.
- Mencatat kas masuk pada kategori "Iuran warga" secara manual ditolak.
- Menerbitkan laporan Januari mengunci periode Januari; transaksi bertanggal Januari setelah itu
  ditolak sampai superuser membuka kuncinya dengan alasan.
- Setelah dibuka kunci, ditambah transaksi, dan diterbitkan ulang, laporan tampil sebagai revisi 2
  dengan alasannya, dan revisi 1 masih bisa dibuka.
- Pembayaran tagihan Januari yang diterima pada Februari muncul sebagai kas masuk Februari, dan
  laporan Januari yang sudah terbit tidak berubah.
- Laporan yang dibuka warga tidak memuat nama penunggak; layar daftar penunggak hanya bisa dibuka
  admin.
- Warga yang berlangganan menerima satu email laporan, tertangkap Mailpit, berisi ringkasan dan
  tautan; tautan berhenti berlangganan bekerja tanpa masuk.
- Memicu pengiriman laporan dua kali tidak menghasilkan email ganda.

## Out of scope

Pembukuan berpasangan, anggaran dan realisasi, ekspor PDF, rekonsiliasi otomatis dengan mutasi
rekening bank, laporan tahunan, grafik tren lintas tahun, impor riwayat keuangan sebelum tanggal
mulai pemakaian, mata uang selain rupiah.

## Further notes

Diblokir oleh spec fondasi. Bertautan dua arah dengan spec iuran di tingkat tiket: verifikasi
pembayaran membutuhkan buku kas dan kategori sistem lebih dulu, sementara ringkasan iuran di laporan
membutuhkan tagihan lebih dulu. Peta eksekusi menetapkan urutannya, dan kedua spec kemungkinan besar
dijalankan satu sesi.
