# Sistem Informasi dan Manajemen Keuangan Komplek

Konteks tunggal untuk satu komplek perumahan: rumah dan penghuninya, iuran dan kas, kegiatan, dan
keluhan warga. Berkas ini adalah glosarium — bahasa kanonik yang dipakai di kode, antarmuka, dan
percakapan. Ia bukan spesifikasi dan tidak memuat keputusan implementasi.

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

## Iuran

**Tarif**:
Besaran iuran bulanan beserta tanggal mulai berlakunya. Yang sudah dipakai menagih tidak berubah
lagi.
_Hindari_: rate, harga

**Tagihan**:
Kewajiban satu Unit untuk satu Periode, dengan besaran yang dibekukan saat terbit.
_Hindari_: bill, invoice, iuran — "iuran" adalah konsepnya, Tagihan adalah dokumennya

**Pembayaran**:
Satu setoran uang dari seorang Warga, dengan bukti dan status menunggu, terverifikasi, atau ditolak.
_Hindari_: setoran, transfer

**Alokasi**:
Pemetaan sebagian nilai sebuah Pembayaran ke satu Tagihan.
_Hindari_: pelunasan, pencocokan

**Saldo Titipan**:
Bagian Pembayaran terverifikasi sebuah Unit yang belum dialokasikan ke Tagihan mana pun. Milik Unit,
bukan milik orang.
_Hindari_: deposit, kelebihan bayar, uang muka

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

**Keluhan**:
Laporan seorang Warga tentang sesuatu yang perlu ditangani pengurus, dengan status yang bergerak
dari baru sampai selesai.
_Hindari_: tiket, isu, aduan, komplain

**Tanggapan**:
Pesan pada sebuah Keluhan, dari pelapor atau dari pengurus.
_Hindari_: komentar, balasan

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
