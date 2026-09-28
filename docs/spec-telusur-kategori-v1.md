# Spec: telusur-kategori - Transaksi kategori Laporan Bulanan terbuka di bawah barisnya, per arah, tanpa melompat ke atas

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#266](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/266) |
| Run | `telusur-v1` |
| Peta eksekusi | belum dibuat |
| Disalin pada | 2026-09-29 |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Warga membuka Laporan Bulanan yang sudah terbit dan mengeklik "Lihat transaksi" pada satu kategori, supaya angka besar bisa ia periksa sendiri (cerita 20 spec `kas-laporan`). Per 2026-09-29, yang terjadi:

- **Layar melompat ke paling atas.** Daftar transaksinya muncul di bawah kedua tabel kategori. Pembaca harus menggulir melewati dua tabel untuk menemukannya, dan di ponsel tidak ada tanda bahwa sesuatu baru saja terbuka. Menutupnya juga melompat ke atas.
- **Kategori yang punya Koreksi muncul di dua tabel.** Di Data Contoh, "Perbaikan Rp 260.000" di tabel pemasukan ternyata Koreksi atas pengeluaran "Perbaikan engsel gerbang depan". Kedua baris Perbaikan sama-sama bertuliskan "Sedang dibuka". Daftarnya menggabungkan kas masuk dan kas keluar, sehingga jumlahnya tidak cocok dengan angka di baris mana pun.
- **Kata "Rincian" dipakai untuk dua hal.** Judul tabel "Rincian pemasukan per kategori" memakai *rincian* dalam arti daftar kategori. Kolom "Rincian" di dalamnya, "Tidak dirinci", dan "Tutup rincian" memakainya dalam arti daftar transaksi. Pemilik sendiri bertanya apa arti "Rincian: Tidak dirinci".
- **Tautannya tidak sejajar.** Pada baris yang punya tautan, barisnya lebih tinggi dan teks tautannya turun, tidak sejajar dengan nama kategori dan jumlahnya.
- **Pratinjau admin tidak menjelaskan sel kosong.** Kolom itu kosong untuk semua kategori selain iuran, tanpa penjelasan.

## Solution

- **Detail muncul di bawah baris yang diklik.** Mengeklik "Lihat transaksi" membuka daftar transaksi tepat di bawah baris itu, dan layar tidak bergeser. Hanya satu baris yang terbuka pada satu waktu.
- **Isinya hanya arah baris itu.** Daftarnya hanya berisi transaksi searah baris itu: kas keluar di tabel pengeluaran, kas masuk di tabel pemasukan. Dengan begitu jumlahnya sama dengan angka di baris.
- **Arah lain disebut, bukan disembunyikan.** Jika kategori itu juga punya transaksi di arah lain bulan itu, satu kalimat di dalam daftar menyebut jumlahnya. Kalimat itu menautkan ke sana bila arah itu punya baris sendiri di laporan.
- **Tutup dari dua tempat.** Baris yang terbuka bertuliskan "Tutup", dan tautan "Tutup" juga ada di ujung daftar. Membuka dan menutup tidak menggeser layar. Fokus papan ketik mengikuti bagian yang terbuka.
- **Kata yang lebih jelas.** Kolomnya menjadi "Transaksi". Kategori iuran bertuliskan "Tidak ditampilkan", dengan catatan kaki singkat tentang privasi.
- **Pratinjau admin menjelaskan dirinya.** Sel yang kosong bertuliskan "Tersedia setelah terbit".

## Goals and non-goals

**Goals**

- Membuka dan menutup transaksi sebuah kategori tidak memindahkan layar, dan detailnya berada di bawah baris yang diklik.
- Jumlah transaksi yang terbuka selalu sama dengan angka di baris itu, kecuali buku kas berubah setelah terbit. Dalam kasus itu, perbedaannya dinyatakan.
- Koreksi tidak pernah tersembunyi dari orang yang membuka sisi transaksi biasa sebuah kategori.
- Tidak ada lagi kata "rincian" untuk dua arti di tabel yang sama.
- Jalur tanpa JavaScript tetap sampai di baris yang dibuka.

**Non-goals**

- Menandai transaksi asli yang sudah dikoreksi ("Dikoreksi").
- Membuka lebih dari satu kategori sekaligus.
- Mengubah angka, pembekuan, atau revisi Laporan Bulanan.
- Mengubah aturan privasi iuran atau kolom yang dibawa setiap transaksi.

## User stories

1. Sebagai warga, saya ingin transaksi sebuah kategori muncul tepat di bawah barisnya, supaya saya tidak kehilangan tempat saat membukanya.
2. Sebagai warga di ponsel, saya ingin layar tidak melompat ke atas saat saya membuka atau menutup transaksi, supaya saya tidak perlu mencari lagi di mana saya tadi.
3. Sebagai warga, saya ingin transaksi di bawah baris pengeluaran hanya berisi kas keluar, supaya jumlahnya bisa saya cocokkan dengan angka di baris itu.
4. Sebagai warga, saya ingin transaksi di bawah baris pemasukan hanya berisi kas masuk, dengan alasan yang sama.
5. Sebagai warga yang membuka kategori pengeluaran yang punya Koreksi bulan itu, saya ingin diberi tahu bahwa ada Koreksi kas masuk beserta jumlah dan tautannya, supaya saya tidak mengira uang yang sudah dikoreksi benar-benar keluar.
6. Sebagai warga yang membuka baris Koreksi di tabel arah sebaliknya, saya ingin diberi tahu jumlah transaksi biasa kategori itu beserta tautannya, supaya saya bisa melihat sisi lainnya.
7. Sebagai warga yang membaca revisi yang terbit sebelum buku kas berubah, saya ingin transaksi arah lain yang tercatat setelah terbit tetap disebut, meski belum punya baris, supaya tidak ada yang tersembunyi.
8. Sebagai warga, saya ingin angka "diterbitkan" dan "buku kas saat ini" hanya muncul ketika keduanya berbeda, supaya detailnya ringkas ketika semuanya cocok.
9. Sebagai warga yang memakai pembaca layar atau papan ketik, saya ingin fokus pindah ke judul daftar yang baru terbuka, supaya saya langsung mendengar isinya.
10. Sebagai warga yang memakai pembaca layar atau papan ketik, saya ingin fokus kembali ke tautan "Lihat transaksi" baris itu saat saya menutupnya, supaya saya melanjutkan dari tempat yang sama.
11. Sebagai warga, saya ingin bisa menutup daftar dari barisnya atau dari ujung daftar, supaya daftar yang panjang tidak memaksa saya menggulir balik.
12. Sebagai warga yang pindah dari satu kategori terbuka ke kategori lain, saya ingin daftar yang baru terbuka tetap terlihat, meski daftar yang lama di atasnya runtuh.
13. Sebagai warga yang membuka tautan lama tanpa arah, saya ingin kategori itu tetap terbuka pada sisi transaksi biasanya.
14. Sebagai warga, saya ingin kolomnya bernama "Transaksi" dan iuran bertuliskan "Tidak ditampilkan" dengan alasan privasi, supaya saya paham tanpa bertanya.
15. Sebagai warga di ponsel selebar 390 piksel, saya ingin daftar transaksinya muat tanpa gulir mendatar.
16. Sebagai warga, saya ingin teks tautan sejajar dengan nama kategori dan jumlahnya, dengan area sentuh yang tetap mudah ditekan.
17. Sebagai admin yang melihat pratinjau sebelum terbit, saya ingin sel yang kosong menjelaskan bahwa transaksinya tersedia setelah laporan terbit.
18. Sebagai warga tanpa JavaScript, saya ingin membuka dan menutup transaksi membawa saya langsung ke baris itu.
19. Sebagai warga, saya ingin kategori iuran tetap tidak bisa dibuka, termasuk lewat alamat yang diketik sendiri, supaya pembayaran tiap rumah tidak terlihat.
20. Sebagai pengembang berikutnya, saya ingin glosarium menyatakan bahwa Koreksi selalu berlawanan arah dengan tipe Kategori Kas-nya, karena rancangan ini bergantung pada fakta itu.

## Implementation decisions

**1. Alamat membawa arah.**
- Bentuknya `?revision=N&category=<id>&type=income|expense`, ditambah `#` ke baris yang dibuka.
- Nama `type` dan nilainya mengikuti nilai tersimpan tipe Kategori Kas dan gaya parameter yang sudah ada (`revision`, `category`).
- Parameter dibaca longgar seperti dua parameter lainnya: nilai yang tidak dikenali dibuang, tidak ditolak.
- `type` tidak ada atau tidak dikenali: detail dibuka ke **tipe Kategori Kas-nya sendiri**. Jika tipe itu tidak punya baris di revisi ini, detail dibuka ke arah yang punya baris. Dengan begitu tautan lama dan alamat yang diketik sendiri membuka sisi transaksi biasa, bukan sisi Koreksi.
- `type` sah tetapi arah itu tidak punya baris di revisi ini: tidak ada yang dibuka. Jawaban ini sama dengan kategori yang tidak dikenal dan kategori iuran, dan itu disengaja. Membedakannya akan memberi tahu pembaca kategori mana yang ada, padahal laporan tidak menerbitkannya.

**2. Aturan pemisahan arah ada di server**, di layanan yang menyusun Laporan Bulanan untuk warga. Aturan "boleh dibuka atau tidak" sudah tinggal di layanan itu, dan tes privasinya sudah menguji detail kategori di sana. Detail yang dikirim hanya membawa transaksi arah yang dibuka. Bentuk keputusannya kira-kira begini (nama boleh berbeda, isinya tidak):

```ts
type Direction = 'income' | 'expense';

interface ReportCategoryDrilldown {
  categoryId: string;
  name: string;
  direction: Direction;              // arah yang dibuka
  isOwnDirection: boolean;           // true: arah ini = tipe Kategori Kas-nya; false: sisi Koreksi
  frozenTotal: Rupiah;               // angka baris ini saat terbit
  liveTotal: Rupiah;                 // arah yang sama menurut buku kas saat ini
  changedSincePublication: boolean;  // frozenTotal !== liveTotal, untuk arah ini saja
  entries: readonly CategoryTransaction[]; // hanya arah ini; enam kolom yang sama seperti sebelumnya
  otherDirection:
    | { kind: 'none' }
    | { kind: 'published'; total: Rupiah }     // arah lain punya baris di revisi ini: angka baris itu
    | { kind: 'sinceRevision'; total: Rupiah }; // arah lain hanya ada di buku kas saat ini
}
```

- Kolom setiap transaksi tetap enam: id, tanggal, tipe, keterangan, jumlah, dan penanda Koreksi. Tes privasi yang mengunci daftar kolom itu tidak diubah.
- `isOwnDirection` dibaca dari tipe Kategori Kas di basis data. Baris laporan yang dibekukan membawa arah per baris, tetapi tidak membawa tipe kategorinya.

**3. Tampilan.**
- Komponen tabel kategori menggambar sendiri baris yang terbuka dan satu baris detail selebar tabel tepat di bawahnya. Bagian "Transaksi kategori" di bawah kedua tabel dihapus dari halaman laporan warga.
- Isi baris detail, berurutan:
  - judul;
  - baris angka "Diterbitkan · Buku kas saat ini" dan pemberitahuan bahwa buku kas berubah, keduanya **hanya jika arah itu berubah**;
  - kalimat arah lain;
  - tabel tiga kolom (Tanggal, Keterangan, Jumlah) dengan penanda Koreksi di bawah keterangan, atau pesan kosong yang sudah ada;
  - tautan "Tutup".
- Kalimat arah lain punya tiga varian:
  - dari sisi tipe kategori sendiri, dengan arah lain yang punya baris: menyebut Koreksi, dengan tautan;
  - dari sisi Koreksi, dengan arah lain yang punya baris: menyebut arah itu, dengan tautan;
  - arah lain yang hanya ada di buku kas saat ini: tanpa tautan.

  Kata "Koreksi" hanya dipakai dari sisi tipe kategori sendiri. Dari arah itu, pernyataannya pasti benar. Dari sisi Koreksi, transaksi yang dikoreksi bisa saja ada di bulan lain.
- Area sentuh tautan tetap minimal 44 piksel, tetapi teksnya sejajar dengan nama kategori dan jumlah di baris yang sama.
- Di pratinjau admin, sel yang akan bisa dibuka setelah terbit bertuliskan "Tersedia setelah terbit" dengan warna redup. Sel iuran tetap "Tidak ditampilkan".

**4. Scroll dan fokus.** Per 2026-09-29, repo ini belum punya contoh pengaturan fokus atau scroll setelah navigasi, jadi pola ini baru.
- Semua tautan buka, tutup, dan pindah arah memakai `data-sveltekit-noscroll` dan `data-sveltekit-keepfocus`, dan href-nya membawa `#` ke baris itu. Scout memastikan perilaku SvelteKit 2.70 yang terpasang:
  - `noscroll` mempertahankan posisi dan mengabaikan `#`;
  - tanpa `keepfocus`, SvelteKit memindahkan titik awal fokus ke `#` lewat `location.replace` lalu mengembalikan posisi scroll, sehingga layar bisa berkedip;
  - tanpa JavaScript, browser melompat ke `#` seperti biasa.
- Setelah navigasi, halaman memindahkan fokus sendiri:
  - saat membuka, dan saat pindah dari satu kategori ke kategori lain: ke judul detail. Judul diberi `tabindex="-1"`. Fokus tanpa `preventScroll`, sehingga judul yang terdorong ke luar layar (karena daftar lama di atasnya runtuh) digulir masuk;
  - saat menutup: ke tautan "Lihat transaksi" baris itu, dan baris itu digulir ke tampilan.

**5. Kata.** Semua teks ada di katalog `id` dan `en`, tanpa em dash. Kunci yang tidak terpakai lagi dihapus, termasuk "Sedang dibuka", dua kolom kas masuk/kas keluar, dan empat kalimat diterbitkan/buku kas per arah.

| Tempat | Indonesia | English |
|---|---|---|
| Judul kolom | Transaksi | Transactions |
| Sel iuran | Tidak ditampilkan | Not shown |
| Catatan kaki iuran | Transaksi iuran tidak ditampilkan demi privasi tiap rumah. | Dues transactions are hidden to protect each house's privacy. |
| Tautan buka | Lihat transaksi (tetap) | See the transactions (tetap) |
| Tautan tutup, di baris dan di ujung detail | Tutup | Close |
| Nama tautan tutup untuk pembaca layar | Tutup transaksi {kategori} | Close the transactions in {category} |
| Judul detail | Kas keluar kategori {kategori} / Kas masuk kategori {kategori} | {category}: money out / {category}: money in |
| Baris angka, hanya jika berubah | Diterbitkan: {jumlah} · Buku kas saat ini: {jumlah} | As published: {amount} · In the cash book now: {amount} |
| Kolom detail | Tanggal · Keterangan · Jumlah | Date · Description · Amount |
| Arah lain, dari sisi tipe kategori sendiri | Kategori ini juga punya Koreksi kas masuk {jumlah} bulan ini. **Lihat Koreksinya** | This category also has {amount} of corrections (money in) this month. **See the corrections** |
| Arah lain, dari sisi Koreksi | Kategori ini juga punya kas keluar {jumlah} bulan ini. **Lihat transaksinya** | This category also has {amount} money out this month. **See those transactions** |
| Arah lain yang muncul setelah terbit | Sejak revisi ini terbit, buku kas mencatat kas masuk {jumlah} di kategori ini. Angka itu akan masuk pada revisi berikutnya. | Since this revision was published, the cash book has recorded {amount} money in for this category. It will appear in the next revision. |
| Pratinjau admin, sel kosong | Tersedia setelah terbit | Available once published |

Kalimat arah lain punya varian untuk kedua arah: kas masuk atau kas keluar, dan Koreksi kas masuk atau Koreksi kas keluar. Judul tabel "Rincian pemasukan/pengeluaran per kategori", pemberitahuan perubahan, pesan kosong, dan penanda Koreksi tidak berubah.

**6. Glosarium.** Definisi **Koreksi** di `CONTEXT.md` ditambah satu kalimat: "Arahnya selalu berlawanan dengan tipe Kategori Kas-nya." Per 2026-09-29, fakta ini hanya tertulis di komentar kode, padahal rancangan ini bergantung padanya.

## Testing decisions

Tes yang baik di sini memanggil dari luar dan memeriksa hasil yang terlihat. Ada dua seam, dan keduanya sudah ada.

**1. Layanan Laporan Bulanan untuk warga**, di tes privasi laporan yang sudah punya blok "drilling into a category". Kasus wajib:
- Membuka dengan arah menghasilkan hanya transaksi arah itu, dan jumlahnya sama dengan angka baris itu.
- Arah tidak ada: detail jatuh ke tipe Kategori Kas-nya. Jika tipe itu tidak punya baris, detail jatuh ke arah yang punya baris.
- Arah sah tetapi tanpa baris: `null`.
- Ringkasan arah lain dalam ketiga varian: tidak ada, punya baris (angka baris), dan hanya di buku kas saat ini. Varian ketiga dibuat dengan mencatat transaksi arah lain di bulan itu setelah laporan terbit.
- `isOwnDirection` benar untuk kedua sisi.
- `changedSincePublication` dihitung hanya untuk arah yang dibuka.
- Kategori iuran tetap `null` untuk kedua arah.
- Daftar kolom setiap transaksi tetap enam.
- Sapuan privasi yang sudah ada tetap lulus dengan detail terbuka.

**2. Alur Playwright laporan yang sudah ada** (admin menerbitkan, warga membuka dan menelusuri kategori), diperluas:
- Mengeklik "Lihat transaksi" di baris pengeluaran menampilkan judul detail di dalam tabel pengeluaran, tepat di bawah baris itu.
- `scrollY` sebelum dan sesudah klik sama.
- Fokus ada di judul detail.
- Mengeklik "Tutup" menghilangkan detail, dan fokus kembali ke "Lihat transaksi" baris itu.
- Tidak ada file e2e baru.

**Walk orchestrator** (Playwright MCP, dengan Data Contoh) untuk yang tidak dibuktikan tes:
- Pada 390 piksel, `scrollWidth <= clientWidth` saat detail terbuka.
- Teks tautan sejajar dengan nama kategori.
- Perbaikan menampilkan kalimat Koreksi dari sisi pengeluaran dan kalimat sebaliknya dari sisi pemasukan.
- Pratinjau admin menampilkan "Tersedia setelah terbit".
- Dengan JavaScript dimatikan, membuka transaksi mendarat di baris itu.

## Success criteria

- Di laporan warga, mengeklik "Lihat transaksi" di baris mana pun (kecuali iuran) memunculkan daftar transaksi tepat di bawah baris itu. `window.scrollY` tidak berubah, dan fokus ada di judul daftar.
- Daftar di bawah baris pengeluaran Perbaikan (Data Contoh) hanya berisi kas keluar. Jumlahnya sama dengan angka baris itu, dan daftar itu menyebut Koreksi kas masuk Rp 260.000 dengan tautan yang membuka baris pemasukan Perbaikan.
- Hanya satu baris yang bertuliskan "Tutup" pada satu waktu. "Sedang dibuka" tidak muncul di mana pun.
- "Tutup" di baris dan di ujung daftar sama-sama menutupnya tanpa menggeser layar, dan fokus kembali ke "Lihat transaksi" baris itu.
- Alamat `?category=<id>` tanpa `type` membuka sisi transaksi biasa kategori itu.
- Alamat yang membuka kategori iuran, dengan arah apa pun, tidak membuka apa pun.
- Kolomnya bernama "Transaksi" dan iuran bertuliskan "Tidak ditampilkan", dengan catatan kaki versi baru, dalam kedua bahasa.
- Pada 390 piksel dengan detail terbuka, halaman laporan warga tidak menggulir mendatar.
- Pratinjau admin menampilkan "Tersedia setelah terbit" di setiap sel kategori yang bukan iuran.
- Definisi Koreksi di `CONTEXT.md` menyebut arahnya.
- Gerbang mutu repo lulus.

## Out of scope

- Penanda "Dikoreksi" pada transaksi asli yang sudah dibalik. Untuk ini payload perlu kolom baru dan tes privasi harus diubah; bisa jadi pekerjaan lanjutan.
- Membuka lebih dari satu kategori sekaligus.
- Perubahan lain di Laporan Bulanan: angka, revisi, ringkasan iuran, dan pemilih periode.
- Halaman Buku Kas dan halaman admin lain selain pratinjau laporan.

## Further notes

- Fakta yang menopang pemisahan arah: menurut glosarium, Kategori Kas bertipe masuk *atau* keluar. Per 2026-09-29, komentar di layanan komposisi laporan menyatakan bahwa sebuah transaksi berlawanan arah dengan kategorinya tepat ketika ia Koreksi. Keputusan 6 memindahkan fakta itu ke glosarium.
- Per 2026-09-29, satu-satunya pembuat tautan detail adalah tabel kategori itu sendiri dan tautan tutupnya. Tidak ada notifikasi atau email yang menautkan ke sebuah kategori, jadi mengubah bentuk alamat tidak mematahkan tautan di luar aplikasi selain bookmark. Bookmark itu ditangani oleh aturan jatuh-balik di keputusan 1.
- Rancangan ini lahir dari pertanyaan pemilik tentang "Rincian: Tidak dirinci" dan layar yang melompat ke atas, 2026-09-28 dan 2026-09-29.

