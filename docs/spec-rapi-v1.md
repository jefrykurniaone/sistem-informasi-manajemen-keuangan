# Spec: rapi - Koneksi Caddy, tata letak (app), teks tamu dua bahasa, deploy dengan pesan, penjadwal tahan koneksi putus dan berjeda sesudah gagal

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#214](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/214) |
| Run | `rapi-v1` |
| Peta eksekusi | [#216](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/216) |
| Disalin pada | 2026-09-24 |
| Diamandemen | 2026-09-24: #218 masuk run, dan waktu WITA dikoreksi menjadi WIB |
| Lintasan penutup | 2026-09-25, sesudah Gelombang 4 (`e7bc418`) |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

Lintasan penutup menambahkan penanda *Sesudah run* di bawah garis pada setiap klaim yang dibalik
atau diubah bentuknya oleh tiket run ini. Tidak ada teks yang dihapus. Klaim yang ditandai:

- penyebab 502 `EOF` yang "belum diketahui" (#213);
- `<main>` yang mungkin butuh lebar minimum nol pada pembungkus shell (#186);
- skrip pemeriksaan awal `migrate` yang "dibundel" seperti `superuser:grant` (#202);
- pola `*.pem` dan `*.key` di `.dockerignore` (#194);
- periode dan jam yang "diformat menurut locale" di halaman Pekerjaan terjadwal (#218).

---
## Problem statement

Run `uji-v1` meninggalkan delapan temuan di luar cakupannya. Diagnosis salah satunya menemukan yang kesembilan, dan diagnosis yang kesembilan menemukan yang kesepuluh. Semuanya kecil, tetapi masing-masing terasa oleh orang yang memakai aplikasi atau yang men-deploy-nya.

**Galat 500 di produksi.** Pengguna yang kembali ke aplikasi sesudah jeda kadang mendapat layar polos "500 Internal Error". Pemilik mengalaminya dua kali: sesudah memverifikasi email (2026-09-23 16:36 WIB), dan lagi pada 2026-09-24 08:52 WIB. Log Caddy mencatat satu kejadian lagi dari sebuah ponsel Android pada 2026-09-23 23:27 WIB. Aplikasinya sendiri tidak pernah galat, dan container-nya tidak restart. Caddy mendapat `EOF` saat meneruskan permintaan `GET` ke aplikasi (chunk JavaScript dan `__data.json`), dalam 0,6 sampai 30 milidetik, lalu membalas 502. SvelteKit di peramban kemudian gagal memuat modul dan menampilkan halaman galat bawaannya. Penyebab di sisi aplikasi belum diketahui. Diukur 2026-09-24 di container produksi: aplikasi tidak menutup koneksi keep-alive yang menganggur dalam 150 detik, dan permintaan kedua di koneksi yang sama sesudah jeda sampai 110 detik selalu dijawab. Jadi ini bukan balapan batas waktu menganggur yang sederhana.

> *Sesudah run (2026-09-25):* penyebabnya ditemukan di #213, yaitu bug `node:http` di Bun 1.3.14, bukan konfigurasi Caddy atau compose. Kenaikan versi Bun diajukan sebagai #223, di luar run. Sampai #223 dikerjakan, `transport http { keepalive off }` di Caddyfile dipasang sebagai langkah sementara lewat PR #224, juga di luar run.

**Halaman `(app)` meluap di telepon.** Buku kas meluap mendatar pada lebar 390 piksel, sehingga seluruh halaman, termasuk judulnya, bisa digeser ke samping. Tabelnya sebenarnya sudah dibungkus wadah yang menggulir sendiri. Yang melebar adalah wadah utama halaman: ia rata tengah tanpa lebar pasti, jadi lebarnya mengikuti isi. Pola yang sama ada di halaman lain yang bertabel lebar (Laporan Bulanan admin dan warga, Impor), yang meluap begitu datanya cukup lebar.

**Dua landmark utama di setiap halaman `(app)`.** Pembungkus shell sidebar dan halaman di dalamnya sama-sama me-render `<main>`, sehingga pembaca layar mengumumkan dua landmark utama bersarang.

**Pengunjung tanpa sesi tidak bisa memakai bahasa Inggris.** Sejak shell hanya ada di `(app)`, pemilih bahasa hilang dari halaman masuk, daftar, lupa kata sandi dan halaman publik. Kalaupun ada, halaman `(auth)` tidak akan berganti bahasa: judul, label, paragraf dan tombolnya ditulis langsung dalam bahasa Indonesia, tidak lewat katalog.

**Em dash di email undangan.** Satu kalimat di email undangan warga masih memuat em dash. Tes penjaga em dash tidak membaca templat email, jadi kalimat itu lolos.

**Deploy yang gagal diam-diam.** Wizard `setup-env.sh` menerima `DATABASE_URL` yang kata sandinya belum di-percent-encode. `migrate` lalu keluar dengan kode 1 tanpa pesan apa pun, karena `drizzle-kit` menelan galat penguraian URL-nya. Deploy pertama berhenti di sini dan butuh diagnosis manual di VM.

**Kunci privat bisa ikut ke konteks build.** `.dockerignore` tidak menyaring `*.pem` dan `*.key`, sementara tahap `build` menyalin seluruh pohon. Kunci yang kebetulan tersimpan di dalam repositori ikut masuk ke lapisan image tahap `build` di mesin pembangun.

**Penjadwal rapuh saat koneksi basis data diputus.** Empat kali dalam sehari, Supabase memutus koneksi (`57P01`, "terminating connection due to administrator command") tepat saat penjadwal menulis klaim `job_runs`. Setiap kali, sisa tick itu batal, sehingga job lain yang urutannya sesudahnya ikut tidak dicoba. Dampaknya sejauh ini hanya tertunda 30 detik, dan tidak ada job yang hilang atau berjalan dua kali. Pool basis data masih memakai semua nilai bawaan: tanpa penangan galat untuk klien yang menganggur, sehingga proses bisa crash, dan tanpa batas waktu koneksi maupun query, sehingga penjadwal bisa berhenti diam-diam.

**Job yang gagal diulang tanpa jeda, di halaman yang sulit dipahami.** Run yang gagal tidak menahan kunci klaim, jadi job yang gagal karena konfigurasi dicoba lagi di setiap tick 30 detik dan menulis satu baris `job_runs` baru setiap kali, sekitar 2.880 baris sehari. Sejak 2026-09-23 16:15 WIB, `issue-invoices` gagal seperti itu karena belum ada Tarif yang berlaku pada 2026-09-01. Pemilik memutuskan penagihan mulai Oktober, jadi kegagalan September itu disengaja, tetapi ia tampil sebagai ribuan kegagalan. Halaman Pekerjaan terjadwal hanya menampilkan run terakhir. Nama job tampil sebagai identifier Inggris tanpa penjelasan, periode tampil sebagai stempel UTC mentah, galat Tarif tampil dalam bahasa Inggris, dan deskripsi halamannya menyatakan bahwa periode yang sudah dijalankan dilewati, padahal periode yang gagal justru diulang. Pemilik sendiri tidak bisa menjelaskan fungsi keempat job dari halaman itu.

## Solution

Pengguna tidak lagi melihat layar 500 karena koneksi ke aplikasi putus di tengah jalan. Caddy mengulang permintaan `GET` atau `HEAD` yang gagal seperti itu, sedangkan permintaan lain tidak pernah diulang. Penyebab putusnya didiagnosis lewat reproduksi lokal. Kalau perbaikannya ada di konfigurasi proxy atau compose, perbaikan itu ikut dipasang. Kalau tidak, penyebabnya diajukan sebagai issue baru lengkap dengan buktinya.

Setiap halaman `(app)` terbaca pada 390 piksel tanpa gulir mendatar. Tabel lebar menggulir di dalam wadahnya sendiri, dan setiap halaman punya tepat satu landmark utama.

Pengunjung tanpa sesi menemukan pemilih bahasa yang sama di header halaman publik dan di atas form halaman masuk. Memilih English mengganti seluruh teks halaman `(auth)`, dan pilihan itu terbawa sesudah masuk.

Email undangan dibaca tanpa em dash, dan tes penjaga ikut membaca string di templat email.

Wizard menolak `DATABASE_URL` yang tidak terurai sebagai URL dan menawarkan untuk meng-encode kata sandinya, tanpa pernah menampilkan nilainya. Sebelum `drizzle-kit` berjalan, `migrate` memeriksa koneksinya lebih dulu dan mencetak penyebab kegagalan yang sebenarnya, juga tanpa URL.

Konteks build tidak lagi membawa `*.pem` dan `*.key`.

Penjadwal tetap berjalan dan tetap benar ketika koneksi basis data diputus dari sisi server. Kegagalan satu job tidak lagi melewatkan job lain. Klaim dan penyelesaian run diulang sekali untuk galat kelas koneksi, sedangkan job-nya sendiri tidak pernah diulang di dalam tick. Pool punya penangan galat dan batas waktu.

Job yang gagal dicoba lagi dengan jeda yang makin panjang, bukan setiap 30 detik, sedangkan "Jalankan sekarang" tetap langsung berjalan. Halaman Pekerjaan terjadwal menjelaskan setiap job dalam bahasa yang dipilih pengguna, menampilkan periode dan jam yang bisa dibaca, menyebut berapa kali job gagal di periode ini dan kapan ia dicoba lagi, dan menerangkan galat Tarif beserta langkah perbaikannya.

## Goals and non-goals

**Goals**

- `GET` dan `HEAD` yang upstream-nya putus di tengah jalan diulang oleh Caddy dan tidak sampai ke pengguna sebagai 502. `POST` tidak pernah diulang.
- Penyebab putusnya koneksi Caddy ke aplikasi diketahui dan dicatat, atau reproduksinya dan batas yang sudah diperiksa tercatat di issue.
- `scrollWidth <= clientWidth` pada 390 piksel di setiap halaman `(app)` bertabel lebar, dengan Data Contoh.
- Tepat satu landmark `main` di setiap halaman `(app)`.
- Halaman `(auth)` sepenuhnya lewat paraglide, dengan terjemahan Inggris.
- Pemilih bahasa tersedia tanpa sesi di `(public)` dan `(auth)`.
- Nol em dash di string templat email, dijaga tes.
- `DATABASE_URL` yang tidak terurai berhenti di wizard, dan kegagalan koneksi `migrate` selalu punya pesan.
- `*.pem` dan `*.key` tidak pernah masuk konteks build.
- Koneksi basis data yang diputus server tidak membuat proses crash, tidak melewatkan job lain di tick yang sama, dan tidak pernah membuat job berjalan dua kali.
- Job yang gagal untuk satu periode dicoba lagi sesudah 1, 5 dan 25 menit, lalu setiap 60 menit, bukan di setiap tick. "Jalankan sekarang" tidak kena jeda.
- Halaman Pekerjaan terjadwal bisa dipahami tanpa membaca kode, dalam bahasa Indonesia dan Inggris.

**Non-goals**

- Tidak ada halaman `+error.svelte` baru. Halaman galat yang lebih ramah adalah pekerjaan terpisah.
- Empat email tanpa locale (undangan, verifikasi email, atur ulang kata sandi, pendaftaran disetujui) tetap berbahasa Indonesia.
- Tidak men-deploy. Deploy ke VM tetap langkah pemilik sesudah run.
- Tidak ada perubahan skema `job_runs`. Galat selain galat Tarif tidak diterjemahkan.
- Baris `failed` yang sudah menumpuk tidak dibersihkan. Pruning 90 hari yang membersihkannya.
- Menyimpan Tarif tidak memicu `issue-invoices`, dan ringkasan job di Beranda tidak berubah.

## User stories

1. Sebagai warga yang membuka aplikasi sesudah beberapa menit tidak aktif, saya ingin halaman langsung terbuka, supaya saya tidak mengira aplikasinya rusak.
2. Sebagai pengurus yang baru memverifikasi email, saya ingin masuk pertama kali tanpa galat, supaya kesan pertama saya pada aplikasi baik.
3. Sebagai pemilik, saya ingin kegagalan proxy ke aplikasi tidak lagi berakhir sebagai layar 500 yang tidak tercatat di log aplikasi, supaya galat yang tersisa berarti galat sungguhan.
4. Sebagai admin di telepon, saya ingin membaca Buku kas tanpa seluruh halaman bergeser ke samping, supaya judul dan saldo tetap terlihat.
5. Sebagai admin di telepon, saya ingin tabel yang lebar bisa digeser di tempatnya sendiri, supaya kolom-kolomnya tetap bisa dibaca.
6. Sebagai pengurus, saya ingin Laporan Bulanan dan Impor tidak meluap walaupun datanya lebar.
7. Sebagai pengguna pembaca layar, saya ingin setiap halaman punya satu landmark utama, supaya lompatan ke isi utama mendarat di tempat yang benar.
8. Sebagai calon warga yang berbahasa Inggris, saya ingin memilih English sebelum mendaftar, supaya saya mengerti form yang saya isi.
9. Sebagai pengunjung halaman pengumuman publik, saya ingin mengganti bahasa tanpa harus masuk.
10. Sebagai pengguna yang memilih bahasa sebelum masuk, saya ingin pilihan itu berlaku juga sesudah masuk.
11. Sebagai pengguna bahasa Inggris, saya ingin judul, label, paragraf, tombol dan tautan di halaman masuk, daftar, lupa kata sandi, atur kata sandi dan verifikasi semuanya berbahasa Inggris.
12. Sebagai warga yang diundang, saya ingin email undangan ditulis dengan tanda baca yang wajar.
13. Sebagai pemilik yang menyiapkan server, saya ingin wizard menolak `DATABASE_URL` yang kata sandinya belum di-encode, dan menawarkan untuk meng-encode-nya, supaya deploy tidak gagal di langkah yang tidak menjelaskan apa pun.
14. Sebagai pemilik, saya ingin kata sandi basis data tidak pernah tercetak di layar atau di log, baik oleh wizard maupun oleh `migrate`.
15. Sebagai pemilik yang men-deploy, saya ingin `migrate` yang gagal menyebut penyebabnya (URL tidak terurai, autentikasi, TLS, host), supaya saya tahu apa yang harus diperbaiki.
16. Sebagai pemilik, saya ingin kunci privat yang tidak sengaja tersimpan di pohon kerja tidak ikut ke konteks build Docker.
17. Sebagai pengurus, saya ingin Tagihan terbit dan email terkirim tepat waktu walaupun basis data sesekali memutus koneksi, supaya warga tidak menunggu.
18. Sebagai pemilik, saya ingin aplikasi tetap hidup dan penjadwal tetap berdetak sesudah koneksi basis data diputus, supaya saya tidak perlu me-restart container.
19. Sebagai pemilik, saya ingin job yang gagal karena konfigurasi tidak menulis ribuan baris sehari, supaya riwayat run tetap bermakna.
20. Sebagai pengurus yang baru mengisi Tarif, saya ingin menerbitkan Tagihan saat itu juga lewat "Jalankan sekarang", tanpa menunggu jeda habis.
21. Sebagai superuser, saya ingin tahu dari halaman Pekerjaan terjadwal apa fungsi setiap job, periode mana yang sedang dikerjakan, berapa kali ia gagal, dan kapan ia dicoba lagi.
22. Sebagai superuser yang memilih bahasa Inggris, saya ingin halaman itu, termasuk penjelasan galat Tarif, tampil dalam bahasa Inggris.

## Implementation decisions

**Koneksi Caddy ke aplikasi: mitigasi dulu, lalu diagnosis.** Caddy mengulang permintaan yang round-trip-nya ke upstream gagal, **hanya** untuk metode aman (`GET`, `HEAD`). `POST` dan metode lain tidak pernah diulang, karena aksi form bisa tidak idempoten. Mitigasi ini dipasang apa pun hasil diagnosisnya, karena pengguna berhenti melihat layar 500 walaupun penyebabnya belum ketemu. Diagnosisnya berupa reproduksi di Docker WSL dengan image produksi dan Caddy, dalam proyek compose dan port sendiri, tanpa menyentuh produksi. Yang dicari adalah kondisi yang membuat koneksi mati: jeda, permintaan bersamaan, berkas statis dengan cookie atau kompresi, HTTP/3 di sisi klien. Kalau perbaikan penyebabnya ada di Caddyfile atau compose, ia dipasang di run ini. Kalau ada di tempat lain, misalnya versi Bun, ia menjadi issue baru. Tiket ini satu-satunya tiket run yang executor-nya boleh menjalankan Docker.

**Lebar halaman `(app)`.** Wadah utama halaman yang rata tengah mendapat lebar penuh sebagai lebar pasti, dibatasi oleh lebar maksimum yang sudah ada. Ini sudah menjadi pola di sebagian halaman `(app)` dan kini berlaku di semuanya, termasuk halaman yang hari ini belum meluap. Pembungkus tabel yang menggulir sendiri tetap dipakai, dan komentar yang keliru menyatakan bahwa ia sudah cukup dibetulkan. Kalau pengukuran menunjukkan pembungkus shell ikut melebar, pembungkus itu diberi lebar minimum nol lewat kelas di layout `(app)`, tidak di komponen shadcn.

> *Sesudah run (2026-09-25):* pengukuran di #186 menunjukkan pembungkus shell tidak ikut melebar. `min-w-0` tidak ditambahkan, dan `src/routes/(app)/+layout.svelte` tidak disentuh.

**Satu landmark utama.** Pembungkus shell sidebar (komponen shadcn yang disalin ke repositori) me-render elemen non-landmark. Setiap halaman tetap memegang `<main>`-nya sendiri, sama seperti pola yang sudah dicatat di layout `(public)`.

**Teks `(auth)` lewat paraglide.** Setiap teks terlihat di kelima halaman `(auth)` (masuk, daftar, lupa kata sandi, atur kata sandi, verifikasi) pindah ke katalog, dengan kunci baru di `id` dan `en`. Teks Indonesia tidak diubah kata per kata, sehingga e2e yang ada, yang berjalan di locale dasar `id`, tetap lulus tanpa diubah. Kunci baru mengikuti penamaan yang sudah ada per halaman (`login_*`, `register_*` dan seterusnya).

**Pemilih bahasa tanpa sesi.** Komponen pemilih bahasa yang sama dipakai ulang, tanpa komponen baru dan tanpa kunci katalog baru. Letaknya di header `(public)` di samping tombol Masuk, dan di bagian atas kolom form `(auth)`. Pemilih tetap memanggil `setLocale` lewat cookie Paraglide, jadi pilihan sebelum masuk berlaku sesudah masuk.

**Em dash di email.** Kalimat email undangan ditulis ulang dengan titik atau koma sesuai maknanya, mengikuti gaya run `uji-v1`. Tes penjaga em dash diperluas ke templat email: komentar dibuang lebih dulu, dan U+2014 yang tersisa ditolak. Em dash di komentar kode tetap diizinkan.

**`DATABASE_URL` di wizard.** Wizard memeriksa bahwa nilainya terurai sebagai URL. Bila tidak, dan penyebabnya adalah karakter kata sandi yang belum di-encode, wizard menawarkan untuk meng-encode kata sandinya sendiri. Nilai asli dan hasilnya tidak pernah dicetak. Pemeriksaan ini ditambahkan di samping pemeriksaan skema, penanda contoh, port dan `sslmode` yang sudah ada.

**Pemeriksaan awal `migrate`.** Sebelum `drizzle-kit migrate`, sebuah skrip kecil mengurai `DATABASE_URL` dan mencoba tersambung dengan `pg`. Bila gagal, ia mencetak kategori dan kode galatnya (URL tidak terurai, autentikasi, TLS, host tidak terjangkau), lalu keluar dengan status bukan nol. URL dan kata sandi tidak pernah dicetak. Objek galat tidak dicetak utuh, karena galat penguraian URL dari Node membawa masukan aslinya, termasuk kata sandi. Skrip ini dibundel ke image dengan cara yang sama seperti `superuser:grant`, karena image produksi tidak memuat `src/`.

> *Sesudah run (2026-09-25):* #202 tidak membundel skrip ini. `scripts/migrate-preflight.ts` disalin ke image apa adanya, dan script `db:migrate` menjadi `bun scripts/migrate-preflight.ts && drizzle-kit migrate`, jadi perintah layanan `migrate` tidak berubah. Alasannya ada di komentar penutup #202.

**Konteks build.** `.dockerignore` menyaring `*.pem` dan `*.key`, dan `.gitignore` ikut menyaring `*.key`. `.env` dan `.env.*` sudah tersaring.

> *Sesudah run (2026-09-25):* pola di `.dockerignore` ditulis `**/*.pem` dan `**/*.key` (#194). `.dockerignore` mencocokkan pola terhadap akar konteks, jadi pola tanpa awalan tidak menyaring kunci di subdirektori.

**Penjadwal dan pool di bawah koneksi yang diputus.**
- Pool mendapat penangan galat yang mencatat kode tanpa membuat proses crash, batas waktu koneksi, keep-alive TCP, dan batas waktu query yang lebih panjang daripada query sah terpanjang.
- Setiap job dalam satu tick diisolasi: kegagalan klaim, run, atau penyelesaiannya dicatat dengan nama job dan kodenya, lalu job berikutnya tetap dicoba.
- Klaim, penyelesaian dan penandaan gagal diulang sekali untuk galat kelas koneksi, karena ketiganya idempoten terhadap kunci klaim dan status `running`. Job-nya sendiri tidak pernah diulang di dalam tick.
- Klaim yang ter-commit tetapi dilaporkan gagal akan bentrok saat diulang dan dilewati, lalu diambil alih sesudah lease habis. Kasus terburuknya tertunda, tidak pernah berjalan dua kali.

**Jeda sesudah job gagal.**
- Jeda berlaku per pasangan job dan periode, untuk semua job apa pun galatnya. Membedakan galat konfigurasi dari galat lain akan butuh kelas galat baru di modul email, sedangkan galat kelas koneksi sudah diulang sekali oleh perbaikan penjadwal di atas sebelum jeda berlaku.
- Tahapannya mengikuti pola antrean email yang sudah ada: 1 menit sesudah kegagalan pertama, lalu dikali lima, dan mentok di 60 menit (1, 5, 25, 60, 60, dan seterusnya). Galat sesaat pada tanggal 1 dicoba lagi semenit kemudian, sedangkan kegagalan yang menetap tercatat sekitar 24 kali sehari.
- Jumlah kegagalan dihitung dari baris `failed` pasangan itu, jadi tidak ada perubahan skema dan jeda tetap berlaku sesudah restart. Periode baru belum punya baris gagal, jadi langsung dicoba.
- Jeda hanya menahan tick. "Jalankan sekarang" tetap langsung berjalan, dan kegagalannya ikut dihitung. Untuk job berperiode satu menit (`email-queue-drain`), jeda paling-paling menahan tick kedua di menit yang sama.

**Halaman Pekerjaan terjadwal.**
- Semua teks lewat paraglide, dalam `id` dan `en`.
- Setiap job tampil dengan nama yang dibaca manusia dan satu kalimat fungsinya. Identifier-nya tetap tampil kecil, karena itu yang muncul di log.
- Periode dan jam diformat menurut locale, dalam WIB (zona kompleks).

  > *Sesudah run (2026-09-25):* hanya nama bulan pada periode bulanan yang mengikuti bahasa ("September 2026"). Tanggal dan jam memakai `formatDay` dan `formatDateTime` dari `src/lib/time.ts`, yang selalu berformat `id-ID` karena hanya locale itu yang mencetak `WIB` (keputusan 2 di berkas itu). Di `en` jam tampil sebagai "25 Sep 2026, 12.57 WIB" (#218).
- Bila run terakhir di periode berjalan gagal, halaman menyebut berapa kali pasangan itu gagal dan kapan paling cepat ia dicoba lagi.
- Galat Tarif dikenali dan kalimatnya disusun saat render dari periode run-nya, jadi ia mengikuti bahasa pengguna. Kalimat itu mengarahkan ke pengisian Tarif, lalu "Jalankan sekarang".
- Galat lain tampil sebagai teks aslinya di bawah label yang diterjemahkan. Menerjemahkannya butuh kode galat tersimpan, dan itu perubahan skema.
- Deskripsi halaman dibetulkan: periode yang berhasil dilewati, sedangkan periode yang gagal dicoba lagi dengan jeda.

## Testing decisions

Tes yang baik di sini menguji perilaku yang terlihat dari luar: apa yang dilihat pengguna di peramban, apa yang dicetak skrip, apa yang ada di image. Detail implementasi tidak diuji.

- **Koneksi Caddy ke aplikasi**: mitigasinya dibuktikan di Docker WSL dengan upstream yang sengaja memutus koneksi. `GET` sampai ke klien sebagai 200 lewat pengulangan, sedangkan `POST` tetap gagal dan tidak diulang. Kalau diagnosis menemukan kondisi reproduksi, reproduksinya dijalankan sebelum dan sesudah perbaikan. Orchestrator menjalankan ulang keduanya.
- **Lebar halaman dan landmark**: walk orchestrator dengan Playwright MCP pada build produksi dan Data Contoh, 390x844, mengukur `scrollWidth` terhadap `clientWidth` dan menghitung landmark `main`.
- **Teks `(auth)`**: e2e Playwright baru membuka setiap halaman `(auth)` dengan cookie locale `en` dan memeriksa teks Inggrisnya. Prior art: `tests/e2e/auth.spec.ts`. E2E yang ada tetap di `id`.
- **Pemilih bahasa**: walk orchestrator tanpa sesi di `/login` dan `/posts`.
- **Em dash**: tes unit penjaga yang sudah ada, diperluas.
- **Pemeriksaan awal `migrate`**: tes unit memanggil skrip dengan URL tidak terurai dan dengan host yang tidak terjangkau, memeriksa pesan dan status keluarnya, dan memastikan kata sandi tidak muncul di keluaran.
- **Wizard**: dicoba orchestrator di WSL dengan kata sandi yang belum di-encode. Tidak ada tes Vitest yang memanggil `bash`, karena `bash` di mesin pengembang crash sekitar 5% dan tes seperti itu akan tidak stabil.
- **Konteks build**: orchestrator menaruh `.pem` palsu di akar pohon, membangun `--target build` di Docker WSL, dan memastikan berkas itu tidak ada di image.
- **Penjadwal**: tes unit di Postgres uji memutus koneksi dengan `pg_terminate_backend`, baik koneksi yang membawa klaim maupun klien yang menganggur di pool. Yang diperiksa: job lain tetap berjalan, job yang terkena berjalan tepat sekali, dan tidak ada galat yang tak tertangani. Prior art: `tests/unit/scheduler-lock.test.ts` dan `tests/unit/scheduler-jobs.test.ts`.
- **Jeda**: tes unit di Postgres uji dengan jam palsu, lewat seam penjadwal yang sama. Yang diperiksa: percobaan berikutnya jatuh pada 1, 5, 25 dan 60 menit dan tidak di antaranya; "Jalankan sekarang" tidak tertahan; periode baru langsung dicoba; jeda satu job tidak menahan job lain; data halaman memuat jumlah kegagalan dan waktu percobaan berikutnya; galat Tarif dikenali dan menghasilkan kalimat `id` dan `en`.
- **Halaman Pekerjaan terjadwal**: walk orchestrator dengan Playwright MCP di `/admin/jobs`, locale `id` dan `en`, 1920 dan 390.

## Success criteria

- Dengan upstream yang memutus koneksi, `GET` lewat Caddy dijawab 200 sesudah diulang, dan `POST` tidak diulang.
- Penyebab putusnya koneksi tercatat di #213: diperbaiki, atau diajukan sebagai issue baru beserta reproduksinya.
- `scrollWidth <= clientWidth` pada 390 piksel di Buku kas, Laporan Bulanan admin, Laporan Bulanan warga dan Impor, dengan Data Contoh.
- Satu landmark `main` di halaman `(app)` yang diperiksa.
- Halaman `(auth)` dengan cookie `en` tidak memuat teks Indonesia yang tertinggal. E2E baru lulus, dan e2e lama lulus tanpa diubah.
- Pemilih bahasa terlihat di `/login` dan `/posts` tanpa sesi, dan memilih English mengganti teks halaman.
- Tes em dash gagal bila string templat email memuat U+2014, dan lulus pada kode sesudah perbaikan.
- `.pem` palsu tidak ada di image `--target build`.
- Wizard menolak kata sandi yang belum di-encode dan menawarkan meng-encode-nya. `migrate` dengan URL tidak terurai mencetak penyebabnya tanpa kata sandi.
- Koneksi yang diputus di tengah tick tidak melewatkan job lain, tidak membuat job berjalan dua kali, dan tidak membuat proses crash, dibuktikan tes.
- Job yang terus gagal untuk satu periode dicoba pada 1, 5 dan 25 menit, lalu setiap 60 menit, sedangkan "Jalankan sekarang" tetap langsung berjalan, dibuktikan tes.
- `/admin/jobs` di `id` dan `en` menampilkan nama dan fungsi keempat job tanpa stempel waktu ISO mentah, dan galat Tarif tampil sebagai kalimat dalam bahasa aktif.
- Empat perintah gerbang lulus.

## Out of scope

- Halaman `+error.svelte` yang lebih ramah.
- Lokalisasi empat email tanpa locale.
- Deploy ke VM.
- Kolom baru di `job_runs` (kode galat, hitungan percobaan) dan terjemahan galat selain galat Tarif.
- Menyimpan Tarif memicu `issue-invoices`, dan perubahan ringkasan job di Beranda.
- Membersihkan baris `failed` yang sudah menumpuk.
- Email yang bisa terkirim dua kali bila penandaan terkirim gagal sesudah pengiriman SMTP.
- Access log Caddy dan pelaporan galat klien.

## Further notes

Kesepuluh tiket adalah issue yang sudah ada: #186, #187, #189, #194, #198, #202, #212, #213, #215, dan #218. #215 ditemukan saat mendiagnosis #213, lalu dimasukkan ke run atas keputusan pemilik sesudah peta #216 terbit. #218 ditemukan saat mendiagnosis #215, dan dimasukkan dengan cara yang sama pada 2026-09-24 bersama amandemen spec ini. Laporan aslinya dibiarkan utuh, dan bagian tiket ditambahkan di bawahnya. Premis #186 dikoreksi di bagian tiketnya: tabel sudah dibungkus wadah yang menggulir sendiri sejak `707fc23`, dan yang melebar adalah wadah utama halaman. Premis #213 juga dikoreksi: galatnya bukan galat klien yang tak diketahui, melainkan 502 dari Caddy (`http.log.error` `EOF`). Pemeriksaan pertama tidak menemukannya karena yang dicari baris 5xx, bukan `EOF`. Versi pertama spec ini menyebut penyebabnya balapan batas waktu keep-alive. Pengukuran pada 2026-09-24 membantahnya, dan badan spec dikoreksi pada hari yang sama. Waktu di spec ini ditulis dalam WIB, zona kompleks. Versi sebelumnya keliru menulisnya dalam WITA, dan dikoreksi pada 2026-09-24.
