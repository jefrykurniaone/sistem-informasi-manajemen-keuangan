# Spec: impor-xlsx - Impor Warga lewat XLSX dengan Template Impor

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#129](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/129) |
| Run | `poles-v1` |
| Peta eksekusi | belum ada — diisi Stage 5 |
| Riset pendukung | [docs/research-ui-ux-v1.md](./research-ui-ux-v1.md) |
| Disalin pada | 2026-09-20 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Impor Warga menerima berkas CSV dengan lima kolom berurutan. Pengurus menyusun data warga di
Excel, dan menyimpan-sebagai-CSV dari Excel berbahasa Indonesia menghasilkan pemisah titik koma,
tanda kutip yang tidak diharapkan, dan pengkodean yang merusak nama berhuruf khusus. Tidak ada
berkas contoh untuk diunduh; format hanya dijelaskan sebagai teks di layar, dan kesalahan urutan
kolom baru ketahuan setelah unggah.

## Solution

Aplikasi menyediakan Template Impor: berkas Excel yang diunduh dari halaman impor, berisi kepala
kolom yang benar, dua baris contoh, dan pilihan tetap untuk kolom peran huni. Pengurus mengisi
berkas itu di Excel dan mengunggahnya kembali apa adanya. Hanya berkas Excel yang diterima;
jalur CSV dihapus.

## Goals and non-goals

**Goals**

- Pengurus tidak pernah menebak nama dan urutan kolom.
- Berkas diisi dan diunggah tanpa langkah "simpan sebagai" apa pun.
- Validasi baris, pratinjau, dan konfirmasi transaksional yang ada tetap dipakai tanpa perubahan
  aturan.

**Non-goals**

- Tidak ada dukungan CSV lagi.
- Tidak ada impor Tagihan, Pembayaran, atau data selain Warga dan Unit.
- Tidak ada pemetaan kolom bebas; kepala kolom Template Impor adalah kontraknya.

## User stories

1. Sebagai admin, saya ingin mengunduh Template Impor dari halaman impor dengan satu klik.
2. Sebagai admin, saya ingin Template Impor terbuka di Excel dengan kepala kolom yang jelas dan dua
   baris contoh yang bisa saya timpa.
3. Sebagai admin, saya ingin kolom peran huni berupa pilihan tetap di Excel, supaya saya tidak
   mengetik "Pemilik" dengan huruf besar lalu ditolak.
4. Sebagai admin, saya ingin mengunggah berkas `.xlsx` dan melihat pratinjau per baris dengan
   masalahnya, seperti sekarang.
5. Sebagai admin, saya ingin berkas selain `.xlsx` ditolak dengan pesan yang menyebut format yang
   diterima.
6. Sebagai admin, saya ingin berkas yang kepala kolomnya diubah atau diurutkan ulang ditolak dengan
   pesan yang menyebut kolom yang diharapkan.
7. Sebagai admin, saya ingin lembar kedua atau baris kosong di akhir berkas diabaikan, bukan
   dihitung sebagai kesalahan.
8. Sebagai admin, saya ingin nomor rumah yang Excel ubah menjadi angka (`12` bukan `"12"`) tetap
   diterima sebagai teks.
9. Sebagai admin, saya ingin batas 500 baris tetap berlaku dan disebut di layar.

## Implementation decisions

**`exceljs` untuk membaca dan menulis.** Ia terawat di npm, membaca buku kerja dari buffer, dan
menulis validasi data berupa daftar pilihan pada sel (riset `docs/research-ui-ux-v1.md` §7).
SheetJS tidak dipilih karena tidak lagi merilis ke npm.

**Pembaca XLSX menghasilkan baris yang sama dengan pembaca CSV lama.** Lapisan validasi yang ada
menerima daftar record berkunci kolom; pembaca XLSX hanya mengganti penghasil daftar itu. Nilai sel
diubah ke teks sebelum validasi: angka menjadi teks tanpa desimal, rumus memakai hasilnya, sel
kosong menjadi teks kosong. Hanya lembar pertama yang dibaca; baris yang seluruh selnya kosong
dilewati. Alasannya: aturan validasi dan pesan masalahnya sudah diuji dan sudah dipakai; mengganti
format berkas tidak boleh mengubah aturannya.

**Template Impor dibuat saat diminta, bukan disimpan sebagai berkas statis.** Sebuah rute unduh
membangun buku kerja dengan kepala kolom dari konstanta yang sama yang dipakai validasi, dua baris
contoh, dan validasi daftar `pemilik,penyewa` pada kolom peran untuk seribu baris pertama.
Alasannya: satu sumber untuk kepala kolom; berkas statis akan usang saat kolom bertambah.

**Jalur CSV dihapus seluruhnya:** pengurai, pesan bantuan format CSV, dan fixture tes CSV. Kode
mati membingungkan tiket berikutnya, dan tidak ada pengguna yang memakainya.

**Batas unggah tetap.** Tipe MIME yang diterima adalah
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` dan ekstensi `.xlsx`; ukuran
mengikuti batas badan permintaan yang sudah ada.

## Testing decisions

- **Pembaca XLSX diuji dari buffer** yang dibuat tes sendiri dengan `exceljs`: sel angka menjadi
  teks, baris kosong dilewati, lembar kedua diabaikan, kepala kolom salah urutan ditolak dengan
  masalah yang menyebut kolom.
- **Template Impor diuji dengan dibaca balik**: rute menghasilkan buku kerja yang kepala kolomnya
  sama dengan konstanta validasi, memuat dua baris contoh, dan sel peran punya validasi daftar.
- **Pratinjau dan konfirmasi** diuji ulang dengan fixture `.xlsx` yang menggantikan fixture CSV,
  memakai tes impor yang ada.
- **Tombol unduh dan unggah** adalah kriteria walk Playwright MCP orchestrator: mengklik unduh
  mengembalikan berkas dengan tipe MIME XLSX; mengunggah fixture valid menampilkan pratinjau.
- Prior art: `tests/unit/import-csv.test.ts` (diganti), `tests/unit/import-validation.test.ts`,
  `tests/fixtures/`.

## Success criteria

- Halaman impor punya tombol unduh Template Impor yang menghasilkan `.xlsx` yang terbuka di Excel
  dengan dropdown pada kolom peran.
- Mengunggah Template Impor yang diisi menghasilkan pratinjau yang sama dengan CSV setara dulu.
- Berkas `.csv` ditolak dengan pesan.
- Tidak ada penyebutan CSV di kode, pesan, maupun fixture.
- Empat perintah gerbang lulus.

## Out of scope

- Impor entitas lain.
- Pemetaan kolom bebas dan deteksi kepala kolom otomatis.
- Ekspor data ke Excel.

## Further notes

Spec ini menyentuh `package.json` untuk `exceljs`; tiket itu run-exclusive. Tidak bergantung pada
spec lain.
