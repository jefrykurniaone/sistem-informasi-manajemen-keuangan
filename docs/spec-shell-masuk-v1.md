# Spec: shell-masuk - Shell hanya untuk yang masuk, sidebar klik, halaman masuk dua kolom

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#166](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/166) |
| Run | `uji-v1` |
| Peta eksekusi | [#181](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/181) |
| Disalin pada | 2026-09-22 |
| Lintasan penutup | 2026-09-23: klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Pengunjung yang belum masuk sudah disambut sidebar penuh: Beranda, Papan Pengumuman, Masuk, Daftar, lengkap dengan tombol lipat. Halaman masuk tampak seperti bagian dalam aplikasi yang bocor keluar, bukan pintu depan. Di layar lebar form masuk kecil di tengah ruang kosong, tanpa identitas komplek.

Setelah masuk, grup menu terbuka sendiri saat tetikus lewat. Pengurus yang menggerakkan pointer dari Beranda ke tabel melintasi sidebar dan grup-grup terbuka lalu tertutup di belakangnya. Yang diinginkan adalah menu yang diam sampai diklik.

Saat sidebar dilipat menjadi ikon, tombol merek "Komplek" masih memperlihatkan pinggir huruf K di samping ikonnya. Kecil, tapi terlihat setiap kali sidebar dilipat.

## Solution

Sidebar hanya ada untuk orang yang sudah masuk. Halaman masuk, daftar, lupa kata sandi, setel kata sandi, verifikasi, dan undangan memakai satu layout dua kolom: panel kiri berisi ilustrasi, nama komplek, dan satu kalimat tujuan aplikasi; kolom kanan berisi form. Di bawah 768 piksel panel kiri menjadi strip tipis di atas form yang hanya memuat nama komplek dan kalimatnya. Papan pengumuman publik dan halaman berhenti langganan memakai header ringan berisi nama komplek dan tombol Masuk, tanpa sidebar.

Grup menu terbuka hanya saat judulnya diklik, di sidebar lebar maupun mode ikon. Tidak ada pengatur waktu hover. Klik lagi menutup, Escape menutup panel melayang, memilih tautan menutup panel melayang dan laci telepon. Hanya satu grup terbuka pada satu waktu, dan grup yang memuat halaman aktif terbuka saat halaman dimuat, seperti sebelumnya.

Nama komplek dibaca dari satu variabel lingkungan publik dengan nilai bawaan "Komplek", dipakai pada merek sidebar, panel masuk, header publik, dan judul tab. Saat sidebar dilipat, merek menampilkan ikon saja tanpa sisa huruf.

## Goals and non-goals

**Goals**

- Tidak ada sidebar, tombol lipat, atau tautan menu pada rute `(auth)` dan `(public)`.
- Grup menu tidak pernah terbuka atau tertutup tanpa klik, sentuhan, atau keyboard.
- Halaman masuk terbaca sebagai pintu depan komplek, bukan halaman dalam.
- Lebar 390 piksel tetap yang pertama dipikirkan: form masuk tampil penuh tanpa gulir mendatar, target sentuh minimal 44 piksel.
- Nama komplek diganti di satu tempat tanpa menyentuh kode.

**Non-goals**

- Tidak ada perubahan pada isi, urutan, atau izin grup menu.
- Tidak ada perubahan pada Beranda.
- Tidak ada masuk lewat Google atau penyedia lain.
- Tidak ada halaman depan pemasaran; alamat utama tanpa sesi tetap dialihkan ke halaman masuk.

## User stories

1. Sebagai pengunjung tanpa sesi, saya ingin halaman masuk tanpa sidebar, supaya jelas bahwa saya belum berada di dalam aplikasi.
2. Sebagai pengunjung di layar lebar, saya ingin melihat nama komplek dan satu kalimat tentang aplikasinya di samping form masuk, supaya saya yakin ini alamat yang benar.
3. Sebagai pengunjung di telepon, saya ingin form masuk memenuhi layar dengan nama komplek di atasnya, tanpa ilustrasi yang mendorong form ke bawah.
4. Sebagai pengunjung, saya ingin halaman daftar, lupa kata sandi, dan undangan tampak sama dengan halaman masuk, supaya alurnya terasa satu.
5. Sebagai pembaca papan pengumuman publik, saya ingin header ringan dengan tombol Masuk, bukan sidebar aplikasi.
6. Sebagai admin, saya ingin grup menu tetap tertutup saat pointer saya melintasinya, supaya sidebar tidak berubah tanpa saya minta.
7. Sebagai admin, saya ingin mengklik judul grup untuk membukanya dan mengklik lagi untuk menutupnya, dengan hasil yang sama setiap kali.
8. Sebagai admin dengan sidebar terlipat, saya ingin mengklik ikon grup untuk melihat isinya melayang di samping, dan menutupnya dengan Escape, klik di luar, atau memilih tautan.
9. Sebagai pengguna keyboard, saya ingin Tab mencapai judul grup, Enter atau Spasi membukanya, dan Escape menutup panel melayang.
10. Sebagai warga, saya ingin grup yang memuat halaman yang sedang saya buka sudah terbuka saat halaman dimuat.
11. Sebagai pengguna desktop, saya ingin sidebar terlipat menampilkan ikon merek saja, tanpa potongan huruf di sampingnya.
12. Sebagai pengelola, saya ingin nama komplek diatur lewat satu variabel lingkungan, supaya aplikasi yang sama bisa dipasang untuk komplek lain tanpa mengubah kode.
13. Sebagai pengguna, saya ingin judul tab peramban menyebut nama komplek, bukan kata generik.

## Implementation decisions

**Shell pindah dari layout akar ke grup rute `(app)`.** Hari ini layout akar membungkus setiap rute dengan penyedia sidebar, sidebar, dan inset, termasuk `(auth)` dan `(public)`. Layout akar menjadi tipis: font, CSS global, dan `<html lang>`. Grup `(app)` mendapat layout sendiri yang memuat shell, dan pemuat data menu ikut pindah ke layout server `(app)` yang sudah ada. Alasannya: shell adalah properti "sudah masuk", dan `(app)` adalah grup yang sudah menegakkan sesi.

**Grup `(auth)` mendapat layout dua kolom sendiri.** Layout itu memuat panel merek dan slot form. Referensi bentuknya adalah blok login dua kolom shadcn, yang di desktop membagi layar dua dan di telepon menumpuk. Ilustrasi adalah satu komponen SVG buatan sendiri bertema komplek perumahan (atap rumah, jalan, pohon) dengan warna dari token tema, sehingga mengikuti mode gelap. Ilustrasi dibungkus satu komponen supaya menggantinya dengan foto berarti mengganti satu berkas, dan spec ini mencatat cara itu di runbook.

**Grup `(public)` mendapat header ringan.** Nama komplek di kiri, tombol Masuk di kanan, atau nama pengguna dan tautan Beranda bila ada sesi. Tanpa sidebar. Layout `(public)` yang ada dipertahankan dan ditambah header ini.

**Nama komplek adalah `PUBLIC_COMPLEX_NAME`,** dibaca lewat `$env/static/public` supaya tersedia di klien dan server, dengan nilai bawaan "Komplek" bila kosong. Kunci pesan `appShell_brand` digantikan oleh nilai ini. Judul tab memakai pola "Judul halaman - Nama komplek" lewat satu helper, bukan diketik ulang per halaman.

**Hover-intent dihapus seluruhnya dari komponen grup.** Pengatur waktu buka 300 ms dan tutup 500 ms, penanganan pointer masuk dan keluar, serta status "dipin" dihapus. Yang tersisa adalah satu status terbuka per sidebar yang diubah oleh klik, sentuhan, Enter, Spasi, Escape, dan pemilihan tautan. Mode ikon tetap memakai menu melayang dari ikon, dibuka oleh klik pada pemicu, bukan oleh pointer. Spec `shell-beranda` v1 menetapkan hover; keputusan ini membalikkannya dan salinan spec itu diberi tanda saat run ini ditutup.

**Merek di mode ikon menyembunyikan label.** Span label pada tombol merek disembunyikan saat sidebar terlipat, dan span teks pada tombol menu mendapat `min-w-0` supaya pemotongan bekerja di sidebar lebar. Yang diubah adalah komponen sidebar shadcn yang disalin ke repositori, bukan markup sendiri.

## Testing decisions

- **Penyaringan menu** tetap fungsi murni yang diuji di `tests/unit/menu.test.ts`; tidak berubah.
- **Layout tanpa sidebar** diuji e2e: `/login`, `/register`, dan `/posts` tidak memuat elemen sidebar; `/` dengan sesi memuatnya. Prior art: `tests/e2e/layout.spec.ts`, `tests/e2e/auth.spec.ts`, `tests/e2e/posts-public.spec.ts`.
- **Klik-saja** adalah kriteria walk Playwright MCP orchestrator pada 1920 dan 390 piksel: melayangkan pointer 1 detik di judul grup tidak membukanya; klik membuka; klik lagi menutup; mode ikon: klik ikon membuka panel melayang, Escape menutup; laci telepon menutup setelah tautan dipilih. Merek terlipat tidak memuat teks yang terlihat.
- **Halaman masuk** diperiksa walk pada 1920, 1280, dan 390 piksel: dua kolom di dua yang pertama, satu kolom dengan strip di 390, tidak ada gulir mendatar, target sentuh minimal 44 piksel.
- **Nama komplek** diuji unit pada helper judul: nilai bawaan saat variabel kosong.

## Success criteria

- `/login` tanpa sesi: tidak ada sidebar, panel merek memuat nama komplek dan kalimat tujuan, form masuk berfungsi.
- Enam halaman `(auth)` memakai layout yang sama.
- `/posts` tanpa sesi: header ringan dengan tombol Masuk, tanpa sidebar.
- Dengan sesi admin di 1920 piksel: hover tidak membuka grup, klik membuka, klik kedua menutup, satu grup terbuka, grup aktif terbuka saat dimuat.
- Sidebar terlipat: klik ikon grup membuka panel melayang, Escape menutup, merek tanpa sisa huruf.
- 390 piksel: laci menutup setelah tautan dipilih, tanpa gulir mendatar.
- Mengubah `PUBLIC_COMPLEX_NAME` mengubah merek, panel masuk, header publik, dan judul tab.
- Empat perintah gerbang lulus.

## Out of scope

- Perubahan isi menu, Beranda, atau izin.
- Masuk lewat penyedia pihak ketiga.
- Foto komplek sungguhan; hanya titik gantinya disiapkan.
- Pencarian menu dan pintasan keyboard global.

## Further notes

Spec ini membalikkan keputusan hover-intent dari `docs/spec-shell-beranda-v1.md`; lintasan salinan saat run ditutup menandainya. Riset `docs/research-ui-ux-v1.md` §1 tentang hover-intent tidak lagi dipakai, dan §2 tentang collapsible-plus-flyout tetap berlaku.
