# Spec: audit-kerentanan v2 - Audit hijau lagi di main, dan Dependabot mengawasi dependency Bun

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#287](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/287) |
| Run | `aman-v2` |
| Peta eksekusi | [#291](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/291) |
| Tiket | #288, #289, #290 |
| Branch integrasi | `chore/aman-v2` (PR ke `main` dibuka saat run berjalan) |
| Pendahulu | [`spec-audit-kerentanan-v1.md`](spec-audit-kerentanan-v1.md): spec [#273](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/273), run `aman-v1` |
| Disalin pada | 2026-11-14, dari `main` di `c45c594` |

Ini salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang. Item di
tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Catatan penyerahan

Lintasan penutup run `aman-v2` (peta #291) menambahkan penanda *Sesudah run* pada setiap klaim yang dibalik
atau diubah bentuknya oleh tiket run ini. Tidak ada teks yang dihapus. Klaim yang ditandai:

- jumlah advisory dan keadaan `audit`, alert, dan Dependabot `bun` di *Problem statement* (#288, #289, #290);
- skema, catatan perilaku, dan versi transitif di keputusan 1 (#288);
- versi terpasang di keputusan 2 dan 3 (#288);
- bukti keempat entri ignore di keputusan 4 (#290);
- bentuk konfigurasi di keputusan 5 (#289);
- pengantaran di keputusan 9;
- hasil seam di *Testing decisions* dan hasil di *Success criteria*.

## Problem statement

Per 2026-11-14 (`main` di `c45c594`), check `audit` gagal di `main` sendiri, apa pun yang diubah sebuah
pull request. `audit` adalah required check di ruleset *Protect main*, bersama `check, lint, test,
build`, `image-scan` dan `SonarQube Cloud`, jadi tidak ada pull request yang bisa masuk.

`bun run audit` melaporkan 14 advisory di luar daftar ignore:

- `better-auth` 1.7.5, tiga advisory yang terbit 2026-11-03. Semuanya diperbaiki di 1.7.7:
  - GHSA-965c-763c-88jm (critical): OAuth state bisa dipakai sebagai Magic Link untuk masuk sebagai
    pengguna lain.
  - GHSA-r4xp-prcw-77qf (high): OAuth Proxy membuat penyerang bisa masuk sebagai pengguna lain.
  - GHSA-44jh-23m7-hpcf (low): permintaan serentak bisa melewati batas rate limit
    `@better-auth/drizzle-adapter` di PostgreSQL.
- `zod` 4.6.5, dibawa `@better-auth/core`: GHSA-mrhx-c7xc-m3w5 (high), diperbaiki di 4.6.6.
- `nodemailer` 10.0.10, dependency langsung: lima advisory moderate, diperbaiki di 10.1.4.
- `@sveltejs/kit` 2.70.3:
  - GHSA-mw6w-2fmv-pvw3 (moderate), diperbaiki di 2.70.4;
  - GHSA-pfhg-q3qv-9q6r (low, open redirect lewat `use:enhance`) dan GHSA-27mw-82g8-phjj (low, XSS
    lewat `setHeaders` saat prerender). Keduanya hanya diperbaiki di 3.0.0.
- `@sveltejs/adapter-node` 5.5.7: GHSA-rqw3-x7hx-mm3p (moderate), diperbaiki di 5.5.8.
- `deepmerge` 4.3.1: GHSA-gcqx-w48m-w2h4 (low). Belum ada versi yang diperbaiki.
- `minimatch` 10.2.6: GHSA-g3hv-75wg-m249 (moderate), diperbaiki di 11.0.1. Salinan yang masuk
  rentang hanya dibawa ESLint dan typescript-eslint.

> *Sesudah run (2026-11-14):* sebelum upgrade, `bun audit` terukur memuat 17 GHSA: dua yang sudah di-ignore dan 15
> di luar daftar ignore. Daftar di atas memang berisi 15 (3 + 1 + 5 + 3 + 1 + 1 + 1), jadi angka 14
> adalah salah hitung. Sebelas tertutup oleh upgrade #288, dan empat masuk daftar ignore beralasan
> oleh #290. Di ujung `chore/aman-v2` (`a2dd212`) `bun run audit` keluar dengan 0, dan `bun audit` tanpa
> flag hanya melaporkan enam GHSA di daftar ignore. Check `audit` di `main` hijau lagi setelah pemilik
> me-merge PR integrasi #293.

Pull request Dependabot #286 (`actions/checkout` 5.1.0 → 7.0.1 dan `sonarqube-scan-action` di job
sonar) menunggu sejak 2026-11-01 dan hanya gagal di `audit`.

Tidak satu pun dari tiga advisory `better-auth` mengenai konfigurasi aplikasi ini. Aplikasi hanya
memakai email dan kata sandi. Tidak ada magic link, OAuth, OAuth proxy, maupun plugin admin, dan rate
limiter `better-auth` menyimpan hitungannya di memory, bukan di database. Risikonya bagi pengguna
rendah. Biayanya, gate merah untuk setiap perubahan.

Alert critical terbuka sebelas hari tanpa ada yang bertindak. Workflow Security tidak punya jadwal
(keputusan run `aman-v1`, #273), dan tidak ada push ke `main` sejak 2026-10-23, jadi audit tidak
berjalan. Dependabot alerts menyala, tetapi tidak ada yang membacanya.

> *Sesudah run (2026-11-14):* alert `better-auth`, `zod`, `nodemailer`, `@sveltejs/kit` 2.70.3 dan `adapter-node` 5.5.7
> tertutup begitu #288 sampai di `main` lewat PR #293. Email untuk *Dependabot alerts* tetap langkah
> pemilik (keputusan 8). Workflow Security tetap tanpa jadwal.

Dependabot version updates hanya berjalan untuk `github-actions`. Ekosistem `bun` sengaja tidak
dimasukkan di `aman-v1`. Dependabot security updates dibiarkan mati karena tidak mendukung Bun, dan
per 2026-11-14 keadaannya masih sama. Dokumentasi GitHub menandai Bun *supported* untuk version
updates dan *not supported* untuk security updates, dan tabel ekosistem dependency graph tidak memuat
Bun sama sekali.

> *Sesudah run (2026-11-14):* `.github/dependabot.yml` kini juga memuat entri `bun`, bulanan dengan satu grup
> `minor-and-patch` (#289). Security updates tetap mati, dengan alasan yang kini tertulis di README
> bagian *Security checks*. Run pertamanya adalah seam S5, milik pemilik setelah merge ke `main`.

SonarQube Cloud sudah menganalisis setiap pull request dan push ke `main`, dan sudah jadi required
check. Per 2026-11-14 quality gate-nya OK, dengan 0 issue dan 0 hotspot. Tidak ada yang perlu
dinyalakan.

## Solution

- Dependency yang punya perbaikan dalam rentangnya dinaikkan: `better-auth` ke 1.7.23,
  `nodemailer` ke 10.5.0, `@sveltejs/kit` ke 2.70.4, `@sveltejs/adapter-node` ke 5.5.8, dan `zod`
  lewat lockfile. Sebelas advisory tertutup.
- Empat advisory tanpa perbaikan dalam rentang masuk daftar ignore audit, masing-masing dengan bukti
  bahwa advisory itu tidak terjangkau di repo ini dan syarat pencabutannya.
- Dependabot membuka satu pull request bulanan untuk update minor dan patch dependency Bun.
- Bagian *Security checks* di README menggambarkan pemeriksaan sebagaimana adanya.
- Pemilik menyalakan notifikasi email untuk Dependabot alerts.

## Goals and non-goals

**Goals**

- Keempat required check hijau di pull request integrasi, dan `audit` hijau di `main` setelah
  pemilik me-merge-nya.
- Masuk, keluar, lupa kata sandi dan pengiriman email tetap bekerja di `better-auth` 1.7.23 dan
  `nodemailer` 10.5.
- Setiap pengecualian audit tertulis dengan alasan dan syarat pencabutannya.
- Dependency Bun tidak lagi basi tanpa ketahuan.
- Dokumentasi pemeriksaan keamanan sesuai keadaan sebenarnya.

**Non-goals**

- Upgrade major, termasuk SvelteKit 3. Keputusan `aman-v1` tetap berlaku.
- Menyalakan Dependabot security updates selama GitHub belum mendukung Bun.
- Dependabot untuk ekosistem `docker`.
- Scan terjadwal (cron). Keputusan `aman-v1` dikonfirmasi ulang pada 2026-11-14.
- Perubahan konfigurasi SonarQube Cloud atau CodeQL.
- Perubahan konfigurasi `better-auth` atau fitur auth baru.
- Me-merge #286 di dalam run.

## User stories

1. Sebagai pemilik, saya ingin check `audit` di `main` hijau lagi, supaya pull request yang benar bisa
   di-merge.
2. Sebagai pemilik, saya ingin `better-auth` berada di rilis tanpa advisory yang diketahui, supaya
   hasil audit mencerminkan risiko yang nyata.
3. Sebagai warga, saya ingin tetap bisa masuk dengan akun saya setelah upgrade, supaya upgrade itu
   tidak terasa bagi saya.
4. Sebagai warga yang lupa kata sandi, saya ingin email atur ulang kata sandi tetap sampai dan
   tautannya tetap bekerja, supaya saya bisa masuk lagi.
5. Sebagai admin, saya ingin email notifikasi tetap terkirim ke alamat yang benar setelah `nodemailer`
   naik, supaya pemberitahuan iuran dan laporan tidak hilang.
6. Sebagai pemilik, saya ingin setiap advisory yang di-ignore punya bukti tidak terjangkau dan syarat
   pencabutan, supaya pengecualian tidak berubah menjadi lupa.
7. Sebagai pemilik, saya ingin Dependabot membuka paling banyak satu pull request per bulan untuk
   dependency Bun, supaya dependency tetap segar tanpa membanjiri saya.
8. Sebagai pemilik, saya ingin paket ber-pin exact tidak ikut naik di pull request grup, supaya satu
   paket yang butuh kajian tidak menahan update rutin lainnya.
9. Sebagai pemilik, saya ingin alert Dependabot sampai ke email saya, supaya advisory critical tidak
   terbengkalai berhari-hari.
10. Sebagai pengelola berikutnya, saya ingin README menjelaskan apa yang diperiksa, apa yang tidak, dan
    alasannya, supaya saya tidak merasa lebih aman daripada kenyataannya.
11. Sebagai pemilik, saya ingin pull request Dependabot yang tertahan (#286) bisa di-merge setelah
    perbaikan masuk, supaya action SonarQube tetap mutakhir.

## Implementation decisions

### 1. `better-auth` 1.7.5 → 1.7.23, tetap exact

- Pin tetap exact, sesuai aturan pin di `CLAUDE.md`.
- **Mengapa 1.7.23, bukan 1.7.7 yang minimal.** Sebelas advisory lain terbit pada 2026-11-03 dan baru
  diperbaiki mulai 1.7.16. Per 2026-11-14 advisory itu belum masuk database global yang dibaca
  `bun audit`, jadi dengan 1.7.7 audit kemungkinan merah lagi begitu datanya masuk. Keputusan dan
  alasan yang sama diambil di run `advisory-unblock` repo `inventaris-aset-ppm` pada hari yang sama.
- **Skema.** Menurut panduan upgrade 1.7 (v1.7.15), skema `account` tidak berubah dari 1.6. Kolom
  `issuer` hanya perlu dibersihkan di database yang pernah menjalankan 1.7.0 sampai 1.7.2. Repo ini
  sudah di 1.7.5, dan skema auth-nya per 2026-11-14 tidak punya kolom `issuer`, jadi tidak ada
  migrasi yang diperkirakan. Executor tetap membandingkan skema inti (`user`, `session`, `account`,
  `verification`) dari paket 1.7.5 dan 1.7.23 yang terpasang. **Perubahan skema apa pun berada di
  luar tiket.** Executor berhenti dan melapor, dan orchestrator yang memutuskan.

  > *Sesudah run (2026-11-14):* definisi tabel `user`, `session`, `account` dan `verification` di `@better-auth/core`
  > 1.7.5 dan 1.7.23 hanya berbeda di komentar bundler, dan keduanya cocok dengan
  > `src/lib/server/db/schema/auth.ts`. Tidak ada kolom `issuer` dan tidak ada migrasi. Verifikasi kedua
  > (Fable) menjalankan `diffSchema` 1.7.23 terhadap skema repo dengan hasil nol temuan (#288).
- **Catatan perilaku yang diperiksa, bukan diubah:**
  - Sejak 1.7.6, kata sandi yang melebihi panjang maksimum ditolak dengan `400 PASSWORD_TOO_LONG`
    sebelum di-hash. Aplikasi ini menetapkan panjang maksimumnya sendiri.
  - Sejak 1.7.8, atribut cookie mengikuti RFC 6265bis. Ini dicakup walk dan e2e, tidak di-diff
    dengan tangan.
  - Sejak 1.7.16, `set-phone` masuk ke statement default plugin admin. Plugin itu tidak dipakai di
    sini.
  - `sveltekitCookies` harus tetap menjadi plugin terakhir.

  > *Sesudah run (2026-11-14):* `PASSWORD_TOO_LONG` hanya baru di sign-in, dan dicek sebelum lookup email. Halaman masuk
  > memetakannya ke kalimat dan status yang sama (`login_wrongCredentials`, 400), dan limiter form action
  > tetap menghitungnya. Atribut cookie sesi tidak berubah untuk konfigurasi ini, dan penandatanganan
  > cookie identik, jadi sesi yang ada tetap berlaku. `sveltekitCookies` tetap satu-satunya plugin.
  > Temuan tambahan: sejak 1.7.23 callback `sendVerificationEmail` saat sign-up berjalan sesudah
  > transaksi commit (`queueAfterTransactionHook`), dan error-nya hanya di-log. Di 1.7.5 callback itu
  > di-await di dalam transaksi. Komentar keputusan 3 di `src/lib/server/auth.ts` diperbarui. Kodenya
  > tidak berubah (#288).
- `zod` naik ke 4.6.6 atau lebih baru lewat lockfile, sebagai dependency transitif `@better-auth/core`.

  > *Sesudah run (2026-11-14):* `zod` 4.6.7, hanya lewat lockfile. `@better-auth/utils` tidak ikut ke 1.7.23: paket itu
  > diberi versi sendiri, dan better-auth 1.7.23 mem-pin-nya exact ke 0.5.1. Hash kata sandi tetap
  > kompatibel, karena parameter scrypt dan format `salt:key` sama. `better-call` naik ke 1.4.5 dan
  > `@better-fetch/fetch` ke 1.3.3 (#288).

### 2. `nodemailer` `^10.0.10` → `^10.5.0`

- Lantai rentangnya dinaikkan, supaya versi yang rentan tidak bisa ter-resolve lagi.
- API `createTransport` dan bentuk konfigurasi SMTP tidak berubah sejak 10.0.x.
- Address parser berubah: alamat tidak lagi diambil dari teks yang diberi tanda kutip. Perubahan
  inilah perbaikan keamanannya. Penerima email di aplikasi ini berasal dari alamat email pengguna,
  bukan dari display name.

  > *Sesudah run (2026-11-14):* `nodemailer` 10.5.0. Pada walk S3, email atur ulang sampai di Mailpit dengan header `To`
  > tepat alamat pengguna (#288).

### 3. `@sveltejs/kit` `^2.70.4` dan `@sveltejs/adapter-node` `^5.5.8`

Keduanya masih dalam major yang sama. Override `cookie` milik `@sveltejs/kit` yang sudah ada tetap
dipertahankan.

> *Sesudah run (2026-11-14):* terpasang `@sveltejs/kit` 2.70.4 dan `@sveltejs/adapter-node` 5.5.8. Override `cookie`
> tidak berubah (#288).

### 4. Empat advisory masuk daftar ignore, dengan bukti

Setiap entri memakai bentuk yang sudah ada: GHSA, paket dan versinya, induk yang membawanya, alasan,
dan syarat pencabutan. Bukti awal per 2026-11-14:

| GHSA | Paket | Bukti tidak terjangkau | Dicabut saat |
|---|---|---|---|
| GHSA-pfhg-q3qv-9q6r | `@sveltejs/kit` 2.x | Advisory ini butuh form `use:enhance` di route yang menerima path berawalan `//`. Satu-satunya route catch-all berada di bawah `/api` dan `/files`, dan keduanya endpoint saja, tanpa halaman maupun form action. | Upgrade ke SvelteKit 3. |
| GHSA-27mw-82g8-phjj | `@sveltejs/kit` 2.x | Advisory ini butuh halaman yang di-prerender dengan `cache-control` dari sumber tak tepercaya. Tidak ada halaman yang di-prerender. | Upgrade ke SvelteKit 3. |
| GHSA-gcqx-w48m-w2h4 | `deepmerge` 4.3.1 | Dibawa plugin Vite Svelte dan plugin node-resolve milik adapter-node. Keduanya berjalan saat build dan hanya menggabungkan konfigurasi repo ini sendiri. | Ada versi `deepmerge` yang diperbaiki, dan induknya memakainya. |
| GHSA-g3hv-75wg-m249 | `minimatch` 10.2.6 | Hanya ESLint dan typescript-eslint yang membawa salinan dalam rentang. Keduanya alat dev yang membaca pola glob dari konfigurasi repo ini. Salinan 3.1.5 dan 5.1.9 milik `exceljs` berada di luar rentang. | Induknya menerima `minimatch` 11.0.1 atau lebih baru. |

> *Sesudah run (2026-11-14):* keempat bukti diperiksa ulang terhadap kode di ujung `chore/aman-v2`, dan keempat entri
> ditulis di `scripts/audit.ts` (#290).
>
> - Repo ini tidak punya `svelte.config.js`. Opsi SvelteKit ada inline di `vite.config.ts`, tanpa
>   `prerender`.
> - Satu-satunya kecocokan literal `deepmerge` di keluaran build adalah helper `deepmerge` milik
>   `@better-auth/core` di sebuah source map, bukan paket npm. Identifier khas paket tidak ada di
>   keluaran build.
> - Salinan `minimatch` 3.1.5 dan 5.1.9 dibawa `glob` dan `readdir-glob` di bawah `exceljs > archiver`.

**Kalau salah satu bukti gagal,** executor berhenti dan melapor. Ia tidak memasang guard dan tidak
menaikkan major. Orchestrator yang memutuskan.

### 5. Dependabot version updates untuk `bun`

```yaml
- package-ecosystem: bun
  directory: /
  schedule:
    interval: monthly
  groups:
    minor-and-patch:
      applies-to: version-updates
      patterns: ['*']
      update-types: [minor, patch]
  ignore:
    - dependency-name: '*'
      update-types: [version-update:semver-major]
    - dependency-name: better-auth
      update-types: [version-update:semver-minor, version-update:semver-patch]
    # sama untuk drizzle-orm, drizzle-kit, pg, @inlang/paraglide-js
  commit-message:
    prefix: chore
```

- **Bulanan, satu grup.** Paling banyak satu pull request per bulan, sama dengan `github-actions`.
  Efek sampingnya: pull request itu memicu workflow Security, jadi audit juga berjalan pada bulan yang
  membuka pull request. Bulan tanpa update tidak membuka pull request dan tidak menjalankan apa pun.
- **Major diabaikan.** Upgrade major diputuskan orang, bukan bot.
- **Lima paket ber-pin exact diabaikan untuk version updates** (`better-auth`, `drizzle-orm`,
  `drizzle-kit`, `pg`, `@inlang/paraglide-js`). Setiap kenaikannya butuh kajian: skema auth,
  generator migrasi, driver basis data, dan pesan yang dikompilasi. Di dalam grup, satu paket yang
  gagal akan menahan semua update rutin. Ignore-nya memakai `update-types`, supaya tidak ikut menekan
  security updates kalau suatu saat GitHub mendukung Bun.
- **Prefix `chore`**, sama dengan entri `github-actions` yang sudah ada.
- Updater Bun di Dependabot memakai Bun 1.4.2 dan bisa membaca `lockfileVersion` sampai 3. Lockfile
  repo ini per 2026-11-14 memakai `lockfileVersion` 3.

> *Sesudah run (2026-11-14):* entri `bun` ditulis dengan bentuk ini. Kelima paket ber-pin exact masing-masing menjadi
> entri `ignore` sendiri, dengan komentar berbahasa Inggris di atas setiap blok (#289). Check validasi
> `.github/dependabot.yml` milik GitHub lulus di PR #293.

### 6. Yang tetap mati, beserta alasannya

- **Dependabot security updates.** Bun belum didukung (dokumentasi GitHub, dicek 2026-11-14). Kalau
  dinyalakan, Dependabot bisa membuka pull request yang mengubah `package.json` tanpa `bun.lock`, dan
  pull request itu gagal di `--frozen-lockfile`.
- **Ekosistem `docker`.** Versi Bun di-pin exact dengan alasan tertulis (#223), dan paket OS image
  sudah diperiksa `image-scan` di setiap pull request.
- README bagian *Security checks* mencatat keduanya, beserta tanggal pengecekannya.

### 7. SonarQube Cloud tidak berubah

Konfigurasi dan workflow-nya tidak disentuh. #286 di-rebase dan di-merge oleh pemilik setelah
pull request integrasi masuk `main`.

### 8. Notifikasi alert adalah langkah pemilik

Tidak ada API yang membuka pengaturan notifikasi GitHub milik pengguna, jadi pemilik mengaturnya
sendiri: email untuk *Dependabot alerts*, dan watch repositori dengan *Custom → Security alerts*.

### 9. Pengantaran

- Branch integrasi `chore/aman-v2`, satu pull request ke `main`, di-merge oleh pemilik sesuai
  `CLAUDE.md`.
- Orchestrator me-merge setiap branch tiket ke branch integrasi dengan merge commit.

> *Sesudah run (2026-11-14):* PR integrasi adalah #293. GitHub menolak PR tanpa commit, jadi draft-nya baru dibuka
> setelah merge pertama. Merge commit di `chore/aman-v2`: `0d3e6f2` (#288), `35fff86` (#289) dan
> `a2dd212` (#290).

## Testing decisions

Tes yang baik di sini mengamati produk dari luar: hasil `bun audit`, check di pull request, halaman
masuk di browser sungguhan, dan email yang benar-benar sampai di Mailpit. Tes unit baru tidak
diwajibkan. Ini kenaikan dependency tanpa perubahan perilaku, dan tes auth serta notifikasi yang
sudah ada berjalan terhadap PostgreSQL sungguhan.

Seam yang dikonfirmasi pemilik pada 2026-11-14:

| Seam | Yang ditangkap | Yang tidak ditangkap |
|---|---|---|
| S1: gate empat perintah lokal, ditambah `bun run audit` exit 0 | regresi tipe, lint, tes unit dan integrasi (termasuk auth dan notifikasi terhadap PostgreSQL), dan advisory di luar daftar ignore | perilaku di browser |
| S2: CI di pull request integrasi, dengan keempat required check | perbedaan antara mesin lokal dan runner, image produksi, dan quality gate Sonar | perilaku di browser |
| S3: walk Playwright MCP oleh orchestrator pada build produksi | cookie sesi `better-auth` 1.7.23, alur lupa kata sandi sampai email di Mailpit, dan error di console | alur yang tidak dilewati walk |
| S4: `bun run test:e2e` | alur auth, pendaftaran, undangan dan halaman lain dari ujung ke ujung | email yang benar-benar terkirim |
| S5: run "Dependabot Updates" pertama untuk `bun` setelah merge ke `main` | konfigurasi Dependabot yang benar-benar dibaca GitHub | terjadi setelah run ditutup, jadi diserahkan ke pemilik |

> *Sesudah run (2026-11-14):*
>
> - **S1:** gate empat perintah hijau di setiap gelombang (2375 tes), dan `bun run audit` keluar
>   dengan 0 sejak `a2dd212`.
> - **S2:** CI di #293 pada `a2dd212`: keempat required check (`check, lint, test, build`, `audit`, `image-scan`, `SonarQube Cloud`) hijau. Setelah Gelombang 1 (`35fff86`) semuanya hijau kecuali `audit`, sesuai harapan peta.
> - **S3:** lulus. Email atur ulang pertama tertahan di belakang backlog email Data Contoh yang dikuras
>   20 per menit. Setelah antrean kosong, email tiba dalam 29,7 s. Satu entri console `400` berasal
>   dari login yang memang sengaja ditolak.
> - **S4:** `bun run test:e2e` lulus 48 setelah Gelombang 1 dan di tail.
> - **S5:** diserahkan ke pemilik.

Prior art: walk S4 pada #274 (run `aman-v1`) dan suite e2e di repo ini.

## Success criteria

- Di ujung branch integrasi, `bun run audit` keluar dengan 0, dan `bun audit` tanpa flag hanya
  melaporkan enam GHSA di daftar ignore: dua yang sudah ada dan empat yang baru.
- Keempat required check hijau di pull request integrasi.
- Walk S3 lulus: masuk sebagai admin dan sebagai warga, keluar, lalu lupa kata sandi sampai email
  tiba di Mailpit dan kata sandi baru bisa dipakai masuk. Console bersih.
- `bun run test:e2e` lulus.
- Konfigurasi Dependabot memuat entri `bun` dengan bentuk di keputusan 5.
- README bagian *Security checks* memuat pengaturan baru, alasan security updates dan `docker`
  tetap mati, dan batas yang masih berlaku.
- Setelah pemilik me-merge (di luar run): run "Dependabot Updates" untuk `bun` selesai dengan
  `success`, dan alert `better-auth` serta `@sveltejs/kit` 2.70.x tertutup.

> *Sesudah run (2026-11-14):* kriteria di dalam run tercapai.
>
> - `bun run audit` keluar dengan 0, dan `bun audit` hanya melaporkan enam GHSA yang di-ignore.
> - Keempat required check hijau di #293.
> - Walk S3 dan e2e lulus.
> - Konfigurasi Dependabot dan README sesuai.
>
> Kriteria sesudah merge (S5 dan penutupan alert) milik pemilik.

## Out of scope

- SvelteKit 3 dan upgrade major lainnya.
- Toggle Dependabot security updates, dan ekosistem `docker`.
- Jadwal di workflow Security.
- Konfigurasi SonarQube Cloud, CodeQL, dan workflow CI selain yang sudah ada.
- Konfigurasi atau fitur `better-auth`.
- Merge #286, merge pull request integrasi, dan deploy produksi. Semuanya langkah pemilik.

## Further notes

- Pendahulu: #273 (spec `audit-kerentanan`, run `aman-v1`), dengan salinannya di
  `docs/spec-audit-kerentanan-v1.md`.
- Prior art lintas repo: run `advisory-unblock` di `jefrykurniaone/inventaris-aset-ppm` (map #191),
  yang menyelesaikan advisory `better-auth` yang sama pada 2026-11-14.
- Langkah setelah run ditutup, semuanya milik pemilik:
  1. merge pull request salinan spec, lalu merge pull request integrasi;
  2. di #286, komentar `@dependabot rebase`, tunggu CI hijau, lalu merge;
  3. deploy produksi lewat `docs/deploy.md`, karena bundle produksi berubah;
  4. notifikasi alert (keputusan 8);
  5. seam S5 dengan `gh run list --workflow "Dependabot Updates"`.
