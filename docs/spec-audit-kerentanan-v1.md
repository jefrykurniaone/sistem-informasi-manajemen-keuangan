# Spec: audit-kerentanan - Dependency bebas kerentanan yang diketahui, dan CI menolak yang baru

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#273](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/273) |
| Run | `aman-v1` |
| Peta eksekusi | [#278](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/278) |
| Tiket | #274, #275, #276, #277, #281 (ditambahkan sebagai Gelombang 4) |
| Branch integrasi | `chore/audit-kerentanan` (PR [#280](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/pull/280) ke `main`) |
| Disalin pada | 2026-10-23, dari `main` di `9f84469` |
| Lintasan penutup | 2026-10-23, sesudah Gelombang 4 (`8c5fe6c`) |

Ini salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang. Item di
tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

Lintasan penutup menambahkan penanda *Sesudah run* di bawah garis pada setiap klaim yang dibalik atau
diubah bentuknya oleh tiket run ini. Tidak ada teks yang dihapus. Klaim yang ditandai:

- jumlah advisory `bun audit`, CI yang tidak memeriksa kerentanan, dan action yang dirujuk dengan tag di *Problem statement* (#274, #275, #276, #277);
- versi `sanitize-html` di keputusan 1: 2.18.1, bukan 2.18.0 (#274);
- `lockfileVersion` dan bentuk override di keputusan 2 (#274);
- bentuk daftar ignore di keputusan 4: data, bukan komentar, dan dicetak ke log (#276);
- jalur pemasangan Trivy di keputusan 6, dan temuan pertama `image-scan` yang melahirkan #281 (#277, #281);
- jalur gagal `image-scan` dan akun walk di *Testing decisions*;
- isi `/reports` pada walk di *Success criteria*;
- nama check persis untuk branch protection di *Further notes*.

---

## Problem statement

Pemilik ingin tahu apakah aplikasi ini terkena kerentanan yang sudah diketahui publik, dan ingin CI
menolak kerentanan baru. Per 2026-10-23, pada `main` di `9f84469`:

- **`bun audit` melaporkan 23 advisory: 6 high, 13 moderate, 4 low.** Dua di antaranya sampai ke
  runtime produksi:
  - `devalue` 5.9.2, dibawa SvelteKit dan Svelte, dipakai server untuk menyerialisasi data `load`.
    Empat advisory high-nya berupa denial of service.
  - `sanitize-html` 2.17.7, penyaring isi Post. Tiga advisory-nya termasuk bypass XSS.
- **Sisanya tidak sampai ke produksi.** Paket-paket itu hanya ada di jalur dev server, build atau
  test (vite, esbuild, source-map-js, postcss-selector-parser, @vitest/mocker). Atau paketnya ada di
  runtime, tetapi jalur kode yang rentan tidak dipanggil aplikasi (`cookie` di SvelteKit, `uuid` di
  exceljs).

  > *Sesudah run (2026-10-23):* sejak #274, `bun audit` tanpa flag melaporkan tepat dua advisory,
  > GHSA-67mh-4wv8-2f99 dan GHSA-rj75-hqrm-r3gf, dan keduanya ada di daftar ignore beralasan
  > `scripts/audit.ts` (#276). `bun run audit` keluar dengan 0.

- **CI tidak memeriksa kerentanan sama sekali.** Workflow "Quality gate" hanya menjalankan `check`,
  `lint`, `test` dan `build`. Ke-23 advisory di atas masuk tanpa terlihat, dan advisory berikutnya
  akan masuk dengan cara yang sama.

  > *Sesudah run (2026-10-23):* workflow Security (`.github/workflows/security.yml`) menjalankan job
  > `audit` (#276) dan `image-scan` (#277) di setiap pull request, push ke `main` dan
  > `workflow_dispatch`.

- **Pengaturan keamanan GitHub repo public ini mati semua**, dan branch `main` tidak diproteksi.
  Pengaturan yang mati adalah Dependabot alerts, secret scanning, push protection dan CodeQL.
- **Action di workflow dirujuk dengan tag** (`actions/checkout@v5`, `oven-sh/setup-bun@v2`). Tag
  bisa dipindahkan ke kode lain oleh pemiliknya, atau oleh penyerang yang membobol akun pemiliknya.
  Contohnya `aquasecurity/trivy-action` pada 19 Maret 2026: 76 dari 77 tag versinya dipindah ke
  malware pencuri secret CI (CVE-2026-33634).

  > *Sesudah run (2026-10-23):* setiap action di setiap workflow dirujuk dengan SHA commit 40
  > karakter dan komentar versi: `actions/checkout@fbc6f399… # v5.1.0` dan
  > `oven-sh/setup-bun@0c5077e5… # v2.2.0` (#275, dipakai ulang #276 dan #277).

## Solution

Sesudah run ini:

- `bun run audit` di mesin lokal bersih, dan kedua advisory yang sengaja dikecualikan tertulis
  bersama alasannya.
- Setiap pull request dan push ke `main` menjalankan **workflow keamanan** yang terpisah dari Quality
  gate. Workflow itu punya dua pemeriksaan: audit dependency JavaScript dan scan image Docker
  produksi.
- PR menjadi merah dengan nama check yang jelas urusan keamanan dalam dua kasus:
  - advisory baru di dependency, apa pun severity-nya;
  - CVE paket OS berseverity HIGH atau CRITICAL yang sudah ada perbaikannya.
- Pengecualian hanya bisa lewat daftar ignore di repo. Setiap entri memuat alasan dan syarat
  pencabutan.
- Semua action di semua workflow dirujuk dengan commit SHA. Dependabot membuka paling banyak satu PR
  per bulan untuk menaikkannya.

Pengaturan GitHub dinyalakan pada 2026-10-23, sebelum run dimulai, dan tidak menjadi tiket:
Dependabot alerts, secret scanning, push protection dan CodeQL default setup.

## Goals and non-goals

**Goals**

- Tidak ada advisory terbuka di `bun audit`, kecuali yang di-ignore dengan alasan tertulis.
- CI menolak advisory dependency baru dan CVE OS yang bisa diperbaiki.
- Pemeriksaan yang sama bisa dijalankan di lokal dengan satu perintah.
- Action dirujuk dengan SHA, dan dijaga tetap segar dengan cara yang tidak berisik.
- Batas pemeriksaan tertulis, supaya tidak ada yang merasa aman lebih dari yang sebenarnya.

**Non-goals**

- Scan terjadwal. Pemilik memutuskan tanpa jadwal harian maupun mingguan.
- Dependabot version updates untuk ekosistem `bun` dan `docker`.
- Upgrade major (SvelteKit 3, vitest 5).
- SAST selain CodeQL default setup.
- Memasukkan audit ke gate lokal agen.

## User stories

1. Sebagai pemilik, saya ingin tahu apakah aplikasi terkena kerentanan yang diketahui publik, supaya saya bisa memutuskan apa yang diperbaiki.
2. Sebagai pemilik, saya ingin tahu advisory mana yang benar-benar sampai ke produksi, supaya prioritas perbaikan tidak tertukar dengan celah dev server.
3. Sebagai pemilik, saya ingin PR yang membawa dependency rentan ditolak CI, supaya kerentanan tidak masuk ke `main` tanpa ketahuan.
4. Sebagai pemilik, saya ingin pemeriksaan keamanan punya check sendiri yang terpisah dari Quality gate, supaya PR merah karena advisory baru terbaca sebagai urusan keamanan, bukan bug kode.
5. Sebagai pemilik, saya ingin setiap pengecualian advisory tertulis bersama alasan dan syarat pencabutannya, supaya pengecualian tidak berubah menjadi lupa.
6. Sebagai pemilik, saya ingin menjalankan pemeriksaan yang persis sama di mesin lokal dengan satu perintah, supaya saya bisa memeriksa sebelum push.
7. Sebagai pemilik, saya ingin image Docker produksi dipindai untuk CVE paket OS, karena aplikasi berjalan di image itu dan bukan hanya di `node_modules`.
8. Sebagai pemilik, saya ingin scan image hanya gagal untuk temuan yang bisa saya perbaiki, supaya CI tidak merah karena CVE Alpine yang belum punya perbaikan.
9. Sebagai pemilik, saya ingin action pihak ketiga tidak bisa diganti diam-diam, supaya CI tidak menjalankan kode yang tidak pernah saya setujui.
10. Sebagai pemilik, saya ingin pin action tetap segar lewat paling banyak satu PR per bulan, supaya pin tidak basi tanpa membanjiri saya dengan PR.
11. Sebagai warga, saya ingin isi Post yang saya baca tetap disaring dari skrip berbahaya setelah penyaringnya diperbarui, supaya membaca pengumuman tetap aman.
12. Sebagai admin atau warga, saya ingin login, halaman, impor xlsx dan Post tetap bekerja seperti sebelumnya setelah dependency naik, supaya perbaikan keamanan tidak memutus pekerjaan sehari-hari.
13. Sebagai agen yang menjalankan gate lokal, saya ingin gate tidak gagal karena advisory yang terbit di tengah run, supaya gelombang yang tidak berhubungan tidak tertahan.
14. Sebagai pemilik, saya ingin batas pemeriksaan tertulis (tanpa jadwal, Dependabot buta terhadap paket transitif), supaya saya tahu kapan advisory baru bisa terlewat.

## Implementation decisions

1. **Remediasi di dalam range yang ada.**
   - `bun audit fix` menaikkan `devalue` ke 5.9.3, `sanitize-html` ke 2.18.0 (pin exact-nya ikut naik
     di `package.json`), `source-map-js` ke 1.2.2 dan `vite` ke 8.3.3.
   - vitest naik ke 4.1.12, yang membawa `@vitest/mocker` 4.1.12. `bun audit fix` tidak menaikkannya
     sendiri karena vitest 4.1.11 mengunci versi mocker-nya.
   - Tidak ada kenaikan major.
   - *Why:* dengan dua langkah ini, 19 dari 23 advisory tertutup tanpa melewati range yang dideklarasikan.

   > *Sesudah run (2026-10-23):* `sanitize-html` di-pin exact **2.18.1**, bukan 2.18.0. Versi 2.18.0
   > sendiri kena GHSA-c9rx-x947-fp3h (moderate, rentang `>=2.18.0 <2.18.1`), yang terbit 2026-10-21,
   > sesudah dry-run spec ini. Executor #274 berhenti dan melapor; badan tiket dikoreksi ke 2.18.1.
   > Tes sanitasi Post tidak berubah hasilnya.

2. **Empat advisory yang diblok range induknya.** Aturannya: `overrides` untuk paket yang sampai ke
   runtime, dan ignore beralasan untuk tooling yang versinya berisiko dipaksa. Preseden repo lain
   pemilik lebih memilih `overrides` daripada menerima advisory.
   - `cookie` 0.6.0 (low, GHSA-pxg6-pf52-xh8x) dibawa `@sveltejs/kit` 2.70.3, versi 2.x terbaru, yang
     menuntut `^0.6.0`. Keputusan: `overrides` ke `^0.7.0`. *Why:* paket ini ada di runtime, dan 0.7.0
     hanya menambah validasi nama, path dan domain.
   - `uuid` 8.3.2 (moderate, GHSA-w5hq-g745-h8pq) dibawa `exceljs` 4.4.0, versi terbaru, yang menuntut
     `^8.3.0`. Keputusan: `overrides` ke `^11.1.1`. *Why:* paket ini ada di runtime lewat impor xlsx.
     exceljs hanya memanggil `v4`, yang masih tersedia di 11.
   - `esbuild` 0.18.20 (moderate, GHSA-67mh-4wv8-2f99) dibawa drizzle-kit lewat
     `@esbuild-kit/core-utils`, yang menuntut `~0.18.20`. Keputusan: ignore. *Why:* celahnya ada di mode
     serve esbuild, yang tidak dipakai drizzle-kit, dan memaksa versi loader drizzle-kit lebih berisiko
     daripada advisory-nya. Syarat cabut: drizzle-kit tidak lagi membawa esbuild di bawah 0.25.0.
   - `postcss-selector-parser` 6.0.10 (moderate, GHSA-rj75-hqrm-r3gf) di-pin exact oleh
     `@tailwindcss/typography` 0.5.20. Keputusan: ignore. *Why:* paket ini hanya bekerja saat build,
     dan yang dibacanya CSS repo sendiri. Syarat cabut: typography membawa 7.1.6 atau lebih baru.
   - **Kedua override dibatasi ke induknya** (nested override satu tingkat), bukan override global:
     `cookie` hanya untuk `@sveltejs/kit`, dan `uuid` hanya untuk `exceljs`. *Why:* elysia memakai
     `cookie` 1.1.1 dan `@inlang/sdk` memakai `uuid` 14.0.2, dan override global akan menurunkan
     keduanya. Bun 1.4.0 dan 1.4.2 mendukung bentuk ini. Lockfile yang memuat nested override ditulis
     sebagai `lockfileVersion` 3 (per 2026-10-23 masih 1), yang tidak bisa dibaca Bun versi lama. Mesin
     lokal memakai 1.4.0, sedangkan CI dan Dockerfile memakai 1.4.2.

   > *Sesudah run (2026-10-23):* `bun.lock` kini `lockfileVersion` 3, dan kedua override memakai
   > bentuk objek npm: `"@sveltejs/kit": { "cookie": "^0.7.0" }` dan `"exceljs": { "uuid": "^11.1.1" }`.
   > Terukur dengan `bun why`: SvelteKit mendapat `cookie` 0.7.2 dan elysia tetap 1.1.1; exceljs
   > mendapat `uuid` 11.1.1 dan `@inlang/sdk` tetap 14.0.2. Bun 1.4.2 di CI membaca lockfile itu
   > dengan `--frozen-lockfile` (#274).

3. **Ambang dan cakupan audit.**
   - Ambangnya `low`: setiap advisory yang tidak ada di daftar ignore menggagalkan pemeriksaan.
   - Semua dependency diaudit, bukan `--prod` atau `--omit=dev`.
   - *Why:* SvelteKit, Svelte dan Vite ada di `devDependencies`, padahal dibundel ke build produksi.
     `--prod` menyembunyikan `devalue`; terukur pada 2026-10-23, `--prod` hanya melaporkan 5 advisory.
   - `--audit-level` dan `--ignore` mengubah exit code, bukan hanya keluaran. Terukur: dengan
     advisory yang ada, `--audit-level=high` keluar dengan 1 dan `--audit-level=critical` keluar dengan 0.

4. **Daftar ignore hidup di sebuah skrip kecil di repo.**
   - Skrip itu memanggil `bun audit` dengan ambang dan daftar ignore. Setiap ID GHSA ditemani komentar
     alasan dan syarat cabutnya.
   - `bun run audit` memanggil skrip itu, dan CI memanggil `bun run audit`.
   - ID ditulis dalam bentuk GHSA. Menurut dokumentasi Bun, ID CVE tidak cocok dengan data registry.
   - *Why:* menurut dokumentasi Bun 1.4.2, opsi `bun audit` hanya bisa lewat CLI; `bunfig.toml` tidak
     punya konfigurasi audit. `package.json` tidak bisa memuat komentar, sehingga alasan di README akan
     basi terpisah dari daftar ID. Skrip memberi satu sumber untuk lokal dan CI.

   > *Sesudah run (2026-10-23):* alasan dan syarat cabut ditulis sebagai data, bukan komentar: setiap
   > entri `IGNORED_ADVISORIES` memuat `id`, `package`, `parent`, `reason` dan `removeWhen`. Skrip
   > mencetak setiap entri yang di-ignore ke log sebelum menjalankan `bun audit`, karena `bun audit`
   > sendiri hanya menyebut jumlahnya (#276).

5. **Workflow keamanan terpisah dari Quality gate.**
   - Pemicunya `pull_request`, push ke `main` dan `workflow_dispatch`. Tanpa jadwal, sesuai keputusan
     pemilik 2026-10-23.
   - Ada dua job, `audit` dan `image-scan`, dengan izin `contents: read`.
   - *Why:* PR merah karena advisory yang baru terbit harus terbaca sebagai urusan keamanan.

6. **Scan image.**
   - Bangun target `production` dari Dockerfile, lalu Trivy memindai **hanya paket OS**, bukan paket
     bahasa.
   - Pemeriksaan gagal pada HIGH atau CRITICAL yang sudah ada perbaikannya. Temuan lain dilaporkan
     tetapi tidak memblokir.
   - `trivy-action` di-pin ke SHA rilis immutable; v0.36.0 adalah rilis terbaru per 2026-10-23. Versi
     binary Trivy yang diunduh action juga di-pin eksplisit ke versi di luar rentang yang
     dikompromikan pada Maret 2026.
   - *Why:* paket JS sudah dipegang audit. Kalau Trivy ikut memindai `node_modules`, advisory yang
     sengaja di-ignore muncul lagi dan butuh daftar ignore kedua. Base image Alpine juga hampir selalu
     membawa CVE low atau medium yang belum punya perbaikan.

   > *Sesudah run (2026-10-23):* `trivy-action` tidak dipakai. Di dalamnya, `setup-trivy` v0.2.6
   > memasang binary lewat `contrib/install.sh`, yang hanya memeriksa checksum dari rilis yang sama,
   > dan memulihkan binary dari cache tanpa pemeriksaan, jadi rantainya tidak bisa dikunci dari repo
   > ini. Job `image-scan` mengunduh arsip rilis Trivy 0.76.1 (rilis immutable, di luar rentang
   > CVE-2026-33634 yang hanya mengenai binary 0.69.4) dan memeriksanya dengan SHA-256 yang ditulis di
   > workflow. DB kerentanan diunduh setiap run dan tidak di-cache (#277).
   >
   > Run pertama `image-scan` menemukan CVE-2026-14456 (HIGH, sudah ada perbaikan) di `libssl3` dan
   > `libcrypto3` 3.5.7-r0 base image `oven/bun:1.4.2-alpine`, yang tagnya membeku pada Alpine 3.22.5.
   > Atas keputusan pemilik, #281 ditambahkan sebagai Gelombang 4: stage `base` Dockerfile menjalankan
   > `apk upgrade --no-cache`, dan Bun tetap 1.4.2.

7. **Pin SHA.**
   - Setiap action di setiap workflow dirujuk dengan SHA commit 40 karakter dan komentar versi.
   - Dependabot version updates untuk ekosistem `github-actions` berjalan bulanan, dengan semua action
     dalam satu grup.
   - Ekosistem `bun` dan `docker` tidak dimasukkan.
   - *Why:* tag bisa dipindahkan. Dependabot tidak membuat alert untuk action yang di-pin SHA ("alerts
     are only generated for actions that use semantic versioning, not SHA versioning"), jadi version
     update adalah satu-satunya jalan agar pin tetap segar. Versi Bun di-pin exact dengan alasan
     tertulis (#223), jadi update `docker` hanya akan berisik.

8. **Audit tidak masuk gate lokal** (empat perintah di README dan CLAUDE.md). *Why:* advisory bisa
   terbit di tengah run dan menggagalkan gelombang yang tidak berhubungan. CI yang memegang pemeriksaan
   ini.

9. **Pengaturan GitHub, sudah dilakukan pada 2026-10-23 di luar tiket.**
   - Dependabot alerts, secret scanning, push protection dan CodeQL default setup dinyalakan.
   - Dependabot security updates dibiarkan mati, karena tidak mendukung Bun dan tidak ada alert untuk
     action yang di-pin SHA.
   - Dependency graph hanya membaca `package.json`, tidak membaca `bun.lock`. Per 2026-10-23 isinya 48
     dependency langsung, sehingga alert Dependabot buta terhadap paket transitif seperti `devalue`.
     Itu sebabnya `bun audit` di CI adalah pemeriksaan yang sebenarnya.

10. **Dokumentasi.**
    - README memuat bagian pemeriksaan keamanan: apa yang dicek dan apa yang tidak, cara
      menjalankannya di lokal, cara menambah atau mencabut entri ignore, dan pengaturan GitHub yang
      menyala.
    - CLAUDE.md mendapat satu baris: audit dipegang CI, bukan gate lokal.

## Testing decisions

Tes yang baik di sini menguji perilaku luar: exit code perintah, hasil check di GitHub, dan perilaku
halaman. Tes yang baik tidak menguji isi file konfigurasi. Seam yang disepakati dengan pemilik pada
2026-10-23:

| Seam | Menangkap | Tidak menangkap |
|---|---|---|
| S1: exit code `bun run audit` | Keluar 0 setelah remediasi. Kalau satu GHSA dicabut dari daftar ignore, keluar 1, yang membuktikan pemeriksaan benar-benar menggigit. | Apakah CI memanggilnya |
| S2: gate empat perintah yang sudah ada, termasuk tes sanitasi Post, impor xlsx dan template impor | Regresi akibat sanitize-html 2.18, override `uuid` di exceljs, kenaikan vite dan devalue | Perilaku runtime di browser |
| S3: run GitHub Actions di PR integrasi: Quality gate dengan pin SHA, job `audit` dan `image-scan` | Wiring, SHA yang tidak valid, docker build di CI, konfigurasi Trivy | Jalur gagal `image-scan` (tidak diprovokasi). Log-nya cukup menunjukkan paket OS Alpine benar-benar dipindai. |
| S4: walk Playwright MCP pada build produksi | Login (override `cookie`), halaman dengan data `load` (devalue), Post berformat (sanitize-html), console tanpa error | Selain smoke test |

> *Sesudah run (2026-10-23):* jalur gagal `image-scan` ternyata terprovokasi oleh temuan sungguhan
> pada run pertamanya (CVE-2026-14456, lihat keputusan 6), dan menjadi hijau setelah #281. Walk S4
> membuka `/admin/units` sebagai superuser, karena `manageUnits` hanya untuk superuser.

Tidak ada file tes unit baru. Skrip audit hanyalah pembungkus tipis, dan buktinya S1.

## Success criteria

- `bun run audit` keluar dengan 0 di ujung branch integrasi. Menghapus satu ID dari daftar ignore
  membuatnya keluar dengan 1.
- `bun audit` tanpa ignore hanya melaporkan dua advisory: GHSA-67mh-4wv8-2f99 dan GHSA-rj75-hqrm-r3gf.
- Gate empat perintah hijau.
- Di PR integrasi, check Quality gate, `audit` dan `image-scan` hijau. Log `image-scan` menunjukkan
  paket OS Alpine dipindai dengan ambang HIGH/CRITICAL yang bisa diperbaiki.
- Setiap action di setiap workflow dirujuk dengan SHA 40 karakter dan komentar versi.
- Dependabot version updates untuk `github-actions` terkonfigurasi bulanan dalam satu grup.
- Walk orchestrator: admin bisa login, beranda dan laporan terbuka, dan Post berformat tampil dengan
  formatnya utuh. Console tidak mencatat error.

  > *Sesudah run (2026-10-23):* `/reports` terbuka tanpa error tetapi kosong, karena Data Contoh
  > tidak punya laporan terbit; alur laporan terbit yang dibuka warga dibuktikan e2e
  > `reports.spec.ts`. Satu-satunya error console sepanjang walk adalah 403 `/admin/units` untuk
  > admin, perilaku lama yang disengaja.
- README dan CLAUDE.md menjelaskan pemeriksaan ini beserta batasnya.

## Out of scope

- Scan terjadwal, harian maupun mingguan.
- Dependabot version updates untuk `bun` dan `docker`.
- Upgrade major (SvelteKit 3, vitest 5).
- SAST selain CodeQL default setup.
- Audit di gate lokal agen.
- Merge, deploy dan branch protection. Ketiganya langkah pemilik setelah run ditutup.

## Further notes

- **Celah yang diterima pemilik:** tanpa jadwal, advisory baru pada paket transitif hanya terlihat
  saat ada PR atau push ke `main`.
- **Setelah merge, langkah pemilik:**
  - Deploy, karena bundle produksi berubah (`devalue`, `sanitize-html`).
  - Branch protection di `main` dengan required status checks: job Quality gate, `audit` dan
    `image-scan`. Nama check-nya baru ada setelah workflow pertama berjalan.

    > *Sesudah run (2026-10-23):* nama check persis di PR #280: `check, lint, test, build` (workflow
    > Quality gate), `audit` dan `image-scan` (workflow Security). CodeQL default setup menambah
    > `Analyze (actions)`, `Analyze (javascript-typescript)` dan `CodeQL`. Deploy juga membawa
    > `apk upgrade` di image produksi (#281).
- Angka audit di spec ini diukur dengan Bun 1.4.0 di mesin lokal. CI dan Dockerfile memakai Bun 1.4.2.
