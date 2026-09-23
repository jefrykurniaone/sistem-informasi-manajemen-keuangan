# Spec: shell-beranda - Sidebar navigasi dan Beranda per peran

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#127](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/127) |
| Run | `poles-v1` |
| Peta eksekusi | [#146](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/146) |
| Riset pendukung | [docs/research-ui-ux-v1.md](./research-ui-ux-v1.md) |
| Disalin pada | 2026-09-20 |
| Lintasan penutup | 2026-09-23: keputusan hover-intent yang dibalik run `uji-v1` ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Menu aplikasi hari ini adalah dua kotak lipat di atas halaman. Isinya baru muncul setelah diklik,
tujuh belas tautan "Kelola" tumpah dalam satu daftar tanpa urutan yang bermakna, sub-item hanya
teks yang menjorok, dan tidak ada tanda halaman mana yang sedang dibuka. Di telepon menu itu menjadi
kolom panjang yang mendorong isi halaman ke bawah. Pengurus yang ingin memverifikasi Pembayaran harus
membaca semua tautan dulu.

Halaman pertama setelah masuk lebih buruk: ia masih halaman rangka dari awal proyek, berisi daftar
teknologi yang dipakai aplikasi. Warga yang masuk untuk melihat apakah iurannya sudah lunas tidak
mendapat jawaban di sana; pengurus tidak melihat apa yang menunggu ditangani.

## Solution

Sidebar di sisi kiri, seperti aplikasi pengelolaan pada umumnya. Di layar lebar ia selalu terlihat
dan bisa dilipat menjadi deretan ikon; di telepon ia laci yang dibuka dari tombol menu. Tautan
dikelompokkan menurut pekerjaan: Saya, Keuangan, Warga & Unit, Layanan, Sistem. Grup terbuka saat
tetikus melayang di atasnya dan menutup saat tetikus pergi; klik pada judul grup membuka atau
menutupnya secara manual; di telepon sentuhan melakukan hal yang sama. Hanya satu grup terbuka pada
satu waktu, dan grup yang memuat halaman aktif selalu terbuka saat halaman dimuat. Halaman aktif
ditandai dengan latar terisi.

Halaman pertama menjadi Beranda: ringkasan untuk peran yang masuk. Warga melihat Tagihan rumahnya,
Saldo Titipan, Keluhan aktifnya, dan terbitan terbaru. Admin dan superuser melihat angka bulan ini:
Tagihan terbit, lunas, dan menunggak; Pembayaran yang menunggu verifikasi; saldo kas dan arus bulan
ini; Keluhan terbuka per status; terbitan terbaru; dan status job terjadwal terakhir. Setiap angka
adalah tautan ke layar yang menanganinya. Pengunjung yang belum masuk diarahkan ke halaman masuk.

## Goals and non-goals

**Goals**

- Setiap tautan dapat dicapai dalam paling banyak dua aksi dari mana pun.
- Grup terbuka pada hover di desktop dan pada sentuhan di telepon, dengan perilaku yang dapat
  diprediksi: buka setelah 300 ms melayang, tutup setelah 500 ms pergi, tidak menutup saat pointer
  pindah ke isi grup, Escape menutup.

  > [!note] Dibalik oleh run `uji-v1`
  > Hover-intent dihapus seluruhnya (#174, spec `shell-masuk` v1). Grup terbuka hanya lewat klik, sentuhan, Enter, atau Spasi; melayangkan pointer tidak membuka atau menutup apa pun, dan Escape tetap menutup panel melayang.

- Halaman aktif dan grupnya selalu terlihat saat halaman dimuat, tanpa aksi pengguna.
- Beranda menjawab satu pertanyaan per peran dalam satu layar: "apa yang harus saya lakukan?"
- Lebar 390 piksel tetap yang pertama dipikirkan: laci menutup setelah tautan dipilih, target
  sentuh minimal 44 piksel.

**Non-goals**

- Tidak ada pencarian menu.
- Tidak ada penyesuaian susunan menu per pengguna.
- Tidak ada grafik pada Beranda; angka dan tautan sudah cukup untuk 100 rumah.
- Tidak ada halaman publik ringan di alamat utama; papan pengumuman publik sudah ada.

## User stories

1. Sebagai admin, saya ingin melayangkan tetikus ke grup Keuangan dan langsung melihat isinya,
   tanpa klik.
2. Sebagai admin, saya ingin mengklik judul grup untuk membukanya dan mengklik lagi untuk
   menutupnya, dan hasilnya sama setiap kali.
3. Sebagai admin, saya ingin membuka satu grup menutup grup lain, supaya sidebar tidak memanjang.
4. Sebagai warga, saya ingin grup yang memuat halaman yang sedang saya buka sudah terbuka saat
   halaman dimuat, supaya saya tahu di mana saya berada.
5. Sebagai pengguna telepon, saya ingin tombol menu membuka laci dari kiri, dan memilih tautan
   menutup laci.
6. Sebagai pengguna desktop, saya ingin melipat sidebar menjadi ikon supaya tabel lebar mendapat
   ruang, dan pilihan itu diingat pada kunjungan berikutnya.
7. Sebagai pengguna desktop dengan sidebar terlipat, saya ingin melayangkan tetikus ke ikon grup
   dan melihat isinya melayang di samping ikon.
8. Sebagai pengguna keyboard, saya ingin menjelajah sidebar dengan Tab dan membuka grup dengan
   Enter, dan menutup panel melayang dengan Escape.
9. Sebagai warga, saya hanya ingin melihat grup dan tautan yang boleh saya buka.
10. Sebagai warga, saya ingin Beranda menunjukkan apakah rumah saya punya Tagihan yang belum lunas
    dan berapa jumlahnya, dengan tombol untuk melaporkan Pembayaran.
11. Sebagai warga, saya ingin melihat Saldo Titipan rumah saya di Beranda.
12. Sebagai warga, saya ingin melihat Keluhan saya yang masih berjalan dan statusnya.
13. Sebagai warga, saya ingin melihat tiga terbitan terbaru dan tombol untuk melapor Keluhan.
14. Sebagai admin, saya ingin melihat berapa Pembayaran yang menunggu verifikasi dan langsung
    menuju layar verifikasi dari angka itu.
15. Sebagai admin, saya ingin melihat jumlah dan nominal Tagihan bulan ini yang terbit, lunas, dan
    menunggak.
16. Sebagai admin, saya ingin melihat saldo kas berjalan serta total masuk dan keluar bulan ini.
17. Sebagai admin, saya ingin melihat Keluhan terbuka dikelompokkan per status.
18. Sebagai admin, saya ingin melihat kapan job terjadwal terakhir berjalan dan apakah berhasil,
    dalam WIB.
19. Sebagai superuser, saya ingin Beranda saya sama dengan admin ditambah apa pun yang hanya saya
    boleh lihat, tanpa halaman terpisah.
20. Sebagai pengunjung tanpa sesi, saya ingin alamat utama membawa saya ke halaman masuk.
21. Sebagai warga baru tanpa Unit, saya ingin Beranda menjelaskan bahwa rumah saya belum
    ditautkan, bukan menampilkan nol di mana-mana.

## Implementation decisions

**Sidebar dibangun di atas komponen Sidebar shadcn-svelte,** bukan markup sendiri. Komponen itu
sudah memberi laci telepon, mode ikon, penyimpanan status lipat di cookie tujuh hari, tooltip pada
mode ikon, dan sambungan keyboard. Menulis ulang semuanya berarti menulis ulang bug yang sudah
diperbaiki orang lain. Komponen yang ditambahkan: sidebar, collapsible, dropdown-menu, tooltip,
sheet. Pintasan keyboard bawaan `b` untuk melipat sidebar dimatikan, karena bentrok dengan Ctrl+B
tebal di editor Post (spec `post-editor`).

**Dua wajah grup, satu sumber data.** Susunan menu adalah satu struktur data (grup, item, aksi izin
yang mengaktifkannya, ikon). Pada sidebar lebar grup dirender sebagai collapsible dengan sub-item
menjorok dan rel kiri; pada sidebar terlipat grup dirender sebagai menu melayang dari ikon, karena
komponen shadcn tidak mendukung sub-item pada mode ikon dan masalah itu ditutup tanpa rencana
(riset §2). Komponen grup bercabang pada status sidebar dan apakah perangkat telepon.

**Hover-intent dengan angka dari riset.** Buka setelah 300 ms, tutup setelah 500 ms, pengatur waktu
tutup dibatalkan saat pointer masuk ke isi grup, Escape menutup (riset §1, WCAG 1.4.13). Hover tidak
pernah menjadi satu-satunya jalan: klik dan sentuh selalu bekerja. Status "terbuka" dipegang oleh
satu nilai di komponen sidebar, bukan oleh atribut `open` elemen HTML, supaya "satu grup terbuka"
dan "grup halaman aktif terbuka saat dimuat" bisa ditegakkan.

> [!note] Dibalik oleh run `uji-v1`
> Seluruh mekanisme di atas dihapus (#174): `nav-group.svelte` tidak lagi memegang `setTimeout`, penangan `onpointerenter`/`onpointerleave`/`onpointermove`, konstanta delay, atau status "dipin". `Collapsible.Root` dan `DropdownMenu.Root` kini terkontrol penuh oleh `app-sidebar.svelte` lewat `open`/`onOpenChange`; status "terbuka" tetap satu nilai per sidebar seperti semula, tetapi hanya diubah oleh klik, sentuhan, Enter, Spasi, Escape, dan pemilihan tautan.

**Grup tampil hanya bila minimal satu itemnya lolos izin.** Penyaringan memakai fungsi izin yang
sudah ada; menampilkan tautan tetap bukan otorisasi, dan setiap rute tetap memeriksa sendiri.

**Susunan grup dan urutannya:**

```
Beranda
Pengumuman & Kegiatan
Saya:          Unit Saya, Tagihan, Pembayaran, Laporan, Keluhan, Profil, Notifikasi
Keuangan:      Verifikasi Pembayaran, Catat Kas, Menunggak, Periode, Laporan Bulanan,
               Tarif, Kategori Kas, Saldo Awal, Pembebasan
Warga & Unit:  Unit, Impor Warga, Undangan, Pendaftaran, Peran
Layanan:       Kelola Post, Semua Keluhan
Sistem:        Jobs
Kaki:          pilihan bahasa, keluar
```

**Beranda adalah satu rute dengan dua muatan.** Alamat utama memuat data sesuai peran: pemegang izin
mengelola apa pun mendapat ringkasan pengurus, selainnya ringkasan warga. Tanpa sesi, dialihkan ke
halaman masuk. Halaman rangka lama dihapus, bukan disembunyikan.

**Agregasi Beranda tinggal di satu service baru,** bukan di pemuat halaman. Service itu menjawab
"ringkasan pengurus untuk bulan WIB ini" dan "ringkasan warga untuk Warga ini" dengan membaca tabel
yang ada (Tagihan, Pembayaran, Alokasi, Transaksi Kas, Keluhan, Post, riwayat job). Ia tidak
menulis apa pun. Alasannya: aturan "bulan ini" dan "menunggak" sudah ada di service Tagihan dan
Kas, dan Beranda harus memakai definisi yang sama, bukan menghitung ulang di rute. "Bulan ini"
memakai modul waktu spec `waktu-rupiah`.

> [!note] Dibalik oleh run `poles-v1`
> "Bulan ini" sebagai definisi tetap dari `civilMonthOf` di `$lib/time` (#139). Tapi label bulan
> yang ditampilkan ("September 2026") memakai `MONTH_LABEL_FORMAT`, sebuah `Intl.DateTimeFormat`
> lokal di `(app)/+page.server.ts` (#142), karena `$lib/time` tidak menyediakan pemformat nama
> bulan. Satu-satunya `Intl.DateTimeFormat` yang tersisa di rute setelah #143 membersihkan rute
> Post memang milik berkas ini.

**Kartu angka: nilai, label, tautan.** Setiap kartu memuat satu angka utama, label, dan tautan ke
layar yang menangani angka itu (riset §3). Tidak ada delta terhadap bulan lalu pada versi ini.

> [!note] Dibalik oleh run `poles-v1`
> Kartu Saldo Titipan menautkan ke `/invoices`, bukan ke layar Saldo Titipan tersendiri, karena
> layar itu belum ada (#142). Kartu "menunggak" memuat `AdminDashboard.invoices.overdueCount`
> (#139) untuk bulan WIB ini saja, sedangkan `/admin/overdue` menghitung semua periode; keduanya
> kebetulan sama hanya karena Data Contoh (#144) berisi satu bulan.

## Testing decisions

- **Service Beranda diuji langsung atas basis data uji**, tanpa HTTP: dengan Tagihan, Pembayaran,
  Transaksi Kas, dan Keluhan yang disiapkan tes, ringkasan pengurus mengembalikan hitungan dan
  nominal yang benar untuk bulan WIB yang diberikan `Clock` palsu, termasuk kasus tepi awal bulan
  WIB yang masih akhir bulan UTC. Ringkasan warga hanya memuat Unit milik Warga itu.
- **Penyaringan menu** diuji sebagai fungsi murni: himpunan peran masuk, daftar grup dan item
  keluar; warga tidak pernah mendapat grup Keuangan; grup tanpa item lolos tidak muncul.
- **Perilaku hover, klik, laci, dan mode ikon** adalah kriteria walk Playwright MCP orchestrator
  pada 1280 dan 390 piksel: melayang membuka grup, mengklik judul dua kali kembali ke keadaan awal,
  Escape menutup panel melayang, laci menutup setelah tautan dipilih, tidak ada gulir mendatar.

  > [!note] Dibalik oleh run `uji-v1`
  > Kriteria walk sejak #174: melayangkan pointer 1 detik di judul grup tidak membukanya; klik membuka, klik lagi menutup; mode ikon membuka panel melayang lewat klik pada pemicu ikon, bukan hover, dan Escape menutupnya.

- **Pengalihan tanpa sesi** diuji lewat e2e yang sudah ada untuk tata letak, diperbarui.
- Prior art: `tests/unit/authz.test.ts` untuk izin, `tests/unit/invoice-queries.test.ts` dan
  `tests/unit/running-balance.test.ts` untuk agregasi atas basis data uji, `tests/e2e/layout.spec.ts`.

## Success criteria

- Pada 1280 piksel: melayangkan pointer ke judul grup membuka isinya tanpa klik; klik judul
  membuka, klik lagi menutup; hanya satu grup terbuka; grup halaman aktif terbuka saat dimuat.
- Pada 390 piksel: tombol menu membuka laci, tautan menutupnya, tidak ada gulir mendatar, setiap
  target sentuh minimal 44 piksel.
- Sidebar terlipat: ikon dengan tooltip, hover ikon grup menampilkan panel melayang berisi item.

  > [!note] Dibalik oleh run `uji-v1`
  > Sejak #174, panel melayang di mode ikon terbuka lewat klik pada ikon pemicu, bukan hover; tooltip pada mode ikon tidak berubah.

- Beranda tanpa sesi mengalihkan ke halaman masuk; dengan sesi warga menampilkan kartu warga;
  dengan sesi admin menampilkan kartu pengurus; tidak ada teks tentang stack aplikasi.
- Setiap angka pada kartu cocok dengan layar tujuannya untuk data yang sama.
- Empat perintah gerbang lulus.

## Out of scope

- Grafik dan tren.
- Pencarian dan pintasan keyboard global.
- Pemberitahuan dalam aplikasi (lonceng).
- Halaman publik ringan di alamat utama.

## Further notes

Riset di `docs/research-ui-ux-v1.md` §1 sampai §3 adalah dasar angka hover-intent, pilihan
collapsible-plus-flyout, dan bentuk kartu. Spec ini bergantung pada modul waktu spec
`waktu-rupiah` untuk "bulan ini"; ia tidak menulis modul itu.

> [!note] Dibalik oleh run `uji-v1`
> Riset §1 tentang angka hover-intent tidak lagi dipakai sejak #174; §2 (collapsible-plus-flyout) dan §3 (bentuk kartu) tetap berlaku.
