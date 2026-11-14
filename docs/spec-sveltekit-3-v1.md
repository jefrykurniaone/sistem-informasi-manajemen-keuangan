# Spec: sveltekit-3 v1 - Naik ke SvelteKit 3 supaya alert Dependabot #4 dan #5 tertutup

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#296](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/296) |
| Run | `kit3-v1` |
| Peta eksekusi | [#300](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/300) |
| Tiket | [#297](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/297), [#298](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/298) |
| Branch integrasi | `chore/kit3-v1`, PR [#299](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/pull/299) ke `main`, yang juga memuat salinan ini |
| Pendahulu | Tidak ada. Membalik keputusan "tanpa upgrade major" run `aman-v1` ([#273](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/273)) dan `aman-v2` ([#287](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/287)), khusus untuk `@sveltejs/kit` dan `@sveltejs/adapter-node` |
| Disalin pada | 2026-11-14, dari `main` di `e1138cb` |

Salinan point-in-time. Item spesifikasi di GitHub adalah sumber kebenaran. Badan di bawah garis ini disalin
verbatim dari #296 dan dibuat ulang dari item itu saat run ditutup.

---

## Problem statement

Per 2026-11-14 (`main` di `e1138cb`), dashboard Dependabot repositori ini menampilkan dua alert terbuka. Keduanya
untuk `@sveltejs/kit` dengan rentang rentan "< 3.0.0", dan versi pertama yang diperbaiki adalah 3.0.0:

- #4, GHSA-27mw-82g8-phjj (low): XSS lewat header `cache-control` dari `setHeaders` di halaman yang
  di-prerender.
- #5, GHSA-pfhg-q3qv-9q6r (low): open redirect lewat form `use:enhance` di route yang menerima path
  berawalan `//`.

Pemilik menginginkan 0 alert terbuka. `bun run audit` sudah hijau, karena `scripts/audit.ts` meng-ignore
kedua advisory itu dengan syarat pensiun "The repository upgrades to SvelteKit 3." Yang masih merah
hanya dashboard Dependabot.

> *Catatan penyerahan (2026-11-14):* kedua ignore itu sudah dihapus di #298 (`060fd86`). `bun run audit` tetap exit 0 dengan 4 ignore transitif.
> Dashboard Dependabot baru berubah setelah PR #299 di-merge ke `main` (S6, langkah pemilik).

Analisis per 2026-11-14 menunjukkan keduanya tidak bisa dieksploitasi pada 2.70.4 yang terpasang:

- #4: perbaikannya sudah di-backport ke 2.70.4 (catatan rilis: "fix: escape cache-control headers in
  prerendered HTML"). Kodenya terlihat di
  `node_modules/@sveltejs/kit/src/runtime/server/page/render.js:606`, yang memakai
  `escape_html(state.prerendering.cache, true)`. Aplikasi ini juga tidak mem-prerender halaman apa pun.
- #5: perbaikan upstream (commit `91aae35`) mengubah navigasi form yang di-enhance ke lokasi action
  untuk hasil yang bukan redirect. Navigasi itu perilaku SvelteKit 3. `forms.js` di 2.70.4 hanya
  memanggil `applyAction` bila action milik halaman yang sedang dibuka. Repositori ini juga tidak
  memakai `use:enhance` sama sekali.

> *Catatan penyerahan (2026-11-14):* analisis ini berlaku untuk 2.70.4, versi yang terpasang saat spec ditulis. `chore/kit3-v1` sekarang
> memasang `@sveltejs/kit` 3.2.0 dan `@sveltejs/adapter-node` 6.0.2 (#298, merge `96a34e5`).

Alert bisa saja di-dismiss dengan alasan itu. Pemilik memilih memperbaikinya lewat upgrade ke SvelteKit 3,
supaya alert tertutup sebagai *fixed* dan aplikasi tetap di versi mayor yang dirawat.

## Solution

Aplikasi naik ke `@sveltejs/kit` 3.2.0 dan `@sveltejs/adapter-node` 6.0.2 dalam dua langkah:

1. Alias `$lib` diganti dengan subpath import `#lib` selagi masih di SvelteKit 2. Perubahan ini murni
   mekanis dan tidak mengubah perilaku.
2. Versi dinaikkan, bersama setiap perubahan yang diwajibkan SvelteKit 3, dalam satu commit yang
   gate-nya hijau.

Setelah PR integrasi di-merge ke `main`, Dependabot menandai #4 dan #5 sebagai *fixed*, dan
`scripts/audit.ts` tidak lagi meng-ignore kedua advisory itu. Bagi warga dan admin aplikasi berperilaku sama
seperti sebelumnya. Bentuk deploy produksi juga tidak berubah: `.env` yang sama, `ORIGIN` dibaca saat
runtime, dan image yang sama berjalan di Bun.

## Goals and non-goals

**Goals**

- Alert Dependabot #4 dan #5 berstatus *fixed* setelah merge ke `main`.
- Daftar ignore di `scripts/audit.ts` hanya memuat advisory yang masih berlaku.
- Perilaku aplikasi tidak berubah, kecuali default baru SvelteKit 3 yang diterima di keputusan 9.
- Deploy produksi berjalan dengan `.env` dan langkah `docs/deploy.md` yang sama.
- Gate empat perintah, `bun run audit`, e2e penuh dan image produksi hijau.

**Non-goals**

- `bun audit` mentah menjadi 0. Empat ignore transitif tetap ada dengan alasan yang sudah tertulis di
  `scripts/audit.ts`. Per 2026-11-14 tidak satu pun bisa diperbaiki dari repositori ini:
  - `deepmerge` belum pernah merilis versi yang diperbaiki;
  - `drizzle-kit` 0.31.11 (terbaru) masih membawa `esbuild` lama;
  - `typescript-eslint` 8.72.2 (terbaru) masih memakai `minimatch` ^10;
  - `@tailwindcss/typography` 0.5.20 (terbaru) mem-pin `postcss-selector-parser` 6.0.10.
- Upgrade mayor lain: `@inlang/paraglide-js` 3, `@sveltejs/adapter-bun`, `drizzle-kit` 1.0, dan
  `bits-ui` atau `runed`.
- Men-dismiss alert, atau mengusulkan koreksi rentang ke GitHub Advisory Database.
- Fitur baru SvelteKit 3: remote functions, `compilerOptions.experimental.async`, service worker,
  instrumentation, tracing, dan `$app/manifest`.

## User stories

1. Sebagai pemilik, saya ingin alert Dependabot #4 dan #5 berstatus *fixed*, supaya dashboard menampilkan
   0 alert terbuka.
2. Sebagai pemilik, saya ingin `scripts/audit.ts` berhenti meng-ignore kedua advisory SvelteKit, supaya
   daftar ignore hanya memuat advisory yang masih berlaku.
3. Sebagai pemilik, saya ingin penggantian `$lib` ke `#lib` di commit tersendiri sebelum upgrade, supaya
   diff upgrade hanya berisi perubahan yang bermakna dan bisa saya review.
4. Sebagai warga, saya ingin masuk, tetap masuk setelah pindah halaman, dan keluar seperti sebelumnya,
   supaya upgrade tidak terasa.
5. Sebagai warga atau admin, saya ingin mengirim form dan melihat pesan validasi saat form ditolak,
   supaya kesalahan input tetap jelas.
6. Sebagai pembaca laporan kas bulanan, saya ingin membuka dan menutup rincian sebuah kategori tanpa
   halaman melompat ke atas dan tanpa kehilangan fokus, supaya saya tetap di baris yang sedang saya baca.
7. Sebagai pengunjung, saya ingin nama komplek tampil di judul tab dan header tanpa berkedip, supaya
   halaman langsung terlihat benar.
8. Sebagai warga yang membuka link file bertanda tangan, saya ingin file-nya tetap tersaji, supaya bukti
   pembayaran dan lampiran tetap bisa dibuka.
9. Sebagai pemilik yang men-deploy, saya ingin `.env` produksi yang sama, termasuk `ORIGIN`, tetap
   bekerja, supaya deploy tidak butuh langkah baru.
10. Sebagai pengembang, saya ingin import memakai `#lib` dengan ekstensi eksplisit, supaya kode mengikuti
    resolusi modul SvelteKit 3.
11. Sebagai pengembang yang menjalankan `db:seed-dev` dan `superuser:grant` di Bun, saya ingin import
    ter-resolve tanpa mapping `$lib` buatan tangan, supaya script tidak bergantung pada alias yang sudah
    tidak ada.
12. Sebagai pengembang, saya ingin dokumen dan komentar konfigurasi menyebut modul SvelteKit 3
    (`$app/env`, `$app/tsconfig`), supaya tidak menyesatkan.
13. Sebagai pemilik, saya ingin kemampuan rate limiter membaca alamat klien di belakang Caddy tetap
    sama, supaya setiap pengunjung tetap punya bucket sendiri.

## Implementation decisions

1. **Versi.** `@sveltejs/kit` `^3.2.0` dan `@sveltejs/adapter-node` `^6.0.2`, dengan caret seperti
   sekarang. Pin exact tetap hanya untuk drizzle, pg, better-auth dan paraglide.
   - 6.0.2 adalah batas bawah wajib. adapter-node 6.0.0 menghapus env `ORIGIN`, dan 6.0.2
     (sveltejs/kit#17632, 2026-11-04) mengembalikan pembacaannya saat runtime, selama `paths.origin`
     tidak diset.
   - `paths.origin` tidak diset. Kalau diset, adapter-node mengabaikan `ORIGIN`. Padahal `ORIGIN` juga
     dipakai sebagai `baseURL` better-auth dan menentukan flag `Secure` cookie sesi (`readOrigin`).
   - Syarat versi kit 3 sudah terpenuhi per 2026-11-14:
     - Node ≥ 22.17: 24.21 di lokal, 22.23.4 di runner CI, image memakai Bun 1.4.2;
     - TypeScript 6.0.3, Svelte 5.57.3, Vite 8.3.8, `@sveltejs/vite-plugin-svelte` 7.3.1.
   - `ADDRESS_HEADER`, `XFF_DEPTH` dan `BODY_SIZE_LIMIT`, yang dipasang produksi untuk Caddy dan rate
     limiter, tetap dibaca handler adapter-node 6 (`packages/adapter-node/src/handler.js` di `main`
     upstream, 2026-11-14). Nilainya tidak berubah.
   - Tidak ada paket lain yang dinaikkan.
   - `runed` 0.35.x, dibawa `bits-ui` 2.21.0 (versi terbaru), mendeklarasikan peer opsional
     `@sveltejs/kit ^2.21.0`. Peringatan peer saat install diterima, karena tidak ada yang mengimpor
     `runed/kit`.
2. **`#lib` di SvelteKit 2, sebagai prefactor.**
   - `package.json` mendapat `"imports": { "#lib": "./src/lib/index.js", "#lib/*": "./src/lib/*" }`.
     Bentuk ini sama persis dengan yang ditulis codemod.
   - Setiap specifier `$lib` di `src`, `tests` dan `scripts` menjadi `#lib` dengan ekstensi eksplisit,
     memakai aturan task `lib-alias` codemod: `.ts`, atau `/index.ts` untuk direktori. Output paraglide
     memakai `.js`, dan `.svelte` tidak berubah.
   - `tsconfig.json` menukar `rewriteRelativeImportExtensions` dengan `allowImportingTsExtensions`.
     `$app/tsconfig` milik SvelteKit 3 memasang opsi yang sama, bersama `noEmit`. Dengan
     `rewriteRelativeImportExtensions`, `svelte-check` menolak setiap specifier `#lib/....ts` (TS2877).

     > *Catatan penyerahan (2026-11-14):* #297 memasang `allowImportingTsExtensions` (`59a0e13`). #298 lalu membuangnya dari
     > `tsconfig.json`, karena `$app/tsconfig` sudah memasangnya.
   - Alias `components.json` menjadi `#lib/...`.
   - `scripts/tsconfig.seed.json` membuang mapping `$lib`, karena Bun me-resolve `imports` di
     `package.json` sendiri. Shim `$app/server` tetap ada.
   - Kelayakan sudah dibuktikan 2026-11-14 di worktree sementara:
     - `check` 0 error, `eslint` 0 error, `prettier` hijau setelah `format`;
     - `build` berhasil, dan 108 test unit yang tidak butuh database lulus;
     - `bun build scripts/seed-dev.ts` berhasil membundel.
   - Alasan dipisah: diff upgrade jadi bisa di-review, dan rename ini tidak mengubah perilaku.
3. **Codemod.**
   - `npx sv migrate sveltekit-3` menjadi dasar langkah upgrade. Task `lib-alias`-nya tidak menemukan
     apa-apa lagi setelah keputusan 2.
   - Perubahan codemod pada salinan point-in-time (`docs/spec-*.md`, `docs/research-ui-ux-v1.md`)
     dikembalikan.
   - Setiap komentar `@migration-task` yang ditinggalkan codemod diselesaikan, dan tidak ada yang tersisa
     di pohon kerja.

   > *Catatan penyerahan (2026-11-14):* codemod (`sv` 1.3.0) dipakai sebagai dasar, tetapi pencetakan ulang template Svelte-nya
   > dibuang, karena mengubah whitespace yang terlihat dan entitas `&middot;`. Yang diterapkan ulang hanya
   > penghapusan garis miring `resolve()`. Guard `shallow` yang ditambahkan codemod ke `afterNavigate` laporan
   > juga tidak dipakai, karena aplikasi tidak memakai `pushState`, `replaceState` maupun `goto`. Tidak ada
   > `@migration-task` yang tersisa.
4. **Environment.**
   - `building` diimpor dari `$app/env`.
   - `PUBLIC_COMPLEX_NAME` dideklarasikan di `src/env.ts` dengan `public: true` dan `static: true`, dan
     nilainya boleh tidak ada. Bila tidak ada atau kosong, `normalizeComplexName` memberi "Komplek".
   - `static` mempertahankan rancangan `src/lib/complex-name.ts`: nama tertanam saat build, tidak
     berkedip, dan mengganti nama tetap berarti build ulang.
   - Kode server lain membaca `process.env` langsung dan tidak disentuh.
   - Deklarasi `PUBLIC_COMPLEX_NAME` di level job CI tetap ada. Komentarnya diperbarui.
5. **tsconfig.**
   - `tsconfig.json` meng-extend `$app/tsconfig`.
   - `include` dan `exclude` ditulis eksplisit dan mencakup apa yang dicakup
     `.svelte-kit/tsconfig.json` hari ini: `src`, `tests`, dan `vite.config.ts`.
   - `compilerOptions` milik repositori tetap ada.
6. **Cookie.**
   - `overrides["@sveltejs/kit"].cookie` dihapus, karena SvelteKit 3 memakai cookie v2.
   - Nama cookie yang dipakai ASCII: `sidebar_state`, dan cookie better-auth.
   - `overrides.exceljs.uuid` tetap ada.
7. **Opsi link.** `data-sveltekit-noscroll` dan `data-sveltekit-keepfocus` pada link drill-down tabel
   kategori laporan (`/reports/[period]`) menjadi `data-sveltekit-reset="false"`. Dokumentasi link options SvelteKit 3 hanya mengenal `reset`.
   Atribut lama yang tertinggal tidak menghasilkan error, tetapi halaman diam-diam melompat ke atas.
8. **`$app/paths`.**
   - Argumen `resolve()` ditulis tanpa garis miring di depan. Per 2026-11-14 ada 67 pemanggilan di 39
     file, dan semuanya ditangani task `paths` codemod.
   - `resolve('/')` adalah kasus yang tidak diubah codemod. Executor memeriksa bentuk yang diterima
     SvelteKit 3 untuk root.

   > *Catatan penyerahan (2026-11-14):* SvelteKit 3 menolak `resolve('/')`, karena `/` bukan route id: root aplikasi adalah
   > `/(app)`. Bentuk yang diterima untuk root adalah `resolve('')`, yang menghasilkan `/`. Keempat pemanggilan
   > menjadi `resolve('')`, dan tipe `Pathname` menjadi `Path`. `covers()` di sidebar menambahkan `/` kembali
   > sebelum membandingkan dengan `page.url.pathname`.
9. **Default baru SvelteKit 3 diterima apa adanya**, dan tidak dikembalikan lewat konfigurasi:
   - polling versi setiap jam;
   - klik link ke halaman yang sedang dibuka me-refresh data;
   - status `fail(...)` menjadi status HTTP respons form;
   - `path` cookie default `/`;
   - preload sebagai elemen `<link>`.

   Kode atau test yang rusak karena default ini diperbaiki, bukan konfigurasinya.

    > *Catatan penyerahan (2026-11-14):* tidak ada test yang rusak karena default baru. 2375 test unit dan 48 test e2e lulus tanpa
    > perubahan perilaku. Verifikasi kedua mencatat dua perubahan perilaku library:
    > - cookie v2 tidak lagi meng-encode `+`, `/` dan `=` di nilai cookie, dan cookie lama tetap terbaca;
    > - POST tanpa `Content-Type` sekarang juga diperiksa origin-nya.
10. **Tidak terkena** (sweep 2026-11-14):
    - tidak ada `use:enhance`, `$app/forms` maupun `goto`;
    - semua `redirect(303, …)` mengarah ke path internal, dan semua `error(…)` memakai pesan string;
    - tidak ada kelas error atau redirect SvelteKit yang diimpor;
    - upload disimpan di `FILE_STORE_ROOT` dan disajikan oleh handler `GET` di `src/routes/files/[...key]`,
      bukan oleh static handler;
    - Elysia hanya punya route GET;
    - tidak ada modul klien yang mengimpor path `server`;
    - tidak ada `hooks.client`, service worker, `src/params`, `handleError` maupun `reroute`.
11. **Daftar ignore audit.**
    - Entri GHSA-pfhg-q3qv-9q6r dan GHSA-27mw-82g8-phjj dihapus, karena syarat pensiunnya terpenuhi.
    - Setelah upgrade `bun audit` dijalankan ulang, dan `package` serta `parent` keempat entri lain
      disesuaikan dengan lockfile baru. Contohnya, adapter-node 6 membundel dengan rolldown dan mungkin
      tidak lagi membawa `@rollup/plugin-node-resolve > deepmerge`.
    - Entri yang advisory-nya tidak muncul lagi dihapus.
    - Advisory baru yang muncul adalah stop: executor melapor dan tidak menambah entri sendiri.

    > *Catatan penyerahan (2026-11-14):* terjadi seperti diperkirakan. Parent `deepmerge` tinggal
    > `@sveltejs/vite-plugin-svelte > deepmerge`. Tiga entri lain tidak berubah, dan tidak ada advisory baru.
12. **Dokumen dan komentar.** Yang menyebut modul SvelteKit 2 diperbarui:
    - `README.md`: baris `svelte-kit sync`, catatan `svelte.config.js` "From SvelteKit 2.63", dan setiap
      `$lib`;
    - `docs/deploy.md` (`$env/static/public`), `.env.example`, `.env.production.example`;
    - komentar di `Dockerfile`, `.github/workflows/ci.yml` dan `scripts/`.

    `CLAUDE.md` dan `CONTEXT.md` per 2026-11-14 tidak menyebut satu pun dari itu.

    > *Catatan penyerahan (2026-11-14):* komentar `$lib` di `scripts/` diperbarui di #297. Tiga komentar `scripts/` yang masih
    > menyebut `.svelte-kit/tsconfig.json` berada di luar permukaan #298, jadi dipindah ke #301. Perilakunya
    > tidak terpengaruh.
13. **Pengiriman.**
    - Branch integrasi `chore/kit3-v1` dengan satu PR ke `main`, berisi salinan spec ini dan kedua tiket.
    - Pemilik yang me-merge dan men-deploy.

## Testing decisions

Test yang baik di sini menguji perilaku dari luar. Seam yang dipakai semuanya sudah ada, dan tidak ada
file test baru yang direncanakan. Test yang rusak karena perubahan perilaku SvelteKit 3 diperbaiki ke
kontrak baru, dengan alasan di commit.

- **S1, gate empat perintah** (`check`, `lint`, `test`, `build`), ditambah `bun run audit` exit 0.
  - Menangkap: resolusi import, tipe, perilaku service yang diuji test unit dan integrasi, dan build
    produksi.
  - Tidak menangkap: routing saat runtime, CSRF dan origin, cookie di browser, dan perilaku navigasi.
- **S2, CI di PR integrasi:** `check, lint, test, build`, `audit`, `image-scan` dan `SonarQube Cloud`.
  - Menangkap: lingkungan bersih tanpa `.env`, dan build image produksi.
  - Tidak menangkap: perilaku image saat dijalankan.
- **S3, walk Playwright MCP oleh orchestrator pada build produksi** (`bun run build && bun run preview`).
  - Mengamati:
    - login, cookie sesi, dan sesi bertahan setelah pindah halaman;
    - satu form yang ditolak `fail()` dan menampilkan pesan validasi;
    - drill-down kategori di laporan bulanan yang posisi scroll dan fokusnya bertahan;
    - cookie sidebar dan cookie bahasa;
    - nama komplek di judul tab;
    - satu link `/files` yang ditandatangani.
  - Tidak menangkap: handler adapter-node, karena `vite preview` bukan handler produksi.
- **S4, `bun run test:e2e` penuh oleh orchestrator**, sekali sebagai baseline setelah langkah `#lib`
  dan sekali setelah upgrade.
  - Menangkap: alur warga dan admin dari ujung ke ujung.
  - Tidak menangkap: image produksi.
- **S5, image produksi dijalankan di lokal oleh orchestrator:** `docker build --target production`,
  lalu dijalankan dengan `ORIGIN=http://localhost:3000`.
  - Image dijalankan dengan `ADDRESS_HEADER=X-Forwarded-For`, `XFF_DEPTH=1` dan
    `BODY_SIZE_LIMIT=16M`, sama dengan produksi.
  - Mengamati: login, satu POST form yang diterima (bukan "Cross-site POST form submissions are
    forbidden"), satu static asset `_app/immutable` dengan `ETag`, `/api/health` 200, dan satu
    permintaan dengan header `X-Forwarded-For` yang dijawab tanpa error.
  - Menangkap: bundle rolldown adapter-node 6 yang dijalankan Bun, dan pembacaan `ORIGIN` saat runtime.
  - Tidak menangkap: Caddy dan TLS.
- **S6, setelah merge ke `main`:** alert #4 dan #5 berstatus *fixed*. Ini langkah pemilik, setelah run
  ditutup.

Prior art: seam S1 sampai S5 run `aman-v2` (peta #291).

## Success criteria

- Setelah merge ke `main`, `gh api repos/{owner}/{repo}/dependabot/alerts/4` dan `/5` menunjukkan
  `"state": "fixed"`.
- `bun run audit` exit 0, tanpa entri GHSA-pfhg-q3qv-9q6r dan GHSA-27mw-82g8-phjj di `scripts/audit.ts`.
- Pencarian `$lib` di `src`, `tests` dan `scripts` (di luar `src/lib/paraglide`) tidak menemukan apa-apa,
  dan `package.json` punya field `imports`.
- Versi terpasang `@sveltejs/kit` ≥ 3.2.0 dan `@sveltejs/adapter-node` ≥ 6.0.2.
- Tidak ada override `cookie`, tidak ada `paths.origin`, dan tidak ada komentar `@migration-task`.
- Gate empat perintah hijau, `bun run test:e2e` lulus penuh, dan setiap pengamatan S3 serta S5 tercatat
  lulus.
- Keempat required check di PR integrasi hijau.

## Out of scope

- Membuat `bun audit` mentah menjadi 0, karena empat advisory transitif menunggu upstream.
- Upgrade mayor lain: paraglide 3, adapter-bun, drizzle-kit 1.0, bits-ui atau runed.
- Men-dismiss alert, dan mengusulkan koreksi advisory.
- Fitur baru SvelteKit 3: remote functions, async, service worker, instrumentation, tracing, dan
  `$app/manifest`.
- Mengubah salinan spec lama dan `docs/research-ui-ux-v1.md`.
- Deploy produksi, yang merupakan langkah pemilik.

## Further notes

- Keputusan run `aman-v1` (#273) dan `aman-v2` (#287, peta #291), "tidak ada upgrade major (termasuk
  SvelteKit 3)", dibatalkan pemilik pada 2026-11-14, khusus untuk `@sveltejs/kit` dan
  `@sveltejs/adapter-node`. Upgrade major lain tetap tidak dilakukan.
- SvelteKit 2 masih dirawat (dist-tag `version-2`, 2.70.4 rilis 2026-11-05 dengan backport keamanan).
  Upgrade ini didorong pilihan pemilik, bukan oleh eksploit yang terjangkau.
- Dokumentasi Context7 untuk kit 3.1.1 masih menyebut `ORIGIN` dihapus. Yang berlaku adalah changelog
  adapter-node 6.0.2.

## Catatan penyerahan (2026-11-14)

Run `kit3-v1` (peta #300) selesai di branch integrasi `chore/kit3-v1`, PR #299 ke `main`.

| Tiket | Commit | Merge di `chore/kit3-v1` |
|---|---|---|
| #297, `$lib` ke `#lib` | `59a0e13` | `dfe73c5` |
| #298, SvelteKit 3.2 dan adapter-node 6.0.2 | `39ae6ff`, `060fd86`, `4041d4a`, `a5eea0f` | `96a34e5` |

Keputusan yang diambil saat eksekusi, di luar yang tertulis di atas:

- `localeHandle` di `src/hooks.server.ts` memanggil `resolve({ ...event, request })`, karena SvelteKit 3
  membuat `event.request` read-only. Bentuk ini sama dengan yang ditulis `sv add paraglide` untuk SvelteKit 3.
  `cookies`, `locals` dan `setHeaders` tetap objek yang sama. Pengecekan CSRF berjalan sebelum `handle`, jadi
  salinan event tidak memengaruhinya.
- `include` di `tsconfig.json` adalah `src`, `tests` dan `vite.config.ts`. `exclude` adalah `node_modules`,
  `src/service-worker` dan `src/service-worker.*`.
- Pohon utama dipasang ulang bersih (`rm -rf node_modules && bun install --frozen-lockfile`) sebelum gate
  Gelombang 2.

Hasil seam:

- **S1:** hijau di `dfe73c5` dan di `96a34e5`. `bun run audit` exit 0 dengan 4 ignore.
- **S2:** keempat required check hijau setelah setiap push. Di `96a34e5` hijau setelah rerun satu job yang
  gagal karena test flaky yang sudah ada sebelumnya (#302).
- **S3:** keenam pengamatan lulus pada build produksi.
- **S4:** 48/48 setelah #297 dan 48/48 setelah #298.
- **S5:** kelima pengamatan lulus pada image produksi.
- **S6:** milik pemilik setelah merge ke `main`. Rinciannya ada di komentar #297 dan #298.

Diserahkan ke pemilik:

1. merge PR #299;
2. deploy produksi lewat `docs/deploy.md`;
3. S6, yaitu `gh api repos/jefrykurniaone/sistem-informasi-manajemen-keuangan/dependabot/alerts/4` dan `/5`
   menunjukkan `"state": "fixed"`.

Tindak lanjut di luar run: #301 (komentar `scripts/`) dan #302 (test privasi yang flaky).
