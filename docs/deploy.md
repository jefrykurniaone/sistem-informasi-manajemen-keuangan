# Runbook deploy fase uji

Panduan ini cukup untuk mengulang seluruh pemasangan fase uji tanpa membaca tiket. Diasumsikan
daemon Docker berjalan di WSL Ubuntu di mesin pengembang, bukan Docker Desktop, dan `gh` sudah
masuk (`gh auth login`) dengan cakupan `write:packages`.

## 1. Topologi

- **VM**: AWS Lightsail paket $7 (1 GB RAM), dengan swap 2 GB yang dibuat `scripts/bootstrap-vm.sh`.
- **Caddy**: menerima port 80 dan 443 (termasuk HTTP/3 di UDP 443), mengurus sertifikat TLS otomatis
  untuk `<ip-statis>.sslip.io`, lalu mem-proxy ke `app:3000` di jaringan internal compose.
- **app**: image produksi yang sama dipakai oleh service `migrate`; hanya `app` yang tetap hidup
  (`restart: unless-stopped`).
- **migrate**: menjalankan `bun run db:migrate` sekali lalu keluar; `app` baru mulai setelah
  `migrate` keluar dengan kode 0 (`depends_on: condition: service_completed_successfully`).
- **Basis data**: Supabase, dihubungi lewat **session pooler** (port 5432, bukan transaction pooler
  6543) lewat `DATABASE_URL`. Tidak ada service basis data di compose produksi.
- **Registry**: GitHub Container Registry (GHCR), paket publik supaya VM menarik image tanpa masuk.
- **Email**: Gmail SMTP (`smtp.gmail.com`, port 587, STARTTLS).
- **Berkas unggahan**: direktori `storage/` di disk VM, dipasang sebagai volume ke `/app/storage`.

Compose produksi (`docker-compose.prod.yml`) memakai nama proyek `komplek-prod`, dengan urutan
service `migrate`, lalu `app`, lalu `caddy`.

`DATABASE_URL` wajib diakhiri `?sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt`.
`sslmode=require` saja ditolak oleh `pg` 8.23 dengan galat `SELF_SIGNED_CERT_IN_CHAIN`, karena
sertifikat pooler Supabase diterbitkan oleh CA Supabase sendiri, bukan CA publik. Sertifikat CA itu
harus ada sebagai berkas `certs/supabase-ca.crt` di server, di sebelah `docker-compose.prod.yml`
(dipasang ke `/app/certs` di dalam container).

## 2. Pemasangan awal

1. Di konsol Lightsail: buat instance Ubuntu 24.04, pasang IP statis, dan buka port TCP 80 serta
   TCP dan UDP 443 di firewall instance (selain TCP 22 yang sudah terbuka bawaan). Unduh kunci
   `.pem` instance.
2. Buat proyek Supabase, lalu salin URL **session pooler** dari dasbor (Database settings,
   Connection string, mode Session) dan unduh sertifikat CA-nya (Database settings, SSL
   Configuration).
3. Jalankan `scripts/bootstrap-vm.sh` di VM lewat SSH, dari WSL di akar repositori:

   ```bash
   ssh -i ~/.ssh/<nama-kunci>.pem <user>@<ip-statis> 'bash -s' < scripts/bootstrap-vm.sh
   ```

   Skrip ini memasang Docker Engine dan plugin compose dari repositori apt Docker sendiri,
   menambahkan pengguna SSH ke grup `docker`, membuat swap 2 GB persisten di `/swapfile`, dan
   membuat `/opt/komplek` beserta `/opt/komplek/storage` dan `/opt/komplek/certs`. Setiap langkah
   memeriksa dulu sebelum bertindak, jadi menjalankannya dua kali tidak mengubah apa pun pada jalan
   kedua. Simpan kunci `.pem` di `~/.ssh` **di dalam WSL**, bukan di `/mnt/c` atau `/mnt/d` (mode
   berkasnya tidak bisa dipersempit di sana dan ssh menolaknya), dan bukan di dalam repositori
   (seluruh pohon kerja adalah konteks build Docker).
4. Salin `.env.deploy.example` menjadi `.env.deploy` di akar repositori, lalu isi lima nilainya:
   `VM_HOST`, `VM_USER`, `VM_SSH_KEY`, `VM_STATIC_IP`, `PUBLIC_COMPLEX_NAME`. Berkas ini di-ignore
   git dan tidak memuat rahasia; nilainya hanya jalur dan alamat.
5. Jalankan wizard dari WSL di akar repositori:

   ```bash
   bash scripts/setup-env.sh
   ```

   Wizard ini menanyakan setiap variabel `.env.production.example` (kecuali `SITE_ADDRESS` dan
   `ORIGIN`, yang diturunkan otomatis dari `VM_STATIC_IP` sebagai `<ip-statis>.sslip.io`),
   membuatkan `BETTER_AUTH_SECRET` dan `FILE_STORE_SECRET` dengan `openssl rand -base64 32` bila
   dikosongkan, meminta jalur berkas CA Supabase yang diunduh pada langkah 2, lalu menulis
   `/opt/komplek/.env` di VM (mode 600) dan menyalin `docker-compose.prod.yml`, `Caddyfile`, dan
   sertifikat CA ke sana lewat `scp`. Tidak ada nilai yang ditampilkan kembali di layar. Jalankan
   `DRY_RUN=1 bash scripts/setup-env.sh` untuk melihat pertanyaan dan perintah yang akan dijalankan
   tanpa mengirim apa pun ke VM.
6. Ini baru bisa dilakukan setelah push image pertama, yaitu setelah menjalankan
   `scripts/deploy.sh` di bagian 3 untuk pertama kali: jadikan paket GHCR
   `sistem-informasi-manajemen-keuangan` publik lewat GitHub, Packages, Package settings, Change
   visibility. Tanpa ini VM tidak bisa menarik image tanpa masuk.

## 3. Deploy dan deploy ulang

Dari WSL di akar repositori, dengan pohon kerja bersih (deploy sungguhan berhenti bila ada
perubahan yang belum di-commit, karena image bertag commit harus dibangun dari commit itu apa
adanya):

```bash
bash scripts/deploy.sh
```

`--dry-run` mencetak setiap perintah, termasuk tag image, tanpa menjalankan satu pun (tidak ada
`docker`, `gh`, `ssh`, `scp`, atau `curl`).

Urutan yang dicetak: periksa VM, `docker build --network host --platform linux/amd64 --target
production` dengan build arg `PUBLIC_COMPLEX_NAME`, login GHCR lewat `gh auth token`, dorong tag
`<sha-pendek-12-karakter>` dan `latest`, salin `docker-compose.prod.yml` dan `Caddyfile` ke VM bila
isinya berbeda, tarik image di VM, tulis `APP_TAG=<sha-pendek>` ke `/opt/komplek/.env` di VM,
jalankan `docker compose up -d --remove-orphans`, tunggu `migrate` keluar dengan kode 0, mulai
ulang `caddy` bila `Caddyfile` berubah, lalu periksa `https://<ip-statis>.sslip.io/api/health`
berulang tiap 5 detik sampai 90 detik. Setiap langkah bernomor dan menyebut namanya sendiri bila
gagal.

Untuk membaca log di VM:

```bash
ssh -i ~/.ssh/<nama-kunci>.pem <user>@<ip-statis> 'cd /opt/komplek && docker compose -f docker-compose.prod.yml logs migrate app caddy'
```

Bila `migrate` gagal, deploy berhenti sebelum `app` pernah dijalankan dengan skema yang tidak
cocok; log `migrate` di atas menunjukkan galat migrasinya.

## 4. Akun pertama

1. Buka `https://<ip-statis>.sslip.io/register` dan daftarkan akun pengurus.
2. Verifikasi email lewat tautan yang dikirim ke kotak masuk.
3. Jadikan akun itu superuser dari dalam container `app` di VM:

   ```bash
   ssh -i ~/.ssh/<nama-kunci>.pem <user>@<ip-statis> 'cd /opt/komplek && docker compose exec app bun run superuser:grant <email>'
   ```

   Perintah ini hanya memberi peran kepada akun yang sudah terdaftar, dan menjalankannya dua kali
   tidak mengubah apa pun pada jalan kedua.
4. Masuk sebagai superuser, lalu beri diri sendiri (atau akun pengurus lain) peran `admin` lewat
   `/admin/roles`, karena sebagian layar (`/admin/overdue`, `/admin/payments`) menuntut peran itu
   secara khusus.
5. Buat Unit sungguhan dan kirim Undangan kepada warga penguji dari layar yang sudah ada di
   aplikasi.

## 5. Batas fase uji

- **1 GB RAM.** Periksa pemakaian dan swap dengan `free -m` di VM. Swap 2 GB dari
  `scripts/bootstrap-vm.sh` menjadi jaring pengaman, bukan pengganti RAM: pemakaian swap yang terus
  naik berarti sudah waktunya naik paket.
- **Gmail 500 email per hari.** Batas pengiriman akun Gmail biasa; cukup untuk lima sampai sepuluh
  penguji tetapi bukan untuk rilis dengan banyak warga.
- **Tidak ada backup otomatis.** Snapshot VM dilakukan manual dari konsol Lightsail (Snapshots)
  sebelum perubahan besar. Supabase menyimpan backup point-in-time selama 7 hari pada paket gratis;
  itulah jendela pemulihan basis data.

## 6. Mengganti ilustrasi masuk dengan foto komplek

Ilustrasi pada halaman masuk dua kolom ada di satu berkas komponen:
`src/lib/components/auth/brand-illustration.svelte`. Ganti isinya dengan markup yang menampilkan
foto komplek, lalu deploy ulang seperti bagian 3.

## 7. Mengubah nama komplek berarti deploy ulang

`PUBLIC_COMPLEX_NAME` dibekukan ke dalam image saat build (build arg, dibaca lewat
`$env/static/public`), bukan dibaca dari `.env` di server. Mengubah nilainya di `.env.deploy` tidak
berpengaruh sampai `scripts/deploy.sh` dijalankan lagi, karena itulah yang membangun ulang image
dengan nilai barunya.

## 8. Sebelum rilis

Berikut yang sengaja belum dikerjakan pada fase uji ini dan perlu diputuskan sebelum rilis kepada
seluruh warga:

- **Domain sungguhan**, menggantikan `<ip-statis>.sslip.io`.
- **SPF/DKIM atau penyedia email transaksional**, menggantikan Gmail SMTP yang batas dan
  reputasinya tidak cocok untuk pengiriman produksi.
- **Backup otomatis untuk `storage/`**, yang saat ini hanya ada di disk VM tanpa salinan.
- **Deploy dari CI**, menggantikan `scripts/deploy.sh` yang dijalankan tangan dari mesin
  pengembang.
