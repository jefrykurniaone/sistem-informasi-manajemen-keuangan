# Spec: fondasi - rangka aplikasi, autentikasi, peran, dan port keluar

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#1](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/1) |
| Run | `komplek-v1` |
| Peta eksekusi | [#47](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/47) |
| Disalin pada | 2026-09-16 |
| Lintasan penutup | 2026-09-20 — klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Belum ada apa pun. Setiap fitur yang direncanakan — iuran, buku kas, kegiatan, keluhan — butuh
rangka yang sama: aplikasi yang bisa dijalankan di laptop pengurus dengan satu perintah, cara masuk
yang aman, pembagian peran yang dipaksakan di satu tempat, dan cara mengirim email, menyimpan
berkas, serta menjalankan pekerjaan terjadwal.

Kalau rangka ini tidak ditetapkan lebih dulu, setiap fitur akan menemukan jawabannya sendiri:
tiga cara berbeda memeriksa peran, dua cara mengirim email, dan aturan uang yang tidak bisa diuji
karena terikat ke jam sistem.

## Solution

Sebuah aplikasi kosong yang sudah benar-benar hidup. `docker compose up` menyalakan aplikasi,
PostgreSQL, dan penangkap email lokal. Seorang pengguna bisa mendaftar, masuk, dan melihat halaman
beranda yang tahu siapa dirinya dan apa perannya. Belum ada satu pun fitur domain di dalamnya.

Yang ikut ditetapkan di sini adalah tiga hal yang membuat fitur-fitur berikutnya bisa diuji:
sebuah lapisan service sebagai satu-satunya tempat aturan domain tinggal, tiga port keluar
(pengirim email, penyimpan berkas, dan jam) yang bisa dipalsukan dalam pengujian, dan sebuah
penjadwal yang tidak akan menjalankan pekerjaan yang sama dua kali.

## Goals and non-goals

**Goals**

- Satu perintah menyalakan seluruh lingkungan pengembangan lokal, termasuk basis data dan
  penangkap email.
- Seorang warga bisa masuk; sesi bertahan; keluar bekerja.
- Peran diperiksa di satu tempat, bukan disebar di setiap halaman.
- Aturan domain bisa diuji tanpa HTTP dan tanpa browser.
- Waktu adalah sesuatu yang bisa dikendalikan dalam pengujian, bukan pembacaan jam sistem.
- Pekerjaan terjadwal punya kunci sehingga dua proses tidak menjalankannya bersamaan, dan bisa
  dipicu manual untuk diuji.
- Setiap perubahan peran dan setiap aksi uang punya jejak yang tidak bisa dihapus.
- Gerbang mutu berjalan otomatis di setiap pull request.

**Non-goals**

- Tidak ada fitur domain: tidak ada tagihan, tidak ada kas, tidak ada kegiatan, tidak ada keluhan.
- Tidak ada penerbitan ke internet. Aplikasi hidup di `localhost`.
- Tidak ada template email untuk fitur tertentu — hanya mekanismenya.

## User stories

1. Sebagai pengembang, saya ingin satu perintah menyalakan aplikasi, basis data, dan penangkap
   email, supaya saya tidak menghabiskan sore pertama memasang PostgreSQL.
2. Sebagai pengembang, saya ingin skema basis data berubah lewat berkas migrasi yang ikut disimpan
   di repositori, supaya basis data saya dan basis data orang lain tidak diam-diam berbeda.
3. Sebagai pengembang, saya ingin menulis pengujian aturan domain tanpa menyalakan server HTTP,
   supaya pengujian cepat dan kegagalannya menunjuk ke penyebabnya.
4. Sebagai pengembang, saya ingin memundurkan dan memajukan waktu dalam pengujian, supaya saya bisa
   menguji pekerjaan bulanan tanpa menunggu tanggal 1.
5. Sebagai pengembang, saya ingin email yang dikirim dalam pengujian tertahan dan bisa diperiksa,
   supaya tidak ada email yang benar-benar terkirim ke siapa pun selama pengembangan.
6. Sebagai warga, saya ingin masuk dengan email dan kata sandi, supaya saya bisa membuka halaman
   yang hanya untuk warga.
7. Sebagai warga, saya ingin sesi saya bertahan setelah menutup tab, supaya saya tidak masuk ulang
   setiap kali membuka aplikasi dari ponsel.
8. Sebagai warga, saya ingin bisa keluar, supaya ponsel yang saya pinjamkan tidak memberi akses ke
   akun saya.
9. Sebagai warga, saya ingin memulihkan kata sandi yang saya lupakan lewat email, supaya saya tidak
   perlu menghubungi pengurus.
10. Sebagai superuser, saya ingin peran seseorang dapat diubah, supaya pengurus yang berganti tiap
    periode bisa mengikuti.
11. Sebagai superuser, saya ingin setiap perubahan peran tercatat beserta siapa yang mengubahnya,
    supaya tidak ada yang diam-diam menaikkan haknya sendiri.
12. Sebagai warga, saya ingin halaman yang bukan hak saya menolak saya dengan jelas, bukan
    menampilkan halaman kosong atau galat.
13. Sebagai warga, saya ingin antarmuka berbahasa Indonesia, dan bisa diganti ke Inggris kalau saya
    memilihnya.
14. Sebagai warga, saya ingin aplikasi enak dipakai dari layar ponsel, karena itu satu-satunya
    perangkat yang saya pakai.

## Implementation decisions

**Bentuk aplikasi.** Monolith: satu aplikasi SvelteKit di atas Bun, satu proses, satu unit deploy.
ElysiaJS dipasang sebagai penangan rute tangkap-semua di bawah awalan `/api` dan menjadi permukaan
HTTP untuk pemanggilan dari browser dan klien lain kelak. Ini pola yang didokumentasikan Elysia
untuk SvelteKit, bukan akal-akalan.

**Seam.** Seluruh aturan domain tinggal di **lapisan service** — modul biasa yang menerima
argumen dan mengembalikan nilai, tanpa tahu apa itu HTTP. Rute Elysia dan `load`/`action` SvelteKit
sama-sama memanggil lapisan itu; tidak satu pun dari keduanya boleh menyimpan aturan. Alasannya:
aturan uang adalah bagian yang paling mahal kalau salah, dan lapisan service bisa diuji langsung
terhadap basis data nyata tanpa perantara. Alternatif yang ditolak: menaruh semua logika di Elysia
dan memanggilnya dari SvelteKit lewat klien tipe-aman in-process — itu memaksa setiap pengujian
aturan keuangan melewati lapisan HTTP untuk sesuatu yang sebenarnya fungsi murni.

**Autentikasi.** better-auth dipasang di hook server SvelteKit, bukan di Elysia. Alasannya: form
action SvelteKit butuh penanganan cookie yang disediakan plugin SvelteKit better-auth, dan memasang
dua titik autentikasi dalam satu proses menciptakan dua sumber kebenaran tentang sesi. Elysia
membaca sesi dari header lewat API better-auth yang sama. Metode masuk: email dan kata sandi dengan
verifikasi email. Sesi tersimpan di basis data.

**Peran.** Tiga peran sebagai himpunan, bukan tingkatan tunggal: `warga`, `admin`, `superuser`.
Satu orang boleh memegang lebih dari satu. Pemeriksaan hak dilakukan lewat satu fungsi penjaga di
lapisan service, sehingga sebuah service tidak bisa dipanggil tanpa memutuskan siapa pemanggilnya —
halaman dan rute hanya menerjemahkan penolakan menjadi tampilan atau kode status.

> [!note] Dibalik oleh run `komplek-v1`
> Nilai peran yang benar-benar tersimpan berbahasa Inggris — `resident`, bukan `warga`. `role` adalah
> `text` dengan check constraint atas `resident`/`admin`/`superuser` di
> `src/lib/server/db/schema/authz.ts`, dan pemicu `user_created_gets_resident_role_trigger`
> menyisipkan baris `resident` untuk setiap baris `user` baru. Ditetapkan #12 (`8210192`) lalu dikunci
> konvensi "nama di kode berbahasa Inggris" yang mendarat di `e43bde6`; keputusan "himpunan, bukan
> tingkatan tunggal" sendiri mendarat apa adanya di `src/lib/server/authz.ts`.

**Basis data dan migrasi.** PostgreSQL dengan Drizzle ORM. Perubahan skema selalu menghasilkan
berkas SQL yang ikut disimpan di repositori dan dijalankan sebagai migrasi. Sinkronisasi skema
langsung hanya untuk percobaan lokal, tidak pernah untuk data sungguhan. Nilai uang disimpan
sebagai bilangan bulat rupiah, tidak pernah sebagai bilangan pecahan; tipe uang ini beserta
pembantu formatnya ditetapkan di sini supaya spec berikutnya tidak menciptakan versinya sendiri.

**Tiga port keluar.** `Clock` (sumber waktu), `EmailSender` (pengirim email), `FileStore`
(penyimpan berkas). Ketiganya antarmuka sempit dengan satu implementasi nyata dan satu palsu untuk
pengujian. `FileStore` punya tiga operasi: simpan, buat tautan bertanda tangan, hapus —
implementasinya menulis ke disk lokal; adapter S3-compatible ditambahkan saat aplikasi benar-benar
diterbitkan. `Clock` ada karena tanpa itu, menguji penerbitan tagihan tanggal 1 dan penguncian
periode berarti mengubah jam sistem.

**Email sebagai antrean.** Email tidak dikirim langsung dari alur permintaan. Setiap email masuk ke
sebuah tabel antrean dengan status, jumlah percobaan, dan waktu kirim; seorang pekerja memprosesnya.
Alasannya: verifikasi pembayaran tidak boleh gagal hanya karena penyedia email sedang mati, dan
laporan bulanan yang dikirim ke ratusan warga butuh percobaan ulang yang bisa dilihat. Tabel
notifikasi menyimpan kolom saluran sejak awal, meski hanya email yang diisi, supaya penambahan
WhatsApp kelak tidak menuntut migrasi ulang.

> [!note] Dibalik oleh run `komplek-v1`
> Tabel notifikasi berkolom saluran itu tidak pernah dibuat. #10 (`c8b0486`) hanya membuat
> `email_queue` dengan `kind` dan `payload`, dan alasan penolakannya tertulis di
> `src/lib/server/db/schema/email.ts` — "No channel column", karena tabel itu adalah antrean email,
> bukan tabel notifikasi, dan kolom yang hanya bisa berisi `'email'` akan memindahkan konsep
> notifikasi ke tempat yang salah. Preferensi per jenis mendarat terpisah sebagai tabel
> `subscriptions` (#16, `7b96d75`) dengan registrinya di
> `src/lib/server/services/subscription/kinds.ts` (#22, `eeff273`).

**Penjadwal.** Sebuah penjadwal in-process yang, sebelum menjalankan pekerjaan apa pun, mengambil
kunci di basis data untuk pasangan nama pekerjaan dan periodenya. Dua instance yang menyala
bersamaan tidak akan menerbitkan tagihan dua kali. Setiap pekerjaan juga bisa dipicu manual oleh
superuser dari antarmuka, karena tanpa itu pengujian manual berarti menunggu tanggal 1.

**Audit log.** Satu tabel yang mencatat aktor, aksi, entitas yang disentuh, nilai sebelum dan
sesudah, dan waktu. Diisi oleh lapisan service, bukan oleh pemanggilnya. Yang wajib tercatat sejak
sekarang: setiap perubahan peran. Spec keuangan menambahkan aksinya sendiri ke tabel yang sama.

**Antarmuka.** Tailwind CSS v4 dengan shadcn-svelte, disalin ke repositori sehingga bisa diubah.
Tata letak mobile-first. Kerangka navigasi menampilkan menu sesuai peran pemakainya.

**i18n.** Paraglide JS dengan bahasa dasar Indonesia dan bahasa kedua Inggris, dipilih lewat cookie
sehingga alamat halaman tidak berawalan kode bahasa. Hanya teks antarmuka dan template email yang
diterjemahkan; konten yang ditulis pengguna tidak.

**Lingkungan lokal.** Docker Compose menyalakan tiga layanan: aplikasi, PostgreSQL, dan Mailpit.
Berkas contoh variabel lingkungan ikut disimpan; berkas asli tidak.

**Gerbang mutu.** GitHub Actions menjalankan pemeriksaan tipe, lint, pengujian, dan build pada
setiap pull request.

## Testing decisions

Pengujian yang baik di sini adalah pengujian yang menyatakan perilaku yang bisa dilihat dari luar
lapisan service: "memanggil service ini dengan pemanggil tanpa peran admin menghasilkan penolakan",
bukan "fungsi privat ini dipanggil sekali".

- **Lapisan service** diuji dengan Vitest terhadap PostgreSQL **nyata** di dalam container, bukan
  tiruan. Setiap pengujian berjalan dalam transaksi yang digulung balik, atau terhadap basis data
  yang dibersihkan, sehingga urutannya tidak penting.

  > [!note] Dibalik oleh run `komplek-v1`
  > Hanya cabang kedua yang mendarat, dan cabang pertama **dilarang**: membungkus pengujian di dalam
  > transaksi yang digulung balik tidak boleh dipakai. Yang berlaku adalah satu skema PostgreSQL
  > bersih per berkas pengujian, dengan komit sungguhan lalu `drop schema … cascade` —
  > `testDatabase()` di `src/lib/server/db/test-helpers.ts`, ditetapkan #9 (`396877f`) dan dijaga
  > lintas berkas oleh #52 (`69ecb36`).
- **Port keluar** dipalsukan: pengirim email palsu mengumpulkan pesan ke dalam larik yang bisa
  diperiksa, jam palsu bisa dimajukan, penyimpan berkas palsu menyimpan di memori.
- **Penjaga peran** diuji sebagai tabel kasus: untuk setiap kombinasi peran dan aksi, diizinkan atau
  ditolak. Ini satu pengujian berparameter, bukan dua puluh pengujian yang mirip.
- **Playwright** dipakai tipis: satu alur masuk-keluar sebagai bukti rangka benar-benar hidup.
  Aturan domain tidak diuji lewat browser.

  > [!note] Dibalik oleh run `komplek-v1`
  > Suite e2e tidak tinggal tipis: sebelas berkas dan 27 pengujian di `tests/e2e/`, termasuk alur
  > domain lewat peramban — `payments.spec.ts`, `complaints.spec.ts`, `reports.spec.ts`,
  > `invitation.spec.ts`, `registration.spec.ts`, dan serangan lintasan atas tautan bertanda tangan
  > di `file-serving.spec.ts`. Kelima spec lain memang masing-masing meminta satu alur Playwright;
  > yang membuat suite itu benar-benar bisa dijalankan dan hijau adalah #71 (`dfcbdb6`) dan #112
  > (`1635fc5`).
- Tidak ada prior art di repositori ini — spec ini yang menetapkannya, dan spec berikutnya
  mengikutinya.

## Success criteria

- `docker compose up` pada mesin bersih menghasilkan aplikasi yang bisa dibuka di peramban, dengan
  basis data termigrasi dan penangkap email siap.
- Seorang pengguna baru bisa mendaftar, menerima email verifikasi yang tertangkap Mailpit,
  memverifikasi, masuk, memuat ulang halaman dan tetap masuk, lalu keluar.
- Pemulihan kata sandi berjalan dari awal sampai akhir lewat email yang tertangkap Mailpit.
- Membuka halaman yang butuh peran `admin` sebagai `warga` menghasilkan penolakan yang terbaca
  manusia, bukan galat 500 atau halaman kosong.
- Mengubah peran seorang pengguna menghasilkan satu baris audit log berisi siapa yang mengubah, apa
  yang berubah, dan kapan.
- Sebuah pengujian dapat memajukan jam palsu dan membuktikan bahwa pekerjaan terjadwal berjalan
  tepat satu kali meski dipanggil dua kali untuk periode yang sama.
- Pemeriksaan tipe, lint, pengujian, dan build lulus pada pull request.
- Antarmuka terbaca dan bisa dipakai pada lebar 390 piksel.

## Out of scope

Penerbitan ke internet, nama domain, penyedia email produksi, adapter penyimpanan S3-compatible,
seluruh fitur domain (unit, warga, tagihan, kas, laporan, kegiatan, keluhan), masuk lewat Google
atau tautan ajaib, PWA dan notifikasi push, aplikasi mobile.

## Further notes

Spec ini memblokir seluruh spec lain dalam run `komplek-v1`. Pilihan yang dibuat di sini — lapisan
service sebagai seam, tiga port keluar, uang sebagai bilangan bulat, audit log, penjadwal berkunci —
adalah kontrak yang dipakai lima spec berikutnya; mengubahnya setelah mereka mulai berarti menulis
ulang semuanya.
