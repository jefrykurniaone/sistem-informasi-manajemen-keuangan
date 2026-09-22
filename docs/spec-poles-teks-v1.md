# Spec: poles-teks - Dialog di tengah, Laporan Bulanan tanpa tombol pratinjau, teks dimanusiakan

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#167](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/167) |
| Run | `uji-v1` |
| Peta eksekusi | [#181](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/181) |
| Disalin pada | 2026-09-22 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---## Problem statement

Dialog konfirmasi (batalkan Tagihan, Pengembalian, lepas Alokasi, Koreksi kas, buka kunci Periode, ubah status Keluhan) muncul di pojok kiri atas layar, bukan di tengah. Elemen `<dialog>` native mengandalkan `margin: auto` dari peramban untuk memusatkan diri, dan Preflight Tailwind v4 me-reset margin semua elemen menjadi nol. Hanya dialog editor Post yang kebetulan menambah margin sendiri.

Di Laporan Bulanan, tombol "Lihat pratinjau" tidak mengubah apa pun: pratinjau periode terpilih sudah dirender saat halaman dibuka, dan tombol itu hanya mengirim ulang form GET dengan periode yang sama. Pengurus menekan tombol, tidak ada yang berubah, dan menyimpulkan ada yang rusak.

Teks antarmuka memakai em dash di tiga puluh kunci katalog dan beberapa judul tab, dan sebagian kalimatnya kaku seperti hasil terjemahan. Warga membaca teks itu setiap hari.

## Solution

Semua dialog modal terpusat di layar pada setiap ukuran viewport, lewat satu aturan CSS global sehingga dialog berikutnya otomatis benar.

Halaman Laporan Bulanan kehilangan tombol pratinjau. Mengganti periode di kotak pilihan langsung memuat halaman untuk periode itu, dan judul bagian pratinjau menyebut bulan yang sedang dilihat, misalnya "Pratinjau September 2026", supaya jelas apa yang ada di layar. Tombol terbitkan tidak berubah.

Teks antarmuka di kedua katalog bahasa dan teks terlihat di template ditulis ulang tanpa em dash, dalam kalimat yang wajar dibaca orang Indonesia sehari-hari. Komentar kode tidak disentuh.

## Goals and non-goals

**Goals**

- Setiap `<dialog>` modal berada di tengah viewport pada 1920 dan 390 piksel.
- Laporan Bulanan: satu aksi lebih sedikit, dan bulan yang dilihat selalu tertulis.
- Nol em dash di `messages/id.json`, `messages/en.json`, dan teks terlihat di berkas `.svelte`.
- Kalimat antarmuka terdengar seperti ditulis orang, bukan diterjemahkan mesin.

**Non-goals**

- Tidak mengubah komentar kode, dokumen di `docs/`, README, atau CONTEXT.md.
- Tidak mengganti `<dialog>` native dengan komponen dialog bits-ui.
- Tidak mengubah angka atau logika Laporan Bulanan.

## User stories

1. Sebagai admin, saya ingin dialog konfirmasi muncul di tengah layar, supaya mata saya langsung menemukannya.
2. Sebagai admin di telepon, saya ingin dialog itu tetap di tengah dan tidak terpotong di tepi layar.
3. Sebagai admin, saya ingin mengganti periode di Laporan Bulanan langsung menampilkan pratinjau periode itu, tanpa tombol tambahan.
4. Sebagai admin, saya ingin judul pratinjau menyebut bulan dan tahunnya, supaya saya tahu angka siapa yang sedang saya lihat.
5. Sebagai warga, saya ingin teks aplikasi dalam bahasa Indonesia yang wajar, tanpa tanda baca yang tidak lazim.
6. Sebagai pengguna bahasa Inggris, saya ingin katalog Inggris mendapat perlakuan yang sama.
7. Sebagai pengurus yang memeriksa perubahan, saya ingin melihat tabel sebelum dan sesudah untuk setiap teks yang diubah.

## Implementation decisions

**Satu aturan pada lapisan base di `src/app.css`:** `dialog:modal { margin: auto; }`, ditempatkan setelah impor Tailwind supaya menang atas Preflight. Enam dialog tidak diubah satu per satu; aturan global menutup dialog yang belum ditulis. `m-auto` yang sudah ada di editor Post tetap dibiarkan.

**Laporan Bulanan memuat ulang saat periode berubah.** Kotak pilihan periode mengirim form GET yang sama saat nilainya berubah; tombol submit dihapus dari markup dan kuncinya dari katalog. Tanpa JavaScript, form masih bisa dikirim dengan Enter, jadi tidak ada jalan yang hilang. Judul bagian memakai pemformat nama bulan yang sudah dipakai Beranda, bukan pemformat baru.

**Teks ditulis ulang, bukan disubstitusi.** Em dash diganti dengan koma, titik, atau kalimat baru sesuai makna, bukan dengan tanda hubung lain. Kalimat yang kaku ditulis ulang. Kunci katalog tidak diganti nama supaya tidak ada perubahan kode di luar teks. Judul tab yang memuat " — Komplek" mengikuti helper judul dari spec `shell-masuk` dan karena itu tiket teks tidak menyentuh bagian itu; ia hanya mengurus teks lain di template. Tabel sebelum dan sesudah dilampirkan pada pull request untuk ditinjau pemilik.

## Testing decisions

- **Pemusatan dialog** diuji e2e: membuka satu dialog (batalkan Tagihan pada Data Contoh) di 1920 dan 390 piksel, lalu membandingkan pusat `getBoundingClientRect` dialog dengan pusat viewport dengan toleransi 2 piksel. Prior art: `tests/e2e/payments.spec.ts` untuk masuk sebagai admin dan membuka layar.
- **Laporan Bulanan** diuji e2e yang sudah ada di `tests/e2e/reports.spec.ts`, diperbarui: tidak ada tombol pratinjau, judul memuat nama bulan, mengganti periode mengubah URL dan judul.
- **Teks** diuji sebagai pemeriksaan katalog: satu tes unit membaca kedua berkas katalog dan gagal bila ada U+2014. Prior art: tes yang membaca katalog paraglide bila ada, atau tes berkas biasa dengan `node:fs`.
- Walk orchestrator memastikan dialog terpusat secara visual di 1920 dan 390.

## Success criteria

- Enam dialog konfirmasi terpusat di 1920 dan 390 piksel, diukur.
- Halaman Laporan Bulanan tanpa tombol pratinjau; mengganti periode memuat ulang; judul menyebut bulan dan tahun.
- `rg` untuk U+2014 pada `messages/` dan teks terlihat di `src/**/*.svelte` menjawab nol.
- Tabel sebelum dan sesudah tersedia di pull request dan disetujui pemilik.
- Empat perintah gerbang lulus.

## Out of scope

- Komentar kode, `docs/`, README, CONTEXT.md.
- Mengganti sistem dialog.
- Perubahan angka atau alur terbit Laporan Bulanan.

## Further notes

Penyebab dialog adalah interaksi Preflight Tailwind v4 dengan `dialog:modal`; keputusan memakai `<dialog>` native dari run `komplek-v1` tetap berlaku.
