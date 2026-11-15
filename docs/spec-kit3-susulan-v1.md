# Spec: kit3-susulan v1 - Komentar scripts/ ke mekanisme SvelteKit 3 dan test privasi laporan yang tidak lagi flaky

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#303](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/303) |
| Run | `kit3-susulan-v1` |
| Peta eksekusi | [#304](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/304) |
| Tiket | [#301](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/301), [#302](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/302) |
| Branch integrasi | `chore/kit3-susulan-v1`, PR ke `main` yang juga memuat salinan ini |
| Pendahulu | Run `kit3-v1` (spec [#296](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/296), peta [#300](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/300)), tempat kedua masalah ditemukan |
| Disalin pada | 2026-11-15, dari `main` di `c224df1` |

## Problem statement

Run kit3-v1 (#300, ditutup 2026-11-14) menaikkan aplikasi ke SvelteKit 3. Ada dua sisa kecil yang
berada di luar permukaan tiket run itu, dan keduanya merugikan orang yang merawat repositori ini.

1. **Komentar script yang menjelaskan mekanisme lama.** Tiga komentar di script pengembang menjelaskan
   resolusi modul lewat `.svelte-kit/tsconfig.json`, cara SvelteKit 2. Ketiganya ada di shim `$app/server`,
   script pemberian superuser, dan konfigurasi tsconfig khusus seeder. Per 2026-11-15, `tsconfig.json`
   meng-extend `$app/tsconfig`, dan SvelteKit 3.2.0 tidak lagi menulis `.svelte-kit/tsconfig.json`. File
   itu yang masih ada di disk lokal adalah sisa basi. Perilakunya tidak salah: seeder dan bundel superuser
   di image produksi tetap berhasil. Yang salah adalah penjelasannya. Pengembang atau agen yang nanti
   mengubah konfigurasi itu akan bernalar dari penjelasan yang keliru. Satu komentar juga melewati batas
   100 kolom.
2. **Test privasi laporan yang kadang merah tanpa sebab.** Test privasi Laporan Bulanan menanam dua nomor
   rumah sebagai penanda, `4071` dan `9182`. Test lalu memastikan payload laporan yang diserialisasi tidak
   memuat penanda itu. Payload yang sama memuat belasan UUID acak. Kedua nomor hanya terdiri dari digit,
   jadi bisa muncul sebagai substring UUID secara kebetulan. Sekitar 0,5% run gagal karena ini. Kejadian
   nyata ada di CI run 43617685697 (PR #299, commit `96a34e5`, 2026-11-14): ID kategori
   `fe407136-cae0-4e13-a0c2-bcb9fc32e320` memuat `4071`, sehingga keenam kasus nomor rumah merah padahal
   tidak ada kebocoran. Merah palsu menghabiskan waktu pemilik untuk menyelidiki. Lebih buruk lagi, merah
   palsu melatih orang menganggap kegagalan test privasi sebagai hal biasa.

## Solution

1. Ketiga komentar diganti dengan mekanisme SvelteKit 3 yang benar, dan setiap klaimnya diperiksa terhadap
   SvelteKit yang terpasang sebelum ditulis. Konfigurasi tidak berubah sama sekali.
2. Penanda nomor rumah di test privasi diganti dengan nilai yang tidak mungkin muncul secara kebetulan di
   UUID, angka rupiah, atau timestamp. Test mendapat penjaga yang menolak penanda baru yang punya cacat
   yang sama. Kekuatan test dibuktikan sekali dengan kebocoran yang disuntikkan sementara.

Keduanya dikirim lewat satu branch integrasi dan satu pull request ke `main`.

## Goals and non-goals

**Goals**

- Tidak ada komentar di script pengembang yang menjelaskan resolusi modul lewat mekanisme SvelteKit 2.
- Setiap klaim tentang SvelteKit 3 di komentar itu benar untuk SvelteKit yang terpasang.
- Test privasi laporan tidak bisa merah karena kebetulan nilai acak.
- Test privasi laporan tetap merah bila nomor rumah, blok, atau nama warga benar-benar masuk payload.
- Penanda baru yang ditambahkan nanti dengan cacat yang sama langsung ditolak dengan pesan yang jelas.

**Non-goals**

- Menyederhanakan konfigurasi tsconfig seeder. Kalau ternyata bisa disederhanakan di SvelteKit 3,
  temuan itu dicatat sebagai issue baru.
- Mengubah test lain. Sapuan 2026-11-15 atas `tests/unit` dan `tests/e2e` tidak menemukan pola yang sama
  di tempat lain.
- Mengubah perilaku aplikasi, seeder, image produksi, atau dependensi apa pun.

## User stories

1. Sebagai pengembang yang membaca shim `$app/server`, saya ingin komentarnya menjelaskan kenapa
   `$app/server` tidak ter-resolve di bawah `bun run` dengan mekanisme SvelteKit 3, supaya saya tidak
   mencari file `.svelte-kit/tsconfig.json` yang sudah tidak dipakai.
2. Sebagai pengembang yang membaca script pemberian superuser, saya ingin tahu dengan benar kenapa folder
   `scripts/` tidak ikut di-type-check `bun run check`, supaya saya tidak menaruh logika penting di file
   yang tidak dicek gate.
3. Sebagai pengembang yang mengubah konfigurasi tsconfig seeder, saya ingin komentarnya memberi alasan
   yang benar di SvelteKit 3 tentang kenapa path ditulis manual (atau tidak memberi alasan yang sudah
   gugur), supaya saya tidak mempertahankan batasan yang sudah tidak ada.
4. Sebagai pemilik, saya ingin perubahan komentar tidak mengubah konfigurasi apa pun, supaya seeder dan
   bundel superuser di image produksi tidak berisiko rusak oleh tiket dokumentasi.
5. Sebagai pemilik, saya ingin peluang penyederhanaan konfigurasi yang ditemukan di jalan dicatat sebagai
   issue baru, supaya tiket komentar tidak melebar diam-diam.
6. Sebagai agen yang nanti membaca komentar itu, saya ingin setiap klaimnya sudah diuji terhadap SvelteKit
   terpasang, supaya saya bisa memercayainya tanpa memeriksa ulang.
7. Sebagai pemilik, saya ingin gate CI tidak merah karena kebetulan UUID acak, supaya merah berarti ada
   yang benar-benar rusak.
8. Sebagai pemilik, saya ingin test privasi laporan tetap menangkap kebocoran nomor rumah, blok, dan nama
   warga dalam bentuk apa pun, supaya privasi warga tetap dijaga test.
9. Sebagai pengembang yang menambah penanda privasi baru, saya ingin test langsung menolak penanda yang
   bisa muncul secara kebetulan di nilai acak payload, supaya cacat ini tidak terulang lewat penanda baru.
10. Sebagai pemilik, saya ingin bukti bahwa penanda baru masih menangkap kebocoran sungguhan, supaya
    perbaikan flaky tidak diam-diam melemahkan test.
11. Sebagai reviewer, saya ingin diff #302 hanya menyentuh file test privasi, supaya jelas tidak ada
    perubahan perilaku laporan.

## Implementation decisions

Semua keputusan di bawah dikonfirmasi pemilik pada 2026-11-15.

1. **Satu spec, dan #301 serta #302 dipakai ulang sebagai tiket.** Body kedua issue ditulis ulang ke
   templat tiket, dengan isi aslinya dipertahankan, lalu dijadikan sub-issue spec ini. Tidak ada tiket
   baru, dan tidak ada duplikat yang perlu ditutup. Dua spec ditolak karena hanya menambah satu salinan
   spec untuk dua perubahan yang masing-masing menyentuh satu atau tiga file.
2. **Satu branch integrasi dan satu pull request.** Run ini memakai `chore/kit3-susulan-v1`, dibuat dari
   `main`, dengan satu pull request ke `main`, sama seperti kit3-v1. Salinan spec di-commit di branch itu
   tanpa pull request docs terpisah.
3. **Mekanisme yang ditulis di komentar #301.** Per 2026-11-15, dengan `@sveltejs/kit` 3.2.0:
   - `tsconfig.json` meng-extend `$app/tsconfig`;
   - `svelte-kit sync` menulis `$app/tsconfig` ke `node_modules/$app/tsconfig.json`;
   - `compilerOptions.paths` di file itu kosong, `types`-nya `$app/types`, dan tidak ada `include`;
   - karena itu `include` ditulis eksplisit di `tsconfig.json` (`src`, `tests`, `vite.config.ts`), dan
     folder `scripts/` berada di luarnya;
   - `#lib` di-resolve lewat field `imports` di `package.json`, yang dibaca Bun sendiri;
   - `$app/server` tetap modul virtual yang hanya bisa di-resolve module loader SvelteKit.

   Executor memeriksa ulang setiap butir terhadap SvelteKit yang terpasang sebelum menulisnya. Kalau ada
   butir yang ternyata salah, yang ditulis adalah yang benar menurut pemeriksaan itu, dan selisihnya
   dilaporkan.
4. **#301 hanya mengubah komentar.** Field `"//"` di tsconfig seeder dihitung sebagai komentar. Nilai
   konfigurasi lain tidak berubah. Baris komentar yang melewati 100 kolom ikut dirapikan.
5. **Alasan yang gugur ditulis ulang atau dihapus.** Komentar tsconfig seeder sekarang beralasan bahwa path
   ditulis manual karena path warisan `.svelte-kit/tsconfig.json` relatif ke `.svelte-kit/`. Di SvelteKit 3
   tidak ada path yang diwarisi, jadi alasan itu gugur. Executor menulis alasan yang benar setelah
   mengujinya di SvelteKit terpasang, atau menghapus alasan itu kalau memang tidak ada lagi. Kalau file itu
   ternyata bisa disederhanakan, misalnya dengan meng-extend tsconfig induk, temuan itu jadi issue baru.
6. **Penanda nomor rumah memuat huruf di luar hex.** `4071` menjadi `4071K` dan `9182` menjadi `9182P`.
   Huruf `K` dan `P` tidak bisa dihasilkan UUID (hex huruf kecil), angka rupiah, tanggal, atau timestamp
   ISO (yang memuat `T` dan `Z`). Nomor rumah memang bertipe teks dan boleh memuat huruf, seperti `12A`
   yang ada di komplek. Cara lain, yaitu mengasersi bentuk ber-kutip JSON, ditolak karena lebih lemah:
   kebocoran berbentuk "QZ-4071" atau "Blok QZ No. 4071" akan lolos.
7. **Penanda blok dan nama warga tidak diubah.** `QZ`, `QX`, dan kedua nama memuat huruf besar atau spasi
   yang tidak bisa dihasilkan UUID. Per 2026-11-15, payload laporan tidak memuat string acak selain UUID:
   tidak ada file key, token, atau base64. Satu-satunya irisan dua huruf adalah `Z` di ujung timestamp, dan
   `QZ` butuh `Q` tepat sebelumnya.
8. **Penjaga di file test yang sama.** Satu kasus test memastikan setiap penanda bukan-UUID di daftar
   penanda privasi memuat minimal satu karakter yang tidak bisa dihasilkan UUID, angka rupiah, atau
   timestamp ISO. Penanda baru yang hanya digit akan langsung gagal dengan pesan yang jelas, bukan flaky.
9. **Bukti kebocoran disuntikkan sementara.** Executor #302 sementara mengubah penyusun payload laporan
   supaya memuat nomor rumah, blok, dan nama warga, lalu menjalankan test dan memastikan kasusnya merah.
   Perubahan itu dikembalikan sebelum commit, jadi diff akhir hanya menyentuh file test. Keluaran merahnya
   dikutip di laporan tiket.
10. **Lingkup #302 hanya test privasi laporan.** Sapuan 2026-11-15 memeriksa sekitar 70 asersi negatif lain
    di `tests/unit` dan `tests/e2e`, dan semuanya aman.

Tidak ada istilah baru di `CONTEXT.md` dan tidak ada ADR baru.

## Testing decisions

Test yang baik di sini memeriksa perilaku dari luar. Untuk #301, script tetap berjalan. Untuk #302, test
privasi gagal hanya bila ada kebocoran sungguhan. Seam berikut disepakati pemilik pada 2026-11-15.

| Seam | Yang ditangkap | Yang lolos |
|---|---|---|
| **S1**: gate empat perintah lokal (`check`, `lint`, `test`, `build`) di branch integrasi | Regresi tipe, format, test, dan build, termasuk penjaga baru di #302 | Flaky 0,5% tidak terlihat dari satu run, jadi buktinya adalah argumen struktural ditambah penjaga |
| **S2**: CI di pull request integrasi, dengan check `check, lint, test, build`, `audit`, `image-scan`, dan `SonarQube Cloud` | Perbedaan lingkungan CI yang tidak punya `.env`. `image-scan` membangun image produksi, termasuk bundel superuser yang memakai tsconfig seeder | Sama seperti S1 |
| **S3**: orchestrator menjalankan `bun run db:seed-dev -- --yes` dan perintah bundel superuser dari `Dockerfile` setelah #301 | Perubahan yang tanpa sengaja merusak tsconfig seeder, misalnya JSON rusak atau field hilang | Kebenaran isi komentar. Itu diperiksa orchestrator saat membaca diff, dengan membandingkan ke `node_modules/$app/tsconfig.json` |
| **S4**: bukti suntikan kebocoran oleh executor #302 | Penanda baru yang ternyata tidak lagi menangkap kebocoran sungguhan | Tidak ada, untuk lingkup ini |

Tidak ada walk Playwright dan tidak ada e2e, karena tidak ada perubahan yang terlihat oleh pengguna.

Contoh yang sudah ada di repositori: test privasi laporan sendiri dengan tabel kasusnya, dan
`tests/unit/no-em-dash.test.ts` sebagai test yang menjaga aturan atas isi repositori.

## Success criteria

- Pencarian `.svelte-kit/tsconfig` di folder `scripts/` tidak menemukan apa-apa, atau setiap sisa temuan
  memang benar untuk SvelteKit 3.
- Diff #301 hanya mengubah teks komentar dan field `"//"`. `bun run db:seed-dev -- --yes` dan perintah
  bundel superuser dari `Dockerfile` tetap berhasil.
- Tidak ada penanda di tabel kasus privasi yang hanya terdiri dari karakter hex, atau yang bisa menjadi
  substring UUID, angka rupiah, maupun timestamp di payload.
- Kasus penjaga ada dan hijau. Kasus itu merah bila sebuah penanda diganti dengan nilai yang hanya digit.
- Bukti suntikan kebocoran dikutip di laporan #302: kasus nomor rumah, blok, dan nama merah selama
  suntikan, lalu hijau setelah dikembalikan.
- Diff #302 hanya menyentuh file test privasi laporan.
- Gate empat perintah hijau di ujung branch integrasi, dan keempat check CI hijau di pull request integrasi.

## Out of scope

- Menyederhanakan atau mengubah nilai konfigurasi tsconfig seeder.
- Salinan point-in-time `docs/spec-*.md` yang masih menyebut `.svelte-kit/tsconfig.json`.
- File `.svelte-kit/tsconfig.json` basi di mesin lokal. File itu di-gitignore dan bukan isi repositori.
- Komentar di `Dockerfile` tentang bundel superuser. Per 2026-11-15 komentar itu sudah benar.
- Test lain selain test privasi laporan.
- Upgrade atau perubahan dependensi apa pun.
- Deploy. Tidak ada perubahan perilaku produksi, jadi deploy setelah merge adalah pilihan pemilik.

## Further notes

- Kedua masalah ditemukan saat run kit3-v1 (#300), Gelombang 2 (#298), dan dicatat sebagai tindak lanjut
  di luar run itu.
- #302 adalah cacat yang sudah ada sebelum kit3-v1, bukan akibat run itu.
- Kalau #301 menemukan bahwa konfigurasi seeder bisa disederhanakan, issue barunya ditautkan di laporan
  tiket.

