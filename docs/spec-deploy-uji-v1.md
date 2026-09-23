# Spec: deploy-uji - SMTP Gmail, image GHCR, compose produksi dengan Caddy, deploy ke Lightsail dan Supabase

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#168](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/168) |
| Run | `uji-v1` |
| Peta eksekusi | [#181](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/181) |
| Disalin pada | 2026-09-22 |
| Lintasan penutup | 2026-09-23: klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Aplikasi hanya pernah berjalan di mesin pengembang. Tidak ada cara memberi alamat kepada beberapa warga untuk mencoba: tidak ada image produksi yang diterbitkan, tidak ada konfigurasi HTTPS, tidak ada pengirim email sungguhan (hanya Mailpit), dan tidak ada catatan langkah pemasangan. Pemilik sudah menyiapkan satu instance AWS Lightsail paket $7 dan satu proyek Supabase gratis, dan ingin aplikasi hidup di sana untuk diuji lima sampai sepuluh warga sebelum rilis dan pembelian domain.

## Solution

Satu perintah dari mesin pengembang membangun image produksi, mendorongnya ke GitHub Container Registry, lalu memberi tahu VM untuk menarik dan menjalankannya. VM menjalankan tiga hal lewat Docker Compose: migrasi sekali jalan ke Supabase, aplikasi, dan Caddy yang memberi HTTPS otomatis pada alamat `<ip>.sslip.io`. Email keluar lewat Gmail SMTP dengan app password. Rahasia produksi diisi sekali lewat wizard interaktif yang menulis `.env` langsung ke VM. Runbook di repositori mencatat pemasangan awal, deploy ulang, akun pertama, batas paket, dan apa yang belum dilakukan sebelum rilis.

## Goals and non-goals

**Goals**

- Aplikasi menjawab di `https://<ip>.sslip.io` dengan sertifikat sah.
- Deploy ulang adalah satu perintah dari mesin pengembang, kurang dari sepuluh menit.
- Migrasi Drizzle jalan ke Supabase sebelum aplikasi menerima permintaan, setiap deploy.
- Email verifikasi, undangan, dan pemberitahuan sampai ke kotak masuk penguji.
- Tidak ada rahasia di repositori, di tracker, atau di transkrip agen.
- Pengembangan lokal dengan Mailpit tidak berubah.

**Non-goals**

- Tidak ada domain, tidak ada SPF/DKIM; Gmail adalah pengirim sementara.
- Tidak ada deploy otomatis dari CI.
- Tidak ada backup otomatis; hanya catatan cara snapshot manual.
- Tidak ada pemindahan `storage/` ke object storage.
- Tidak ada cron; penjadwal in-process yang ada sudah mencukupi di VM yang selalu hidup.

## User stories

1. Sebagai pemilik, saya ingin menjalankan satu perintah deploy dari laptop saya dan beberapa menit kemudian versi terbaru hidup di alamat uji.
2. Sebagai pemilik, saya ingin alamat uji ber-HTTPS supaya cookie sesi aman dan peramban tidak memperingatkan penguji.
3. Sebagai pemilik, saya ingin mengisi rahasia produksi sekali lewat wizard yang menuntun saya, bukan menyunting berkas di server dengan tangan.
4. Sebagai pemilik, saya ingin migrasi jalan otomatis saat deploy supaya saya tidak lupa.
5. Sebagai penguji, saya ingin email verifikasi pendaftaran sampai ke Gmail saya dalam satu menit.
6. Sebagai pemilik, saya ingin mendaftar lewat aplikasi lalu menjadi superuser pertama dengan satu perintah SSH, dan memberi peran berikutnya dari dalam aplikasi.
7. Sebagai pemilik, saya ingin membuat Unit sungguhan dan mengundang warga penguji dari layar yang sudah ada.
8. Sebagai pengembang, saya ingin `docker compose up` lokal dengan Mailpit tetap bekerja tanpa mengisi variabel baru.
9. Sebagai pengembang berikutnya, saya ingin runbook yang menjelaskan topologi, perintah, dan yang tersisa sebelum rilis.
10. Sebagai pemilik, saya ingin tahu cara snapshot VM dan di mana backup Supabase berada sebelum melakukan perubahan besar.

## Implementation decisions

**Pengirim SMTP mendukung auth opsional.** `SMTP_USER` dan `SMTP_PASS` dibaca bila keduanya ada; bila ada, transport memakai auth dan `requireTLS` sehingga STARTTLS wajib. Bila tidak ada, perilaku Mailpit sekarang tidak berubah. Satu variabel tanpa pasangannya adalah galat yang menyebut nama variabel, mengikuti pola `requiredSetting` yang ada. Produksi memakai `smtp.gmail.com`, port 587, `EMAIL_FROM` berbentuk `"<nama komplek> <jefrykurniaone@gmail.com>"` karena Gmail menimpa alamat From dengan akun yang masuk.

**Image produksi dibangun di WSL, diterbitkan publik di GHCR.** Daemon Docker di mesin ini hidup di WSL Ubuntu, jadi `deploy.sh` dijalankan dari sana dengan `--platform linux/amd64`. Image diberi tag SHA commit dan `latest` di `ghcr.io/jefrykurniaone/sistem-informasi-manajemen-keuangan`. Paket dibuat publik supaya VM menarik tanpa login; repositori memang publik. Target `production` Dockerfile yang ada dipakai; VM tidak pernah menjalankan `git` atau `bun install`, penting karena paket $7 hanya 1 GB RAM.

**Compose produksi terpisah dari compose pengembangan.** `docker-compose.prod.yml` memuat `migrate` (image yang sama, perintah `bun run db:migrate`, `restart: no`), `app` (bergantung pada `migrate` selesai sukses, port 3000 hanya di jaringan internal, volume `storage/`), dan `caddy` (port 80 dan 443, volume data sertifikat). `Caddyfile` berisi satu blok situs `<ip>.sslip.io` yang mem-proxy ke `app:3000`. Tidak ada service basis data dan tidak ada Mailpit. `migrate` memakai `drizzle-kit` yang ada di `node_modules` image, jadi image produksi tidak berubah kecuali `drizzle/` dan `drizzle.config.ts` ikut disalin.

**Satu `DATABASE_URL` ke session pooler Supabase.** Koneksi langsung Supabase gratis hanya IPv6 dan Lightsail IPv4, sehingga aplikasi dan migrasi memakai host pooler port 5432 mode sesi, yang mendukung prepared statement `pg`. `?sslmode=require` disertakan; tiket memverifikasi bahwa `pg` 8.23 menerima sertifikat pooler dengan pengaturan itu dan mencatat hasilnya.

> [!note] Dibalik oleh run `uji-v1`
> `pg` 8.23.0 menolak `?sslmode=require` sendirian dengan galat `SELF_SIGNED_CERT_IN_CHAIN`, bukan menerimanya (#172): sertifikat pooler diterbitkan CA milik Supabase sendiri yang tidak ada di penyimpanan akar publik. Bentuk yang terbukti jalan dan dipakai di `.env.production.example` adalah `sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt`, dengan berkas CA dari dasbor Supabase disimpan di server sebagai `certs/supabase-ca.crt`.

**Deploy adalah skrip, bukan CI.** `scripts/deploy.sh`: build, push, lalu SSH ke VM untuk `docker compose -f docker-compose.prod.yml pull` dan `up -d`, menunggu `migrate` selesai, dan memeriksa `GET /api/health` lewat HTTPS. Alamat VM dan jalur kunci `.pem` dibaca dari `.env.deploy` lokal yang di-ignore git.

**Bootstrap VM dan rahasia lewat wizard.** `scripts/bootstrap-vm.sh` dijalankan sekali di VM: pasang Docker, buat swap 2 GB, buat direktori aplikasi, salin compose dan Caddyfile. `scripts/setup-env.sh` adalah wizard interaktif di mesin pengembang yang menanyakan `ORIGIN`, `DATABASE_URL`, `BETTER_AUTH_SECRET` dan `FILE_STORE_SECRET` (dibuat otomatis dengan `openssl rand`), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `PUBLIC_COMPLEX_NAME`, lalu menulis `.env` ke VM lewat `scp`. Nilainya tidak lewat repositori, tracker, atau transkrip agen. `.env.production.example` mendokumentasikan setiap variabel dengan nilai contoh kosong.

> [!note] Dibalik oleh run `uji-v1`
> `.env` tidak dikirim lewat `scp` (#176): `scp` menolak sumber non-reguler, yang akan memaksa salinan `.env` singgah sebagai berkas di mesin pengembang lebih dulu, melanggar syarat tiket sendiri. `setup-env.sh` mengirim isinya lewat stdin `ssh` dengan `printf` builtin (jadi nilainya tidak pernah masuk `/proc/<pid>/cmdline`); perintah remote menulis ke `.env.next`, memeriksa penanda akhir, baru `mv` ke `.env` dengan mode 600.

**`PUBLIC_COMPLEX_NAME` masuk di build atau di runtime?** Variabel `$env/static/public` dibekukan saat build. Karena image dibangun di mesin pengembang, nilainya diberikan sebagai build arg di `deploy.sh` dari `.env.deploy`, dan runbook mencatat bahwa mengubah nama komplek berarti deploy ulang. Spec `shell-masuk` yang memperkenalkan variabel itu.

**Penjadwal in-process tetap.** `hooks.server.ts` sudah memulai penjadwal saat server hidup, dengan kunci per periode dan pemicu manual di `/admin/jobs`. Cron akan bersaing memperebutkan kunci yang sama tanpa manfaat.

**Runbook `docs/deploy.md`** memuat: topologi, pemasangan awal (Lightsail, IP statis, Supabase, GHCR), wizard, deploy ulang, superuser pertama lewat `superuser:grant` di dalam container, peran `admin` untuk superuser, membuat Unit dan Undangan penguji, batas paket $7 dan Gmail 500 email per hari, snapshot manual dan backup Supabase 7 hari, mengganti ilustrasi masuk dengan foto, dan daftar sebelum rilis (domain, SPF/DKIM, backup `storage/`, CI deploy).

## Testing decisions

- **Pengirim SMTP** diuji unit di `tests/unit/ports-email.test.ts`: `readSmtpSettings` dengan dan tanpa pasangan auth, galat saat hanya satu ada, dan opsi transport yang dibangun (`auth`, `requireTLS`) diperiksa lewat `transport.options` tanpa mengirim.
- **Compose dan Caddyfile** tidak diuji di gerbang; `docker compose -f docker-compose.prod.yml config` harus valid, diperiksa orchestrator di WSL.
- **Deploy sungguhan** diverifikasi orchestrator lewat HTTP: `GET https://<ip>.sslip.io/api/health` 200 dengan sertifikat sah, tabel migrasi Drizzle di Supabase berisi sepuluh baris, halaman masuk dua kolom tampil, dan pendaftaran akun pemilik menghasilkan email verifikasi di Gmail. Tidak ada tes di repositori untuk ini.
- Prior art: `tests/e2e/api-health.spec.ts` untuk bentuk endpoint kesehatan.

## Success criteria

- `bun run test` memuat tes auth SMTP dan lulus; `docker compose up` lokal tanpa variabel baru tetap jalan.
- `docker compose -f docker-compose.prod.yml config` valid.
- `scripts/deploy.sh` dari WSL menyelesaikan build, push, pull, migrasi, dan health check tanpa langkah manual.
- `https://<ip>.sslip.io/api/health` menjawab 200 dengan sertifikat sah.
- Supabase memuat sepuluh migrasi dan tabel aplikasi.
- Pendaftaran pemilik mengirim email verifikasi yang sampai di Gmail; `superuser:grant` di container memberi peran.
- `docs/deploy.md` cukup untuk mengulang seluruh pemasangan tanpa membaca tiket.
- Empat perintah gerbang lulus.

## Out of scope

- Domain, SPF/DKIM, penyedia email transaksional.
- Deploy otomatis dari GitHub Actions.
- Backup otomatis `storage/`.
- Object storage untuk berkas.
- Cron atau endpoint pemicu job.

## Further notes

Riset biaya di vault (2026-09-21) merekomendasikan paket $12; pemilik memilih $7 dan menerima batasnya karena build tidak terjadi di VM. Swap 2 GB dan pemantauan memori sederhana masuk runbook. App password Gmail milik akun `jefrykurniaone@gmail.com` sudah ada di catatan pemilik dan tidak pernah disalin ke mana pun.
