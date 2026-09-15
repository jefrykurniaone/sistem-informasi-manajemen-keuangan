# Spec: konten - CMS kegiatan dan pengumuman

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#5](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/5) |
| Run | `komplek-v1` |
| Peta eksekusi | [#47](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/47) |
| Disalin pada | 2026-09-16 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Pengumuman komplek dan jadwal kegiatan — posyandu, kerja bakti, rapat warga, lomba 17 Agustus —
hidup di grup WhatsApp. Pesan tenggelam dalam hitungan jam, warga yang baru bergabung tidak bisa
menelusurinya, dan warga yang tidak ada di grup tidak pernah tahu. Tidak ada satu tempat pun yang
bisa dibuka untuk menjawab "kapan posyandu bulan ini".

## Solution

Sebuah papan pengumuman yang menetap. Admin menulis kegiatan dan pengumuman, menyimpannya sebagai
draf sampai siap, lalu menerbitkannya. Kegiatan punya waktu dan tempat; pengumuman tidak. Halaman
publik bisa dibuka tanpa masuk, sehingga tautannya bisa langsung dibagikan ke grup WhatsApp dan
dibuka siapa pun.

Warga yang mau diberi tahu setiap ada terbitan baru bisa menyalakannya sendiri; yang tidak mau,
tidak menerima apa pun.

## Goals and non-goals

**Goals**

- Satu tempat menetap untuk kegiatan dan pengumuman, bisa ditelusuri ke belakang.
- Bisa dibuka tanpa akun, supaya tautannya berguna di grup WhatsApp.
- Draf yang belum siap tidak terlihat siapa pun kecuali penulisnya dan admin lain.
- Kegiatan yang akan datang mudah ditemukan; yang sudah lewat tidak memenuhi layar.
- Pemberitahuan email yang bersifat memilih-masuk, bukan memilih-keluar.

**Non-goals**

- Tidak ada komentar warga.
- Tidak ada pendaftaran kehadiran.
- Tidak ada konten dua bahasa.

## User stories

1. Sebagai admin, saya ingin menulis sebuah kegiatan dengan judul, ringkasan, isi, waktu mulai dan
   selesai, serta lokasi.
2. Sebagai admin, saya ingin menulis pengumuman tanpa waktu dan tempat, karena tidak semua yang
   perlu diumumkan adalah acara.
3. Sebagai admin, saya ingin menulis isi dengan Markdown sehingga saya bisa membuat daftar dan
   menebalkan hal penting tanpa belajar HTML.
4. Sebagai admin, saya ingin melihat pratinjau tampilan sebelum menerbitkan.
5. Sebagai admin, saya ingin menyimpan tulisan saya sebagai draf dan melanjutkannya nanti.
6. Sebagai admin, saya ingin mengunggah gambar sampul, supaya tautan yang dibagikan terlihat
   menarik.
7. Sebagai admin, saya ingin memberi kategori pada terbitan — posyandu, kerja bakti, perayaan,
   rapat, umum — supaya warga bisa menyaring.
8. Sebagai admin, saya ingin menerbitkan draf, dan sejak saat itu terbitan terlihat publik.
9. Sebagai admin, saya ingin menyunting terbitan yang sudah terbit, misalnya karena jam kegiatan
   berubah.
10. Sebagai admin, saya ingin mengarsipkan terbitan yang tidak berlaku lagi tanpa menghapusnya.
11. Sebagai warga, saya ingin melihat daftar kegiatan yang akan datang di halaman depan, terurut
    dari yang paling dekat.
12. Sebagai warga, saya ingin melihat kegiatan dan pengumuman yang sudah lewat kalau saya mencarinya.
13. Sebagai warga, saya ingin menyaring menurut kategori.
14. Sebagai siapa pun tanpa akun, saya ingin membuka tautan sebuah kegiatan dan membacanya, supaya
    tautan yang dibagikan di grup berguna.
15. Sebagai siapa pun tanpa akun, saya tidak ingin melihat draf atau terbitan yang diarsipkan.
16. Sebagai warga, saya ingin menyalakan pemberitahuan email untuk terbitan baru, dan
    mematikannya kapan saja.
17. Sebagai warga, saya ingin email terbitan baru berisi judul, ringkasan, dan tautan — bukan
    seluruh isinya.
18. Sebagai admin, saya ingin melihat kapan sebuah terbitan diterbitkan dan siapa penulisnya.

## Implementation decisions

**Satu jenis entitas dengan dua tipe.** Sebuah Post bertipe `kegiatan` atau `pengumuman`. Keduanya
berbagi judul, ringkasan, isi, gambar sampul, kategori, status, penulis, dan waktu terbit; hanya
`kegiatan` yang punya waktu mulai, waktu selesai, dan lokasi. Alasannya: dua tabel yang delapan dari
sebelas kolomnya sama akan menghasilkan dua layar daftar, dua layar sunting, dan dua tempat
memperbaiki bug yang sama. Batasan bahwa `pengumuman` tidak boleh punya waktu kegiatan dipaksakan
di lapisan service.

**Tiga status, bukan bendera boolean.** `draf`, `terbit`, `arsip`. Hanya `terbit` yang terlihat
publik. Alasannya: dua boolean menghasilkan empat kombinasi yang dua di antaranya tidak punya arti.

**Isi ditulis Markdown dan dibersihkan saat ditampilkan.** Markdown diubah menjadi HTML dan disaring
dengan daftar-putih tag sebelum ditampilkan. Ini penulis tepercaya, tetapi halaman ini bisa dibuka
tanpa masuk, dan skrip yang lolos di halaman publik adalah kerugian yang tidak bisa ditarik kembali.

**Halaman publik punya dua wajah.** Rute publik hanya pernah mengembalikan Post berstatus `terbit`;
penyaringan itu dilakukan di lapisan service, bukan di komponen tampilan. Pengunjung yang belum
masuk tidak pernah melihat menu atau tautan ke bagian mana pun yang butuh akun.

**Gambar sampul lewat port penyimpanan.** Memakai `FileStore` dari spec fondasi. Berbeda dengan
bukti pembayaran, gambar sampul boleh diakses publik tanpa tautan bertanda tangan, karena halamannya
memang publik.

**Email terbitan baru bersifat memilih-masuk.** Jenis notifikasi ini dimatikan secara bawaan. Email
berisi judul, ringkasan, dan tautan, bukan seluruh isi. Alasannya: warga yang kebanjiran email
kegiatan akan berhenti membaca email dari aplikasi ini sama sekali, termasuk email laporan keuangan
yang justru penting. Penyuntingan terbitan yang sudah terbit tidak mengirim email lagi.

**Tidak ada komentar dan tidak ada pendaftaran kehadiran.** Komentar menuntut moderasi, dan moderasi
menuntut kebijakan yang belum ada; forum tanpa moderasi di komunitas tetangga berakhir sebagai
keributan yang harus diselesaikan pengurus. Pendaftaran kehadiran baru berguna kalau ada yang
memakai datanya.

## Testing decisions

- **Penyaringan status** diuji di lapisan service: permintaan publik atas daftar dan atas satu Post
  tidak pernah mengembalikan `draf` atau `arsip`, termasuk saat pengenalnya ditebak langsung.
- **Batasan tipe** diuji sebagai tabel kasus: `pengumuman` dengan waktu kegiatan ditolak, `kegiatan`
  tanpa waktu mulai ditolak, `kegiatan` dengan waktu selesai sebelum waktu mulai ditolak.
- **Pembersihan Markdown** diuji dengan muatan yang mengandung skrip dan atribut penanganan
  kejadian; keluarannya tidak boleh memuat keduanya.
- **Urutan daftar** diuji dengan kegiatan yang tersebar sebelum dan sesudah waktu sekarang memakai
  jam palsu: yang akan datang muncul lebih dulu dan terurut naik.
- **Email memilih-masuk** diuji: warga yang tidak menyalakannya tidak menerima apa pun, dan
  penyuntingan terbitan yang sudah terbit tidak mengantre email kedua.
- Playwright dipakai untuk satu alur: admin menerbitkan kegiatan, lalu peramban tanpa sesi membuka
  tautannya dan membacanya.

## Success criteria

- Admin dapat menulis, menyimpan draf, melihat pratinjau, dan menerbitkan sebuah kegiatan.
- Draf tidak dapat dibuka oleh pengunjung tanpa akun meski alamatnya ditebak.
- Halaman kegiatan yang sudah terbit dapat dibuka di peramban tanpa sesi.
- Daftar depan menampilkan kegiatan yang akan datang lebih dulu, terurut dari yang paling dekat.
- Penyaringan menurut kategori bekerja.
- Isi Markdown yang memuat skrip ditampilkan tanpa skrip itu.
- Warga yang menyalakan pemberitahuan menerima satu email berisi tautan saat terbitan baru terbit;
  warga yang tidak menyalakannya tidak menerima apa pun.
- Mengarsipkan sebuah terbitan menghilangkannya dari halaman publik tanpa menghapus datanya.
- Halaman terbaca pada lebar 390 piksel, termasuk gambar sampul.

## Out of scope

Komentar, pendaftaran kehadiran, konten dua bahasa, penjadwalan terbit di masa depan, kalender yang
bisa diunduh, notifikasi push, galeri foto kegiatan, dan berbagi otomatis ke WhatsApp.

## Further notes

Diblokir oleh spec fondasi saja. Tidak menyentuh uang, tidak menyentuh unit, dan karena itu bisa
dijalankan bersamaan dengan spec keuangan tanpa saling mengganggu.
