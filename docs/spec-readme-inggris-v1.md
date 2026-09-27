# Spec: readme-inggris - README berbahasa Inggris dengan klaim yang diperbarui

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#239](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/239) |
| Run | `huni-v1` |
| Peta eksekusi | [#247](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/247) |
| Disalin pada | 2026-09-27 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

`README.md` adalah pintu pertama ke repositori ini, tetapi seluruhnya berbahasa Indonesia, jadi pengembang atau peninjau yang tidak membaca bahasa Indonesia tidak bisa memakainya. Selain itu, per 2026-09-27 sebagian isinya sudah tidak benar:

- Bagian *Status* menyebut "Belum ada satu pun fitur domain — tidak ada tagihan, kas, kegiatan, atau keluhan". Kenyataannya aplikasi sudah memuat iuran dan Tagihan, Pembayaran dan verifikasinya, buku kas dan Laporan Bulanan, Post, Keluhan, impor warga, pemberitahuan, pekerjaan terjadwal, dan sebuah deploy fase uji.
- Catatan di bawah tabel *Stack* menyebut ElysiaJS, Drizzle ORM, better-auth, dan Paraglide JS "belum terpasang". Keempatnya sudah menjadi dependensi.
- Bagian *Konvensi* menyebut port `EmailSender`, `FileStore`, dan `Clock` "akan tinggal" di bawah lapisan server dan "tempatnya sengaja dikosongkan". Port-port itu sudah ada.
- Bagian *Data Contoh* menyebut baris `Internal error: directory mismatch` hanya muncul di Windows. Baris itu juga muncul di Linux, dan tetap tidak berbahaya.

Kalau README diterjemahkan apa adanya, hasilnya README berbahasa Inggris yang tetap salah, dan pembaca bahasa Inggris tidak punya salinan asli untuk dijadikan pembanding.

## Solution

README ditulis ulang dalam bahasa Inggris, dan klaim yang basi diperbaiki dalam langkah yang sama. Struktur bagian dan muatan operasionalnya tetap: menjalankan di lokal, superuser pertama, Data Contoh, gerbang mutu, konvensi, dan daftar dokumen. Istilah domain memakai nama Inggris dari glosarium, dengan istilah Indonesianya pada kemunculan pertama. Hanya README yang pindah bahasa; aturan bahasa di dalamnya menyebut dengan jelas dokumen mana yang tetap berbahasa Indonesia.

## Goals and non-goals

**Goals**

- Pembaca bahasa Inggris bisa menjalankan aplikasi di lokal, membuat superuser pertama, mengisi Data Contoh, dan menjalankan gerbang mutu hanya dari README.
- Setiap klaim faktual di README benar terhadap keadaan repositori saat tiket dikerjakan.
- Istilah di README cocok dengan nama di kode, sehingga pembaca bisa langsung mencarinya.

**Non-goals**

- Menerjemahkan `CONTEXT.md`, spec, `docs/deploy.md`, atau dokumen lain.
- Mengubah bahasa antarmuka.
- Menambah bagian baru yang belum ada, seperti panduan kontribusi atau arsitektur panjang.

## User stories

1. Sebagai pengembang yang tidak membaca bahasa Indonesia, saya ingin README berbahasa Inggris, supaya saya bisa memahami tujuan aplikasi dan cara menjalankannya.
2. Sebagai pengembang baru, saya ingin bagian Status menggambarkan fitur yang benar-benar ada, supaya saya tidak mengira aplikasi ini masih rangka kosong.
3. Sebagai pengembang baru, saya ingin tabel Stack tanpa catatan "belum terpasang" yang keliru, supaya saya tahu pustaka mana yang sungguh dipakai.
4. Sebagai pengembang, saya ingin setiap perintah di README ada di `package.json`, supaya saya bisa menyalin perintah itu tanpa galat.
5. Sebagai pengembang, saya ingin istilah domain di README memakai nama Inggris yang sama dengan kode, dengan istilah Indonesia dalam kurung, supaya saya bisa mencocokkan README dengan kode dan dengan antarmuka.
6. Sebagai pengembang, saya ingin peringatan tentang perintah Data Contoh yang menghapus seluruh isi basis data tetap menonjol, supaya saya tidak menjalankannya di basis data yang salah.
7. Sebagai pengembang, saya ingin aturan bahasa di README menyebut dengan jelas dokumen mana yang berbahasa Inggris dan mana yang tetap berbahasa Indonesia, supaya saya tidak mengira seluruh dokumen harus diterjemahkan.
8. Sebagai pengembang, saya ingin bagian Documents menandai tautan yang berbahasa Indonesia, supaya saya tahu apa yang akan saya buka.
9. Sebagai penulis tes e2e, saya ingin rujukan ke bagian "Data Contoh" di komentar tes tetap bisa ditemukan di README, supaya komentar itu tidak menunjuk ke bagian yang hilang.

## Implementation decisions

- **Hanya README.** Aturan bahasa di bagian konvensi README ditulis ulang:
  - README berbahasa Inggris.
  - Kode berbahasa Inggris.
  - Antarmuka berbahasa dasar Indonesia.
  - `CONTEXT.md`, spec, dan runbook deploy tetap berbahasa Indonesia.
  - Kosakata baru tetap ditambahkan ke `CONTEXT.md` lebih dulu.
- **Struktur bagian dipertahankan**, dengan judul dalam bahasa Inggris: pembuka, Status, Stack, menjalankan di lokal (beserta superuser pertama dan Data Contoh), gerbang mutu, konvensi, dan dokumen.
- **Istilah domain** memakai nama di kode dari tabel *Nama di kode* di `CONTEXT.md` (misalnya Invoice, Payment, CreditBalance, PrimaryOccupant, SeedData), dengan istilah Indonesianya dalam kurung pada kemunculan pertama.
  - Judul bagian Data Contoh memuat frasa "Data Contoh" (misalnya "Seed data (Data Contoh)"), karena dua komentar tes e2e merujuk ke bagian itu dengan nama tersebut.
  - Nama peran (`resident`, `admin`, `superuser`), nilai status, dan teks antarmuka yang dikutip tetap persis seperti di aplikasi.
- **Klaim yang diperbarui** paling sedikit empat yang disebut di *Problem statement*.
  - Status menggambarkan fitur yang ada, diperiksa terhadap rute dan layanan.
  - Setiap angka di bagian Data Contoh (jumlah Unit, Warga, Tagihan, Pembayaran, saldo, dan seterusnya) diperiksa terhadap skrip Data Contoh. Angka yang tidak cocok diperbaiki, bukan disalin.
- **Setiap perintah dan alamat** diperiksa terhadap `package.json`, `.env.example`, dan compose pengembangan.
- **Bagian Documents** tetap menautkan folder spec, tracker, glosarium, dan runbook deploy, masing-masing ditandai "(in Indonesian)" bila memang berbahasa Indonesia.

## Testing decisions

- Tidak ada seam kode. Gerbangnya `bun run lint`, karena Prettier memeriksa Markdown.
- Orchestrator membaca diff dan mencocokkan setiap klaim README dengan repositori: perintah dengan `package.json`, porta dengan `.env.example`, angka Data Contoh dengan skrip semainya, dan daftar fitur dengan rute yang ada.

## Success criteria

- README berbahasa Inggris. Bahasa Indonesia hanya muncul pada istilah domain dalam kurung, nama bagian "Data Contoh", dan teks antarmuka yang dikutip.
- Tidak ada lagi klaim bahwa fitur domain belum ada, bahwa pustaka di tabel Stack belum terpasang, bahwa port keluar belum ada, atau bahwa baris `directory mismatch` hanya muncul di Windows.
- Setiap perintah `bun run …` di README ada di `package.json`.
- Setiap angka di bagian Data Contoh cocok dengan skrip Data Contoh.
- Komentar tes e2e yang merujuk ke bagian "Data Contoh" di README masih menemukan bagian itu.
- `bun run lint` lulus.

## Out of scope

- Menerjemahkan dokumen lain: `CONTEXT.md`, spec, `docs/deploy.md`, dan `docs/agents/issue-tracker.md`.
- Mengubah bahasa antarmuka atau katalog pesan.
- Perubahan perilaku Masa Huni dan Penanggung Jawab. Itu spec `penghuni` di run yang sama; README tidak membahasnya.

## Further notes

- Semua klaim basi di atas dicatat per 2026-09-27. Tiket memeriksa ulang keadaan repositori saat dikerjakan.
