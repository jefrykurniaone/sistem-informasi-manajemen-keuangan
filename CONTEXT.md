# Sistem Informasi dan Manajemen Keuangan Komplek

Konteks tunggal untuk satu komplek perumahan: rumah dan penghuninya, iuran dan kas, kegiatan, dan
keluhan warga. Berkas ini adalah glosarium — bahasa kanonik yang dipakai di kode, antarmuka, dan
percakapan. Ia bukan spesifikasi dan tidak memuat keputusan implementasi.

Istilah di bawah adalah bahasa Indonesia, dan itu adalah bahasa antarmuka, spesifikasi, dan
percakapan. **Kode ditulis dalam bahasa Inggris** — nama variabel, fungsi, tipe, tabel, kolom, dan
berkas. Bagian [Nama di kode](#nama-di-kode) di akhir berkas ini memetakan setiap istilah ke satu
nama Inggris, dan pemetaan itu mengikat: sebuah tiket yang memakai nama Inggris di luar tabel itu
sedang menciptakan konsep baru dan harus berhenti. Daftar _Hindari_ pada tiap istilah berlaku untuk
prosa Indonesia dan teks antarmuka, bukan untuk nama di kode.

## Rumah dan orang

**Unit**:
Satu rumah di komplek, diidentifikasi oleh kombinasi blok dan nomor. Pemegang Tagihan dan Saldo
Titipan. Tidak pernah dihapus, hanya dinonaktifkan.
_Hindari_: properti, kavling, KK, rumah (dalam nama kode)

**Warga**:
Seorang yang punya akun di aplikasi ini.
_Hindari_: user, member, penduduk

**Masa Huni**:
Hubungan berperiode antara seorang Warga dan sebuah Unit, dengan peran huni pemilik atau penyewa.
_Hindari_: kepemilikan, okupansi

**Penanggung Jawab**:
Satu Masa Huni aktif per Unit yang ditandai sebagai penerima email tagihan rumah itu.
_Hindari_: kepala keluarga, pemilik

**Undangan**:
Tautan berbatas waktu dan sekali pakai yang memungkinkan seorang Warga menetapkan kata sandinya
sendiri dan mulai memakai aplikasi.
_Hindari_: token, invite

**Pendaftaran**:
Permintaan seseorang yang belum terdaftar untuk masuk, menyebut nama, email, serta blok dan nomor
rumah yang diklaimnya, dan menunggu persetujuan Superuser sebelum memberi akses apa pun.
_Hindari_: registrasi, sign-up, permohonan

## Iuran

**Tarif**:
Besaran iuran bulanan beserta tanggal mulai berlakunya. Yang sudah dipakai menagih tidak berubah
lagi.
_Hindari_: rate, harga

**Tagihan**:
Kewajiban satu Unit untuk satu Periode, dengan besaran yang dibekukan saat terbit.
_Hindari_: bill, invoice, iuran — "iuran" adalah konsepnya, Tagihan adalah dokumennya

**Pembayaran**:
Satu setoran uang dari seorang Warga, dengan cara bayar transfer atau tunai, bukti, dan status
menunggu, terverifikasi, atau ditolak.
_Hindari_: setoran, transfer

**Alokasi**:
Pemetaan sebagian nilai sebuah Pembayaran ke satu Tagihan.
_Hindari_: pelunasan, pencocokan

**Saldo Titipan**:
Bagian Pembayaran terverifikasi sebuah Unit yang belum dialokasikan ke Tagihan mana pun. Milik Unit,
bukan milik orang.
_Hindari_: deposit, kelebihan bayar, uang muka

**Pengembalian**:
Pengeluaran kas yang mengembalikan Saldo Titipan sebuah Unit kepada Warganya, sebagian atau
seluruhnya. Milik Unit, bukan milik orang.
_Hindari_: refund, restitusi, penarikan

**Pembebasan**:
Periode ketika sebuah Unit tidak diterbitkan Tagihan.
_Hindari_: bebas iuran, exempt

**Menunggak**:
Keadaan sebuah Tagihan yang belum lunas dan sudah lewat jatuh tempo.
_Hindari_: nunggak, tertunggak, delinquent

## Kas dan laporan

**Transaksi Kas**:
Satu baris buku kas, bertanggal pada saat uang benar-benar diterima atau dikeluarkan. Tidak pernah
diubah dan tidak pernah dihapus.
_Hindari_: jurnal, entri, mutasi

**Kategori Kas**:
Penggolongan sebuah Transaksi Kas, bertipe masuk atau keluar. "Iuran warga" adalah Kategori Kas
sistem yang hanya bisa diisi lewat verifikasi Pembayaran.
_Hindari_: akun, pos, COA

**Koreksi**:
Transaksi Kas pembalik yang menunjuk transaksi yang dikoreksinya. Satu-satunya cara memperbaiki
kesalahan pencatatan.
_Hindari_: edit, revisi transaksi, pembatalan

**Periode**:
Satu bulan kalender buku kas, berstatus terbuka atau terkunci.
_Hindari_: bulan buku, siklus

**Laporan Bulanan**:
Terbitan bernomor revisi dari satu Periode, dengan angka yang dibekukan saat terbit.
_Hindari_: rekap, laporan kas

## Konten dan keluhan

**Post**:
Satu terbitan pada papan pengumuman, bertipe kegiatan atau pengumuman.
_Hindari_: artikel, berita, konten

**Sampul**:
Satu berkas gambar yang mewakili sebuah Post pada daftar dan halaman detailnya. Paling banyak satu
per Post, dan bukan bagian dari badan tulisan.
_Hindari_: thumbnail, banner, cover (dalam prosa)

**Keluhan**:
Laporan seorang Warga tentang sesuatu yang perlu ditangani pengurus, dengan status yang bergerak
dari baru sampai selesai.
_Hindari_: tiket, isu, aduan, komplain

**Tanggapan**:
Pesan pada sebuah Keluhan, dari pelapor atau dari pengurus.
_Hindari_: komentar, balasan

**Lampiran**:
Berkas gambar yang disertakan pada sebuah Keluhan, dibuka lewat tautan bertanda tangan berumur
pendek. Paling banyak tiga per Keluhan.
_Hindari_: attachment, foto

**Riwayat Status**:
Catatan setiap perpindahan status sebuah Keluhan, berisi status lama, status baru, pelaku, waktu,
dan catatan.
_Hindari_: log keluhan, timeline

## Peran dan pemberitahuan

**Warga** *(peran)*:
Peran yang hanya dapat mengurus miliknya sendiri: tagihan rumahnya, pembayarannya, keluhannya, dan
langganannya.

**Admin** *(peran)*:
Peran pengurus harian: mengelola Post, menangani Keluhan, mencatat Transaksi Kas, memverifikasi
Pembayaran, dan menerbitkan Laporan Bulanan.
_Hindari_: pengurus, bendahara — keduanya sebutan di dunia nyata, bukan peran di sistem

**Superuser** *(peran)*:
Peran yang memegang setiap tindakan yang mengubah masa lalu atau mengubah siapa boleh apa: mengelola
Warga dan peran, Unit dan Masa Huni, Tarif, Pembebasan, pembatalan Tagihan, dan pembukaan kunci
Periode.

**Langganan**:
Pilihan seorang Warga untuk menerima atau tidak menerima satu jenis pemberitahuan.
_Hindari_: subscribe, preferensi

**Audit Log**:
Catatan yang tidak bisa dihapus tentang siapa melakukan apa, kapan, dan nilai apa yang berubah.
_Hindari_: riwayat, log aktivitas

## Layar dan alat bantu

**Beranda**:
Halaman pertama yang dilihat seseorang setelah masuk: ringkasan angka dan tautan yang paling
relevan untuk perannya, bukan daftar fitur.
_Hindari_: home, landing, dashboard (dalam prosa)

**Template Impor**:
Berkas contoh yang diunduh dari aplikasi, berisi kepala kolom dan baris contoh, untuk diisi lalu
diunggah pada impor Warga.
_Hindari_: format, contoh berkas

**Data Contoh**:
Isi basis data buatan untuk satu bulan kalender yang dipakai mencoba aplikasi, dibuat oleh satu
perintah yang menghapus seluruh isi sebelumnya. Tidak pernah dipakai pada basis data produksi.
_Hindari_: dummy, seed (dalam prosa), fixture

## Nama di kode

Satu istilah, satu nama Inggris. Kolom **Tipe** adalah nama tipe dan model Drizzle dalam
`PascalCase`; kolom **Tabel** adalah nama tabelnya dalam `snake_case` — Drizzle menurunkan nama
kolom dari nama properti lewat `casing: 'snake_case'`, jadi nama kolom tidak ditulis dua kali.

| Istilah | Tipe | Tabel |
| --- | --- | --- |
| Unit | `Unit` | `units` |
| Warga | `Resident` | `residents` |
| Masa Huni | `Occupancy` | `occupancies` |
| Penanggung Jawab | `PrimaryOccupant` | penanda pada `occupancies` |
| Undangan | `Invitation` | `invitations` |
| Pendaftaran | `Registration` | `registrations` |
| Tarif | `DuesRate` | `dues_rates` |
| Tagihan | `Invoice` | `invoices` |
| Pembayaran | `Payment` | `payments` |
| Alokasi | `Allocation` | `allocations` |
| Saldo Titipan | `CreditBalance` | dihitung, tanpa tabel |
| Pengembalian | `Refund` | `refunds` |
| Pembebasan | `Exemption` | `exemptions` |
| Transaksi Kas | `CashTransaction` | `cash_transactions` |
| Kategori Kas | `CashCategory` | `cash_categories` |
| Koreksi | `Correction` | penanda pada `cash_transactions` |
| Periode | `Period` | `periods` |
| Sampul | `CoverImage` | penanda pada `posts` |
| Beranda | `Dashboard` | dihitung, tanpa tabel |
| Template Impor | `ImportTemplate` | berkas, tanpa tabel |
| Data Contoh | `SeedData` | perintah, tanpa tabel |
| Laporan Bulanan | `MonthlyReport` | `monthly_reports` |
| Post | `Post` | `posts` |
| Keluhan | `Complaint` | `complaints` |
| Tanggapan | `ComplaintReply` | `complaint_replies` |
| Lampiran | `ComplaintAttachment` | `complaint_attachments` |
| Riwayat Status | `ComplaintStatusChange` | `complaint_status_changes` |
| Langganan | `Subscription` | `subscriptions` |
| Audit Log | `AuditEntry` | `audit_log` |

Kata yang bukan benda dan tidak punya tabel:

| Istilah | Nama di kode |
| --- | --- |
| iuran (konsepnya, bukan dokumennya) | `dues` |
| menunggak | `overdue` |
| status Pembayaran menunggu, terverifikasi, dan ditolak | `pending`, `verified`, `rejected` |
| cara bayar transfer dan tunai | `transfer`, `cash` |
| pembatalan Tagihan | `void` |
| komplek | `complex` |
| peran Warga, Admin, Superuser | `resident`, `admin`, `superuser` |
| tipe Post kegiatan dan pengumuman | `event`, `announcement` |
| status Post draf, terbit, dan arsip | `draft`, `published`, `archived` |
| status Keluhan baru, ditinjau, dikerjakan, selesai, ditolak, dan ditarik | `new`, `reviewing`, `working`, `resolved`, `rejected`, `withdrawn` |
| visibilitas Keluhan pribadi dan umum | `private`, `public` |
| tipe Kategori Kas masuk dan keluar | `income`, `expense` |
| status Periode terbuka dan terkunci | `open`, `locked` |
| kategori sistem Iuran warga dan saldo awal | `dues`, `opening-balance` |

**`Rupiah` tidak diterjemahkan.** Ia satuan mata uang sungguhan, bukan istilah domain lokal, dan
menamainya `Money` menghapus fakta bahwa ia bilangan bulat tanpa satuan pecahan. Lihat
`src/lib/money.ts`.

Dua catatan supaya pemetaan ini tidak dibaca terbalik:

- **`Invoice` untuk Tagihan**, meski daftar _Hindari_ pada Tagihan menyebut "invoice". Larangan itu
  ditulis untuk prosa Indonesia, tempat "invoice" bersaing dengan "tagihan" dan "iuran" sekaligus.
  Di kode berbahasa Inggris `Invoice` justru kata yang tepat untuk dokumen yang membekukan satu
  besaran untuk satu Unit pada satu Periode. Hal yang sama berlaku untuk `CreditBalance` terhadap
  "deposit" dan `Complaint` terhadap "tiket".
- **Nama tabel berbentuk jamak, nama tipe berbentuk tunggal.** `residents` menampung banyak
  `Resident`.
