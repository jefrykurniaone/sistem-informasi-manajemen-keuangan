# Spec: papan-pengumuman v1 - Papan pengumuman tetap di dalam shell bersama sidebar untuk pengguna yang sudah masuk

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#311](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/311) |
| Run | `perdalam-v1` |
| Peta eksekusi | belum dibuat |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |

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

