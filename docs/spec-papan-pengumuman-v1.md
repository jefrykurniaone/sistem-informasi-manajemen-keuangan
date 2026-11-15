# Spec: papan-pengumuman v1 - Papan pengumuman tetap di dalam shell bersama sidebar untuk pengguna yang sudah masuk

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#311](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/311) |
| Run | `perdalam-v1` |
| Peta eksekusi | [#334](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/334) |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |
| Lintasan penutup | 2026-11-16, sesudah Gelombang 6 (`feat/perdalam-v1` @ `cac5bf0`): dibuat ulang dari item, yang kini memuat bagian "Catatan penyerahan" dengan klaim yang dibalik ditandai; tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-15, menu "Pengumuman" di sidebar mengarah ke papan pengumuman, yang berada di grup rute `(public)`. Grup itu memakai header ringan tanpa sidebar, keputusan #170, supaya pengunjung tanpa akun bisa membaca Post. Akibatnya, pengguna yang sudah masuk dan mengklik "Pengumuman" kehilangan sidebar: menunya pindah ke header di atas, dan menu lain tidak lagi terlihat di samping. Pemilik ingin menunya tetap di samping.

## Solution

- Pengguna yang sudah masuk dan biasa melihat sidebar membuka daftar Post dan detail Post di dalam shell aplikasi, dengan sidebar dan menu "Pengumuman" tetap tersorot.
- Pengunjung tanpa akun tetap melihat header ringan seperti sekarang.
- Alamat papan pengumuman dan detail Post tidak berubah, jadi tautan yang sudah dibagikan tetap berfungsi bagi keduanya.

## Goals and non-goals

**Goals**

- Papan pengumuman dan detail Post tampil di dalam shell untuk pengguna yang punya akses ke shell.
- Pengunjung tanpa akun tidak terpengaruh.

**Non-goals**

- Editor Post, daftar Post di admin, dan email Post tidak berubah.
- Halaman berhenti berlangganan tetap memakai header ringan untuk semua orang.
- Isi dan susunan kartu Post tidak berubah.

## User stories

1. Sebagai Warga yang sudah masuk, saya ingin mengklik "Pengumuman" tanpa kehilangan sidebar, supaya saya bisa langsung pindah ke menu lain.
2. Sebagai Warga yang sudah masuk, saya ingin menu "Pengumuman" tersorot selama saya di papan pengumuman dan detail Post.
3. Sebagai Warga yang membuka tautan Post dari email sambil sudah masuk, saya ingin Post itu tampil di dalam shell.
4. Sebagai pengunjung tanpa akun, saya ingin tetap bisa membaca papan pengumuman dengan header ringan seperti sekarang.
5. Sebagai Admin dan superuser, saya ingin perilaku yang sama dengan Warga.
6. Sebagai pengguna yang sudah masuk tetapi belum disetujui, saya ingin tetap melihat header ringan, karena saya belum punya akses ke shell.
7. Sebagai pengguna di ponsel, saya ingin laci sidebar di papan pengumuman bekerja seperti di layar lain.

## Implementation decisions

**1. Layout memilih tampilan dari sesi.**

- Layout grup `(public)` untuk papan pengumuman dan detail Post memilih antara shell aplikasi (komponen yang sama dengan grup `(app)`) dan header ringan, berdasarkan sesi.
- Halaman Post tetap di satu tempat, dan alamatnya tidak berubah.
- Yang mendapat shell adalah pengguna yang juga mendapat shell di grup `(app)`. Pengguna yang belum disetujui dan pengunjung tanpa akun mendapat header ringan.
- _Mengapa:_ memindahkan halaman ke grup `(app)` akan mengalihkan pengunjung tanpa akun ke halaman masuk, padahal #170 sengaja membuka papan pengumuman untuk umum.

**2. Satu landmark `main` per halaman** tetap berlaku (#187). Judul tab tetap lewat helper judul yang ada.

**3. Menu tersorot.** Item "Pengumuman" di sidebar tersorot pada papan pengumuman dan pada setiap detail Post.

## Testing decisions

- **Seam:** walk browser dengan Playwright MCP dan spec e2e papan pengumuman publik yang sudah ada.
- **E2E:** spec publik yang ada tetap hijau untuk pengunjung tanpa akun. Satu kasus baru: Warga yang sudah masuk membuka papan pengumuman dan melihat sidebar.
- **Walk browser:**
  - Masuk sebagai Warga di lebar desktop, klik "Pengumuman": sidebar ada dan menunya tersorot. Buka sebuah Post: sidebar tetap ada.
  - Ulangi di lebar 390 px: laci sidebar terbuka dan tertutup.
  - Keluar, lalu buka papan pengumuman: header ringan, tanpa sidebar.

## Success criteria

- Pengguna yang sudah masuk dengan akses shell melihat sidebar di papan pengumuman dan detail Post, dengan menu "Pengumuman" tersorot.
- Pengunjung tanpa akun melihat header ringan seperti sebelum run.
- Setiap halaman punya tepat satu landmark `main`.
- Gate repo dan e2e hijau, dan walk browser lulus.

## Out of scope

- Editor Post, admin Post, dan email Post.
- Halaman berhenti berlangganan.
- Grup `(auth)`.

## Further notes

- Sumber: permintaan pemilik di grilling run `perdalam-v1` (jawaban Q7) dan keputusan Q14.
- Keputusan #170 (shell hanya di grup `(app)`) dipersempit: papan pengumuman sekarang memakai shell bagi pengguna yang sudah masuk, dan tetap terbuka untuk umum.


## Catatan penyerahan (run perdalam-v1, 2026-11-16)

**1. Yang masuk.** Semua di `feat/perdalam-v1`, belum di `main` (PR run dibuka di tail, #334).

- #319 Papan pengumuman dan detail Post di dalam shell: merge `8693ad9` (kembalian `186e27a`) ke feat/perdalam-v1. `src/lib/server/app-shell.ts` (`loadShellState`, `awaitsApproval`); komponen `AppShell`; `(public)/posts/+layout.server.ts`.
- #336 Suite e2e masuk tepat di batas laju login: merge `18c19ff` ke feat/perdalam-v1. `tests/e2e/fixtures.ts` (`superuserPage`) dan `workers: 3` di `playwright.config.ts`.

**2. Klaim spec yang dibalik atau digeser run ini.** Tidak ada yang dihapus dari badan spec di atas.

- "Layout grup `(public)` ... memilih antara shell dan header ringan": pilihannya hidup di `(public)/posts/+layout.server.ts`, bukan di layout seluruh grup. Aturan siapa mendapat shell ada di satu tempat, `app-shell.ts`, dipakai layout `(app)` dan layout Post; halaman berhenti berlangganan tetap header ringan (#319).
- "spec publik yang ada tetap hijau": `tests/e2e/layout.spec.ts` dipindah dari `reads:` ke `writes:` karena satu tesnya memastikan perilaku yang dibalik spec ini. Dua kasus e2e baru digabung ke satu sesi di kasus admin yang sudah ada (#319).
- "Gate repo dan e2e hijau": kasus baru #319 sempat membuat suite 32 login per alamat per menit (batas 30), dan dua tes gagal karena batas laju. Setelah digabung, login kembali 30, tetapi suite tidak punya ruang sisa (#319). #336 menurunkannya: `superuserPage` sekali per worker, `workers: 3`, login 30 menjadi 17 ditambah satu per worker, jadi 20 per run (#336).
- Akibat #336: suite e2e kini bergantung pada Data Contoh (`superuser@komplek.local`), seperti `smoke` dan `dialogs` sebelumnya; dua run e2e berturut-turut dalam satu menit masih bisa melewati batas (#336).

**3. Cacat dan tindak lanjut yang diajukan.**

- #336 (di dalam run, ditutup): ditemukan di kembalian #319; suite e2e tanpa ruang sisa di bawah batas login. #328 sempat diblokir olehnya.
- Catatan operasional (#336, HANDOFF): jangan menjalankan dua `bun run test:e2e` dalam satu menit; kalau ragu, baca `rate_limit_buckets` (`login:address:::1`, kolom `hits`) secara baca-saja.

**4. Verifikasi.**

- Tidak ada tiket high-consequence di spec ini, jadi tidak ada verifikasi kedua. Walk #319 (Playwright MCP, laptop): `warga01` di 1440 px melihat sidebar, "Pengumuman & Kegiatan" `aria-current`, tepat satu `main`; di 390 px laci terbuka dan tertutup, tanpa luapan; sesudah keluar `/posts` tanpa sidebar dan dengan header "Masuk". Konsol 0 galat.
