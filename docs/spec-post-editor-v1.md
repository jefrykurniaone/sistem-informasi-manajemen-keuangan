# Spec: post-editor - Editor WYSIWYG, Sampul, dan jam 24 pada Post

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#128](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/128) |
| Run | `poles-v1` |
| Peta eksekusi | [#146](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/146) |
| Riset pendukung | [docs/research-ui-ux-v1.md](./research-ui-ux-v1.md) |
| Disalin pada | 2026-09-20 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Menulis Post hari ini berarti mengetik Markdown ke kotak teks polos dan menebak hasilnya. Pengurus
yang bukan programmer tidak tahu bahwa `**tebal**` menjadi tebal, dan pratinjau baru terlihat setelah
disimpan. Sampul hanya bisa diunggah setelah draf tersimpan, dari layar lain, sehingga langkah
"tulis lalu beri gambar" terasa seperti dua pekerjaan. Waktu kegiatan diketik lewat kontrol
browser yang menampilkan AM/PM pada browser berbahasa Inggris, dan pengurus yang mengetik "7" untuk
pukul 19.00 mendapat kegiatan pagi.

## Solution

Editor apa-yang-terlihat-itulah-yang-didapat: judul, subjudul, tebal, miring, daftar, dan tautan
lewat bilah alat, hasilnya terlihat langsung saat mengetik. Sampul dipilih pada form yang sama saat
membuat maupun menyunting. Waktu mulai dan selesai kegiatan diisi lewat kotak tanggal dan kotak jam
`HH:mm` 24 jam yang selalu berarti WIB, apa pun bahasa browser.

## Goals and non-goals

**Goals**

- Pengurus tanpa pengetahuan Markdown bisa menulis Post dengan format dasar.
- Isi yang tersimpan aman ditampilkan pada halaman publik tanpa sesi: daftar-putih tag yang sudah
  ada tetap satu-satunya penyaring.
- Sampul diunggah dalam satu langkah bersama tulisan.
- Jam kegiatan selalu 24 jam dan selalu WIB.

**Non-goals**

- Tidak ada gambar di dalam badan tulisan; hanya Sampul.
- Tidak ada tabel, warna teks, atau penyisipan video.
- Tidak ada migrasi Post lama; data yang ada adalah data percobaan dan akan dihapus oleh spec
  `data-contoh`.

## User stories

1. Sebagai admin, saya ingin menebalkan kata dengan tombol atau Ctrl+B dan melihatnya tebal saat
   itu juga.
2. Sebagai admin, saya ingin membuat judul bagian, daftar berbutir, daftar bernomor, dan tautan dari
   bilah alat.
3. Sebagai admin, saya ingin isi yang saya lihat di editor sama dengan yang dilihat warga di halaman
   publik.
4. Sebagai admin, saya ingin memilih Sampul saat membuat Post baru, bukan setelah menyimpan draf.
5. Sebagai admin, saya ingin mengganti atau menghapus Sampul saat menyunting.
6. Sebagai admin, saya ingin ditolak dengan pesan jelas bila Sampul terlalu besar atau bukan gambar,
   tanpa kehilangan tulisan yang sudah saya ketik.
7. Sebagai admin, saya ingin mengisi tanggal kegiatan lewat pemilih tanggal dan jam lewat kotak
   `HH:mm`, dan `19:00` selalu berarti pukul tujuh malam WIB.
8. Sebagai admin, saya ingin ditolak bila jam saya `25:00` atau `7pm`, dengan pesan yang menyebut
   format yang benar.
9. Sebagai admin, saya ingin waktu selesai yang lebih awal dari waktu mulai ditolak, seperti
   sekarang.
10. Sebagai warga, saya ingin badan Post tampil rapi: judul bagian lebih besar, daftar menjorok,
    tautan bergaris bawah.
11. Sebagai siapa pun tanpa akun, saya tidak ingin skrip apa pun dari editor sampai ke browser saya.
12. Sebagai admin, saya ingin editor bekerja di telepon 390 piksel: bilah alat tidak melebar ke
    luar layar.

## Implementation decisions

**Tiptap sebagai editor, StarterKit versi 3.** Riset (`docs/research-ui-ux-v1.md` §6) memastikan
panduan Svelte resminya sudah memakai runes dan StarterKit 3 sudah memuat Link dan Underline, jadi
tidak ada ekstensi terpisah. Bilah alat dibangun sendiri dengan tombol shadcn: judul 2 dan 3,
tebal, miring, daftar berbutir, daftar bernomor, tautan. Editor adalah komponen Svelte yang
menyimpan HTML-nya ke sebuah kotak tersembunyi pada form, supaya aksi form yang ada tetap menerima
kiriman biasa tanpa JavaScript khusus.

**Badan tersimpan sebagai HTML tersanitasi, bukan Markdown.** Kolom badan diganti nama menjadi
`body_html` lewat migrasi; isi lama tidak dikonversi karena akan dihapus. `marked` dicabut dari
dependensi. Sanitasi memakai daftar-putih yang sudah ada di modul Markdown, dipindahkan ke modul
sanitasi tanpa penguraian Markdown, dan dijalankan saat menyimpan dan sekali lagi saat merender.
Alasannya: penulis tepercaya, tetapi halaman publik dibuka tanpa sesi, dan editor sisi klien bisa
dilewati siapa pun yang mengirim form sendiri.

**Gaya badan lewat `@tailwindcss/typography`.** Riset (§6) menemukan kelas `prose` yang sudah
dipakai tidak berefek karena plugin itu tidak terpasang. Ia dipasang dan didaftarkan pada CSS
Tailwind v4, sehingga editor dan halaman publik memakai kelas `prose` yang sama dan tampilannya
identik.

**Sampul pada form buat dan sunting.** Form menjadi multipart; aksi buat menerima berkas Sampul
bersama teks dan menyimpannya lewat `FileStore` setelah Post dibuat, memakai aturan ukuran dan tipe
yang sudah ada. Form terpisah untuk Sampul pada layar sunting dihapus. Kegagalan Sampul mengembalikan
form dengan teks yang masih terisi.

**Tanggal dan jam terpisah, digabung sebagai WIB.** Kotak tanggal memakai kontrol tanggal browser;
kotak jam memakai teks dengan `inputmode="numeric"`, pola `([01][0-9]|2[0-3]):[0-5][0-9]` (riset §4:
pola `[0-2][0-9]` menerima `29:59`), dan validasi ulang di server. Server menggabungkan keduanya
menjadi instan dengan zona komplek dari modul waktu spec `waktu-rupiah`, bukan zona server. Kontrol
`datetime-local` tidak dipakai karena tampilannya mengikuti browser dan tidak bisa dipaksa 24 jam.

**Pratinjau terpisah tidak diperlukan lagi.** Editor sudah menampilkan hasil; cerita pengguna
"pratinjau" spec konten dipenuhi oleh editor itu sendiri.

## Testing decisions

- **Sanitasi diuji di lapisan service**: HTML dengan `<script>`, atribut `onerror`, dan tautan
  `javascript:` masuk, HTML bersih keluar; tag yang diizinkan bertahan. Tes sanitasi Markdown yang
  ada diubah menjadi tes ini.
- **Penggabungan tanggal dan jam** diuji sebagai tabel kasus di service Post: `2026-09-20` +
  `19:00` menjadi instan pukul 12.00 UTC; `24:00`, `7pm`, `19:60` ditolak dengan alasan format.
- **Sampul pada aksi buat** diuji di service dengan `FileStore` palsu: berkas terlalu besar ditolak
  dan Post tetap dibuat tanpa Sampul hanya bila aturan yang ada memang begitu; ikuti aturan yang ada.
- **Editor, bilah alat, dan pengiriman form** adalah kriteria walk Playwright MCP orchestrator:
  mengetik lalu menekan tombol tebal menghasilkan `<strong>` pada halaman publik setelah terbit.
- E2e `tests/e2e/posts-public.spec.ts` yang mengemudikan form Post diperbarui, karena mengubah form
  memecahkannya (gotcha wave 12).
- Prior art: `tests/unit/markdown-sanitize.test.ts`, `tests/unit/post-service.test.ts`,
  `tests/unit/ports-file-store.test.ts`.

## Success criteria

- Form Post tidak memuat kotak Markdown; ia memuat editor dengan bilah alat dan kotak Sampul.
- Menerbitkan Post dengan teks tebal dan daftar menampilkannya sebagai tebal dan daftar di halaman
  publik, dengan gaya `prose` yang terlihat.
- Skrip yang disisipkan lewat kiriman form langsung tidak pernah sampai ke halaman publik.
- Kotak jam menerima `19:00`, menolak `7pm`; kegiatan tersimpan pada instan WIB yang benar.
- `marked` tidak ada di dependensi; `@tailwindcss/typography` ada.
- Empat perintah gerbang lulus.

## Out of scope

- Gambar di badan tulisan, galeri, video.
- Riwayat versi tulisan.
- Penjadwalan terbit otomatis.

## Further notes

Spec ini menyentuh `package.json` dan skema; tiket yang melakukannya bersifat run-exclusive dan
mendarat sebelum tiket UI-nya. Ia mengimpor modul waktu spec `waktu-rupiah`.
