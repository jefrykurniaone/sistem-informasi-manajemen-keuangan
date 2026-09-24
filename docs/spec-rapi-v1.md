# Spec: rapi - Koneksi Caddy, tata letak (app), teks tamu dua bahasa, deploy dengan pesan, penjadwal tahan koneksi putus

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#214](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/214) |
| Run | `rapi-v1` |
| Peta eksekusi | [#216](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/216) |
| Disalin pada | 2026-09-24 |
| Lintasan penutup | belum |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Run `uji-v1` meninggalkan delapan temuan di luar cakupannya, dan diagnosis salah satunya menemukan yang kesembilan. Semuanya kecil, tetapi masing-masing terasa oleh orang yang memakai aplikasi atau yang men-deploy-nya.

**Galat 500 di produksi.** Pengguna yang kembali ke aplikasi sesudah jeda kadang mendapat layar polos "500 Internal Error". Pemilik mengalaminya dua kali: sesudah memverifikasi email (2026-09-23 17:36 WITA), dan lagi pada 2026-09-24 09:52 WITA. Log Caddy mencatat satu kejadian lagi dari sebuah ponsel Android pada 00:27 WITA. Aplikasinya sendiri tidak pernah galat, dan container-nya tidak restart. Caddy mendapat `EOF` saat meneruskan permintaan `GET` ke aplikasi (chunk JavaScript dan `__data.json`), dalam 0,6 sampai 30 milidetik, lalu membalas 502. SvelteKit di peramban kemudian gagal memuat modul dan menampilkan halaman galat bawaannya. Penyebab di sisi aplikasi belum diketahui. Diukur 2026-09-24 di container produksi: aplikasi tidak menutup koneksi keep-alive yang menganggur dalam 150 detik, dan permintaan kedua di koneksi yang sama sesudah jeda sampai 110 detik selalu dijawab. Jadi ini bukan balapan batas waktu menganggur yang sederhana.

**Halaman `(app)` meluap di telepon.** Buku kas meluap mendatar pada lebar 390 piksel, sehingga seluruh halaman, termasuk judulnya, bisa digeser ke samping. Tabelnya sebenarnya sudah dibungkus wadah yang menggulir sendiri. Yang melebar adalah wadah utama halaman: ia rata tengah tanpa lebar pasti, jadi lebarnya mengikuti isi. Pola yang sama ada di halaman lain yang bertabel lebar (Laporan Bulanan admin dan warga, Impor), yang meluap begitu datanya cukup lebar.

**Dua landmark utama di setiap halaman `(app)`.** Pembungkus shell sidebar dan halaman di dalamnya sama-sama me-render `<main>`, sehingga pembaca layar mengumumkan dua landmark utama bersarang.

**Pengunjung tanpa sesi tidak bisa memakai bahasa Inggris.** Sejak shell hanya ada di `(app)`, pemilih bahasa hilang dari halaman masuk, daftar, lupa kata sandi dan halaman publik. Kalaupun ada, halaman `(auth)` tidak akan berganti bahasa: judul, label, paragraf dan tombolnya ditulis langsung dalam bahasa Indonesia, tidak lewat katalog.

**Em dash di email undangan.** Satu kalimat di email undangan warga masih memuat em dash. Tes penjaga em dash tidak membaca templat email, jadi kalimat itu lolos.

**Deploy yang gagal diam-diam.** Wizard `setup-env.sh` menerima `DATABASE_URL` yang kata sandinya belum di-percent-encode. `migrate` lalu keluar dengan kode 1 tanpa pesan apa pun, karena `drizzle-kit` menelan galat penguraian URL-nya. Deploy pertama berhenti di sini dan butuh diagnosis manual di VM.

**Kunci privat bisa ikut ke konteks build.** `.dockerignore` tidak menyaring `*.pem` dan `*.key`, sementara tahap `build` menyalin seluruh pohon. Kunci yang kebetulan tersimpan di dalam repositori ikut masuk ke lapisan image tahap `build` di mesin pembangun.

**Penjadwal rapuh saat koneksi basis data diputus.** Empat kali dalam sehari, Supabase memutus koneksi (`57P01`, "terminating connection due to administrator command") tepat saat penjadwal menulis klaim `job_runs`. Setiap kali, sisa tick itu batal, sehingga job lain yang urutannya sesudahnya ikut tidak dicoba. Dampaknya sejauh ini hanya tertunda 30 detik, dan tidak ada job yang hilang atau berjalan dua kali. Pool basis data masih memakai semua nilai bawaan: tanpa penangan galat untuk klien yang menganggur, sehingga proses bisa crash, dan tanpa batas waktu koneksi maupun query, sehingga penjadwal bisa berhenti diam-diam.

## Solution

Pengguna tidak lagi melihat layar 500 karena koneksi ke aplikasi putus di tengah jalan. Caddy mengulang permintaan `GET` atau `HEAD` yang gagal seperti itu, sedangkan permintaan lain tidak pernah diulang. Penyebab putusnya didiagnosis lewat reproduksi lokal. Kalau perbaikannya ada di konfigurasi proxy atau compose, perbaikan itu ikut dipasang. Kalau tidak, penyebabnya diajukan sebagai issue baru lengkap dengan buktinya.

Setiap halaman `(app)` terbaca pada 390 piksel tanpa gulir mendatar. Tabel lebar menggulir di dalam wadahnya sendiri, dan setiap halaman punya tepat satu landmark utama.

Pengunjung tanpa sesi menemukan pemilih bahasa yang sama di header halaman publik dan di atas form halaman masuk. Memilih English mengganti seluruh teks halaman `(auth)`, dan pilihan itu terbawa sesudah masuk.

Email undangan dibaca tanpa em dash, dan tes penjaga ikut membaca string di templat email.

Wizard menolak `DATABASE_URL` yang tidak terurai sebagai URL dan menawarkan untuk meng-encode kata sandinya, tanpa pernah menampilkan nilainya. Sebelum `drizzle-kit` berjalan, `migrate` memeriksa koneksinya lebih dulu dan mencetak penyebab kegagalan yang sebenarnya, juga tanpa URL.

Konteks build tidak lagi membawa `*.pem` dan `*.key`.

Penjadwal tetap berjalan dan tetap benar ketika koneksi basis data diputus dari sisi server. Kegagalan satu job tidak lagi melewatkan job lain. Klaim dan penyelesaian run diulang sekali untuk galat kelas koneksi, sedangkan job-nya sendiri tidak pernah diulang di dalam tick. Pool punya penangan galat dan batas waktu.

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

**Non-goals**

- Tidak ada halaman `+error.svelte` baru. Halaman galat yang lebih ramah adalah pekerjaan terpisah.
- Empat email tanpa locale (undangan, verifikasi email, atur ulang kata sandi, pendaftaran disetujui) tetap berbahasa Indonesia.
- Tidak men-deploy. Deploy ke VM tetap langkah pemilik sesudah run.
- Tidak mengubah perilaku pengulangan job yang gagal karena konfigurasi, misalnya `issue-invoices` tanpa Tarif (#218).

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

## Implementation decisions

**Koneksi Caddy ke aplikasi: mitigasi dulu, lalu diagnosis.** Caddy mengulang permintaan yang round-trip-nya ke upstream gagal, **hanya** untuk metode aman (`GET`, `HEAD`). `POST` dan metode lain tidak pernah diulang, karena aksi form bisa tidak idempoten. Mitigasi ini dipasang apa pun hasil diagnosisnya, karena pengguna berhenti melihat layar 500 walaupun penyebabnya belum ketemu. Diagnosisnya berupa reproduksi di Docker WSL dengan image produksi dan Caddy, dalam proyek compose dan port sendiri, tanpa menyentuh produksi. Yang dicari adalah kondisi yang membuat koneksi mati: jeda, permintaan bersamaan, berkas statis dengan cookie atau kompresi, HTTP/3 di sisi klien. Kalau perbaikan penyebabnya ada di Caddyfile atau compose, ia dipasang di run ini. Kalau ada di tempat lain, misalnya versi Bun, ia menjadi issue baru. Tiket ini satu-satunya tiket run yang executor-nya boleh menjalankan Docker.

**Lebar halaman `(app)`.** Wadah utama halaman yang rata tengah mendapat lebar penuh sebagai lebar pasti, dibatasi oleh lebar maksimum yang sudah ada. Ini sudah menjadi pola di sebagian halaman `(app)` dan kini berlaku di semuanya, termasuk halaman yang hari ini belum meluap. Pembungkus tabel yang menggulir sendiri tetap dipakai, dan komentar yang keliru menyatakan bahwa ia sudah cukup dibetulkan. Kalau pengukuran menunjukkan pembungkus shell ikut melebar, pembungkus itu diberi lebar minimum nol lewat kelas di layout `(app)`, tidak di komponen shadcn.

**Satu landmark utama.** Pembungkus shell sidebar (komponen shadcn yang disalin ke repositori) me-render elemen non-landmark. Setiap halaman tetap memegang `<main>`-nya sendiri, sama seperti pola yang sudah dicatat di layout `(public)`.

**Teks `(auth)` lewat paraglide.** Setiap teks terlihat di kelima halaman `(auth)` (masuk, daftar, lupa kata sandi, atur kata sandi, verifikasi) pindah ke katalog, dengan kunci baru di `id` dan `en`. Teks Indonesia tidak diubah kata per kata, sehingga e2e yang ada, yang berjalan di locale dasar `id`, tetap lulus tanpa diubah. Kunci baru mengikuti penamaan yang sudah ada per halaman (`login_*`, `register_*` dan seterusnya).

**Pemilih bahasa tanpa sesi.** Komponen pemilih bahasa yang sama dipakai ulang, tanpa komponen baru dan tanpa kunci katalog baru. Letaknya di header `(public)` di samping tombol Masuk, dan di bagian atas kolom form `(auth)`. Pemilih tetap memanggil `setLocale` lewat cookie Paraglide, jadi pilihan sebelum masuk berlaku sesudah masuk.

**Em dash di email.** Kalimat email undangan ditulis ulang dengan titik atau koma sesuai maknanya, mengikuti gaya run `uji-v1`. Tes penjaga em dash diperluas ke templat email: komentar dibuang lebih dulu, dan U+2014 yang tersisa ditolak. Em dash di komentar kode tetap diizinkan.

**`DATABASE_URL` di wizard.** Wizard memeriksa bahwa nilainya terurai sebagai URL. Bila tidak, dan penyebabnya adalah karakter kata sandi yang belum di-encode, wizard menawarkan untuk meng-encode kata sandinya sendiri. Nilai asli dan hasilnya tidak pernah dicetak. Pemeriksaan ini ditambahkan di samping pemeriksaan skema, penanda contoh, port dan `sslmode` yang sudah ada.

**Pemeriksaan awal `migrate`.** Sebelum `drizzle-kit migrate`, sebuah skrip kecil mengurai `DATABASE_URL` dan mencoba tersambung dengan `pg`. Bila gagal, ia mencetak kategori dan kode galatnya (URL tidak terurai, autentikasi, TLS, host tidak terjangkau), lalu keluar dengan status bukan nol. URL dan kata sandi tidak pernah dicetak. Objek galat tidak dicetak utuh, karena galat penguraian URL dari Node membawa masukan aslinya, termasuk kata sandi. Skrip ini dibundel ke image dengan cara yang sama seperti `superuser:grant`, karena image produksi tidak memuat `src/`.

**Konteks build.** `.dockerignore` menyaring `*.pem` dan `*.key`, dan `.gitignore` ikut menyaring `*.key`. `.env` dan `.env.*` sudah tersaring.

**Penjadwal dan pool di bawah koneksi yang diputus.**
- Pool mendapat penangan galat yang mencatat kode tanpa membuat proses crash, batas waktu koneksi, keep-alive TCP, dan batas waktu query yang lebih panjang daripada query sah terpanjang.
- Setiap job dalam satu tick diisolasi: kegagalan klaim, run, atau penyelesaiannya dicatat dengan nama job dan kodenya, lalu job berikutnya tetap dicoba.
- Klaim, penyelesaian dan penandaan gagal diulang sekali untuk galat kelas koneksi, karena ketiganya idempoten terhadap kunci klaim dan status `running`. Job-nya sendiri tidak pernah diulang di dalam tick.
- Klaim yang ter-commit tetapi dilaporkan gagal akan bentrok saat diulang dan dilewati, lalu diambil alih sesudah lease habis. Kasus terburuknya tertunda, tidak pernah berjalan dua kali.

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
- Empat perintah gerbang lulus.

## Out of scope

- Halaman `+error.svelte` yang lebih ramah.
- Lokalisasi empat email tanpa locale.
- Deploy ke VM.
- Jeda untuk job yang gagal karena konfigurasi (#218).
- Email yang bisa terkirim dua kali bila penandaan terkirim gagal sesudah pengiriman SMTP.
- Access log Caddy dan pelaporan galat klien.

## Further notes

Kesembilan tiket adalah issue yang sudah ada: #186, #187, #189, #194, #198, #202, #212, #213, dan #215. #215 ditemukan saat mendiagnosis #213, lalu dimasukkan ke run atas keputusan pemilik sesudah peta #216 terbit. Laporan aslinya dibiarkan utuh, dan bagian tiket ditambahkan di bawahnya. Premis #186 dikoreksi di bagian tiketnya: tabel sudah dibungkus wadah yang menggulir sendiri sejak `707fc23`, dan yang melebar adalah wadah utama halaman. Premis #213 juga dikoreksi: galatnya bukan galat klien yang tak diketahui, melainkan 502 dari Caddy (`http.log.error` `EOF`). Pemeriksaan pertama tidak menemukannya karena yang dicari baris 5xx, bukan `EOF`. Versi pertama spec ini menyebut penyebabnya balapan batas waktu keep-alive. Pengukuran pada 2026-09-24 membantahnya, dan badan spec dikoreksi pada hari yang sama.
