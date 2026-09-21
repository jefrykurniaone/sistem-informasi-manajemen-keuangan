# Spec: waktu-rupiah - Helper waktu WIB dan input Rupiah berseparator

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#126](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/126) |
| Run | `poles-v1` |
| Peta eksekusi | [#146](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/146) |
| Riset pendukung | [docs/research-ui-ux-v1.md](./research-ui-ux-v1.md) |
| Disalin pada | 2026-09-20 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Aplikasi ini menampilkan waktu dalam tiga cara yang saling bertentangan. Jadwal job terjadwal sudah
berjalan menurut zona `Asia/Jakarta`, tetapi halaman yang menampilkan riwayat job mencetak jamnya
dalam UTC; detail Unit dan riwayat keuangan Unit juga mencetak UTC; penanda "berlaku hari ini" pada
Tarif menghitung harinya dalam UTC sehingga antara tengah malam dan pukul 07.00 WIB ia masih
menunjuk tarif kemarin. Pengurus yang membaca "23.00" pada satu layar dan "06.00" pada layar lain
untuk kejadian yang sama tidak bisa mempercayai keduanya.

Angka uang punya masalah serupa. Nilai Rupiah tampil dengan pemisah ribuan pada tabel dan kartu,
tetapi kotak isian nominal menerima digit polos: mengetik `1500000` untuk satu juta lima ratus ribu
memaksa orang menghitung nol, dan salah satu nol berarti salah sepuluh kali lipat pada Tarif atau
Pembayaran. Satu kotak isian bahkan memakai kontrol angka bawaan browser yang punya panah putar dan
bereaksi pada gulir roda tetikus.

## Solution

Satu cara menulis waktu dan satu cara menulis uang, dipakai di seluruh aplikasi.

Setiap waktu yang dilihat manusia ditampilkan dalam Waktu Indonesia Barat, dengan label "WIB" yang
tercetak, apa pun bahasa antarmuka dan apa pun zona mesin server atau browser. Setiap hari kalender
yang menentukan aturan bisnis ("hari ini", "bulan ini") dihitung menurut zona yang sama.

Setiap kotak isian nominal Rupiah memformat dirinya saat diketik: `1500000` langsung terlihat sebagai
`1.500.000`, dengan awalan `Rp` tercetak di sisi kiri kotak sebagai penanda, bukan sebagai bagian
nilai. Yang dikirim ke server tetap bilangan bulat tanpa pemisah, seperti sekarang.

## Goals and non-goals

**Goals**

- Satu zona waktu tampilan untuk seluruh aplikasi, dinamai sekali di satu modul bersama.
- Label "WIB" selalu tercetak pada waktu yang menampilkan jam, sehingga tidak ada tebakan.
- Satu komponen input Rupiah yang dipakai setiap form nominal, tanpa kecuali.
- Nilai yang tersimpan tidak berubah: Rupiah tetap bilangan bulat, waktu tetap `timestamptz`.

**Non-goals**

- Tidak ada pilihan zona waktu per pengguna. Komplek ini ada di satu zona.
- Tidak ada desimal pada Rupiah.
- Tidak ada pemisah ribuan pada angka yang bukan uang (nomor rumah, jumlah baris).

## User stories

1. Sebagai admin, saya ingin melihat jam terakhir sebuah job berjalan dalam WIB, supaya saya bisa
   mencocokkannya dengan jam di dinding.
2. Sebagai admin, saya ingin setiap waktu di riwayat Unit, riwayat keuangan, dan riwayat Keluhan
   berlabel WIB, supaya saya tidak perlu bertanya "ini jam mana".
3. Sebagai superuser, saya ingin penanda "berlaku hari ini" pada Tarif benar sejak pukul 00.00 WIB,
   bukan sejak pukul 07.00.
4. Sebagai admin, saya ingin melihat angka terformat saat saya mengetik nominal Tarif, Pembayaran
   tunai, Transaksi Kas, Saldo Awal, atau Pengembalian, supaya saya menangkap salah nol sebelum
   menyimpan.
5. Sebagai warga, saya ingin kotak nominal pada form Pembayaran memformat angka saya, supaya saya
   yakin jumlah yang saya laporkan sama dengan yang saya transfer.
6. Sebagai pengguna telepon, saya ingin kotak nominal membuka papan ketik angka, bukan papan ketik
   penuh.
7. Sebagai pengguna keyboard, saya ingin kursor tetap pada posisi yang wajar setelah pemisah
   ditambahkan, supaya mengetik di tengah angka tidak melompat.
8. Sebagai admin, saya ingin menempel `Rp 1.500.000` dari pesan WhatsApp ke kotak nominal dan
   melihatnya diterima sebagai satu juta lima ratus ribu.
9. Sebagai pengguna antarmuka bahasa Inggris, saya tetap ingin melihat "WIB" dan pemisah ribuan
   titik, karena uang dan waktu di komplek ini tidak ikut bahasa antarmuka.

## Implementation decisions

**Satu modul waktu bersama, di luar lapisan service.** Nama zona `Asia/Jakarta` yang hari ini
hidup di modul penerbitan Tagihan dipindahkan ke satu modul waktu yang boleh diimpor server maupun
browser. Modul itu menyediakan pemformat tanggal, tanggal-jam, dan pemformat "hari kalender WIB"
dari sebuah instan. Alasannya: setiap layar hari ini membangun `Intl.DateTimeFormat` sendiri dengan
zona yang berbeda-beda, dan kesalahan UTC sudah terjadi tiga kali di tiga layar; satu modul memutus
pola itu. Modul penerbitan Tagihan mengimpor ulang nama zona dari modul bersama, sehingga
nilai lamanya tidak berubah dan jadwal job tidak bergeser.

**Locale pemformatan waktu dikunci `id-ID`, terlepas dari bahasa antarmuka.** Riset
(`docs/research-ui-ux-v1.md` §8) membuktikan `id-ID` dengan `timeZoneName: 'short'` mencetak
"WIB", sedangkan `en-US` mencetak "GMT+7". Label "WIB" adalah tujuan, jadi locale pemformat bukan
pilihan bahasa pengguna. Bahasa antarmuka tetap Paraglide; hanya pemformat waktu yang dikunci.

**Hari kalender bisnis dihitung dalam zona komplek.** Fungsi yang menjawab "hari ini" dan "bulan
ini" untuk penanda Tarif dan ringkasan Keluhan bulanan berpindah ke zona komplek. Keputusan wave 14
bahwa dua konvensi hari kalender "hidup berdampingan dengan sengaja" dicabut oleh spec ini; catatan
keputusannya dimutakhirkan.

> [!note] Dibalik oleh run `poles-v1`
> Pencabutan ini dieksekusi oleh #137 (wave 2, merge `3e04ede`, PR #153): enam belas layar dan
> modul melepas pemformat UTC lokalnya dan memanggil `formatDay`/`formatDateTime` dari `$lib/time`;
> `currentDay(clock)` di `occupancy/visibility.ts` menjawab hari WIB lewat `civilDayOf`. Catatan
> keputusan wave 14 run `komplek-v1` tentang "dua konvensi hari kalender hidup berdampingan dengan
> sengaja" tidak berlaku lagi sejak #137.

**Satu komponen input Rupiah.** Sebuah komponen bersama menggantikan setiap kotak nominal. Kontrak:
menampilkan `Rp` sebagai adornment di kiri; memformat dengan pemisah ribuan titik saat mengetik;
menerima tempelan yang memuat `Rp`, spasi, dan titik; menolak karakter selain digit; membuka papan
ketik angka di telepon; mengirim nilai bilangan bulat polos lewat `name` yang diberikan form, supaya
server yang sudah memakai `parseRupiah` tidak berubah. Kontrol angka bawaan browser tidak dipakai,
karena riset (§5) membuktikan `setSelectionRange` melempar `InvalidStateError` pada `type="number"`
sehingga posisi kursor tidak bisa dijaga, dan kontrol itu bereaksi pada gulir roda tetikus.

**Posisi kursor dijaga dengan menghitung digit di kiri kursor,** bukan selisih panjang string. Ini
satu-satunya cara yang tetap benar ketika pemisah disisipkan atau dihapus di sebelah kiri kursor.

**Pemformat angka tampilan tidak berubah.** `formatRupiah` yang ada tetap menjadi satu-satunya
pemformat tampilan; komponen input memakai logika pengelompokan yang sama supaya `1.500.000` di
kotak isian dan `Rp 1.500.000` di tabel selalu sama bentuknya.

## Testing decisions

- **Modul waktu diuji sebagai tabel kasus** dengan instan yang berada di sisi berbeda tengah malam
  WIB dan tengah malam UTC: tanggal kalender yang dikembalikan harus tanggal WIB, dan keluaran
  tanggal-jam harus memuat "WIB".
- **Penanda "berlaku hari ini" Tarif** diuji dengan `Clock` palsu pada pukul 01.00 WIB: tarif yang
  mulai berlaku hari itu harus ditandai berlaku.
- **Pengelompokan dan penguraian Rupiah** diuji di lapisan pustaka: setiap bentuk tempelan yang
  diterima (`Rp 1.500.000`, `1500000`, `1.500.000`, ` 1 500 000 `) menghasilkan bilangan bulat yang
  sama; huruf dan pecahan ditolak.
- **Perilaku kursor dan format saat mengetik** bukan pengujian unit; ia kriteria walk Playwright
  MCP orchestrator pada form yang memakai komponen: mengetik `1500000` menghasilkan tampilan
  `1.500.000`, dan nilai terkirim `1500000`.
- Prior art: `tests/unit/money.test.ts`, `tests/unit/ports-clock.test.ts`, dan pola `Clock` palsu
  di `tests/unit/dues-rate-service.test.ts`.

## Success criteria

- Tidak ada `timeZone: 'UTC'` yang tersisa pada pemformat tampilan mana pun.
- Setiap teks jam yang dilihat pengguna memuat "WIB".
- Setiap kotak isian nominal Rupiah memakai komponen bersama; `type="number"` tidak ada lagi pada
  nominal.
- Nilai yang diterima server dari setiap form nominal identik dengan sebelum spec ini untuk masukan
  yang sama.
- Empat perintah gerbang lulus.

## Out of scope

- Pilihan zona per pengguna.
- Format tanggal pada email yang sudah dikirim; email mengikuti helper yang sama hanya bila
  tiketnya menyentuh templat email, dan spec ini tidak.
- Kotak isian tanggal dan jam pada Post; itu milik spec `post-editor`, yang mengimpor modul waktu
  spec ini.

## Further notes

Spec ini tidak punya permukaan pengguna baru; ia landasan yang dibaca spec `shell-beranda`
(ringkasan "bulan ini" WIB) dan `post-editor` (penggabungan tanggal dan jam WIB). Karena itu ia
mendarat di gelombang pertama.
