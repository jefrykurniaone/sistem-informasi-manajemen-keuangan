# Runbook deploy fase uji

Panduan ini cukup untuk mengulang seluruh pemasangan fase uji tanpa membaca tiket. Diasumsikan
daemon Docker berjalan di WSL Ubuntu di mesin pengembang, bukan Docker Desktop. `gh` harus terpasang
dan masuk **di dalam WSL** dengan cakupan `write:packages` (langkah 0 di bagian 2): `gh` di Windows
tidak dipakai oleh `scripts/deploy.sh`, dan token `gh` di Windows biasanya tidak punya cakupan itu.

## 1. Topologi

- **VM**: AWS Lightsail paket $7 (1 GB RAM), dengan swap 2 GB yang dibuat `scripts/bootstrap-vm.sh`.
- **Caddy**: menerima port 80 dan 443 (termasuk HTTP/3 di UDP 443), mengurus sertifikat TLS otomatis
  untuk `<ip-statis>.sslip.io`, lalu mem-proxy ke `app:3000` di jaringan internal compose.
- **app**: image produksi yang sama dipakai oleh service `migrate`; hanya `app` yang tetap hidup
  (`restart: unless-stopped`).
- **migrate**: menjalankan `bun run db:migrate` sekali lalu keluar; `app` baru mulai setelah
  `migrate` keluar dengan kode 0 (`depends_on: condition: service_completed_successfully`).
  `db:migrate` lebih dulu menjalankan `scripts/migrate-preflight.ts`, yang tersambung ke basis data
  dengan `DATABASE_URL` dan, bila gagal, mencetak penyebabnya sebelum `drizzle-kit` dimulai (lihat
  bagian 3).
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

0. Pasang `gh` di WSL dari repositori apt GitHub CLI (`cli.github.com/packages`), lalu masuk dari
   WSL juga:

   ```bash
   sudo mkdir -p -m 755 /etc/apt/keyrings
   wget -nv -O- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
   sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
   sudo apt update && sudo apt install gh -y
   gh auth login --hostname github.com --git-protocol https --web --scopes write:packages
   ```

   `gh auth status` harus menyebut `write:packages` di antara `Token scopes`. Tanpa cakupan itu
   langkah push di `scripts/deploy.sh` ditolak; tambahkan dengan
   `gh auth refresh --scopes write:packages`.

1. Di konsol Lightsail: buat instance Ubuntu 24.04, pasang IP statis, dan buka port TCP 80 serta
   TCP dan UDP 443 di firewall instance (selain TCP 22 yang sudah terbuka bawaan). Unduh kunci
   `.pem` instance.
2. Buat proyek Supabase, lalu salin URL **session pooler** dari dasbor (Database settings,
   Connection string, mode Session) dan unduh sertifikat CA-nya (Database settings, SSL
   Configuration). **Kata sandi di dalam URL itu harus di-percent-encode**: setiap karakter di luar
   `A-Z a-z 0-9 - . _ ~` ditulis sebagai kodenya, misalnya `#` menjadi `%23`, `/` menjadi `%2F`, `?`
   menjadi `%3F`, dan `@` menjadi `%40`. Wizard di langkah 5 memeriksa aturan ini dan bisa
   meng-encode kata sandinya sendiri, jadi URL dari dasbor boleh ditempelkan apa adanya. Cara yang
   lebih sederhana tetap berlaku: pilih kata sandi basis data Supabase yang hanya berisi huruf dan
   angka. Satu hal yang tidak bisa dikenali wizard: kata sandi yang memuat `%` diikuti dua digit
   heksadesimal, misalnya `%41`, dianggap sudah di-encode dan dibaca sebagai karakter lain. Tulis
   `%` seperti itu sebagai `%25`; bila terlewat, `migrate` menyebut autentikasi yang ditolak
   (`28P01`, lihat bagian 3).
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

   Wizard memeriksa bahwa `DATABASE_URL` terurai sebagai URL, di samping pemeriksaan skema,
   penanda contoh, port 6543, dan `sslmode`. Userinfo dianggap berakhir di `@` **terakhir**, dan
   kata sandi dimulai sesudah `:` pertama sesudah skema, sehingga kata sandi yang memuat `@`, `/`,
   `?`, atau `#` tetap bisa dipisahkan. Sesudah `@` terakhir harus ada nama host, boleh diikuti
   `:port`. Bila kata sandinya memuat karakter di luar `A-Z a-z 0-9 - . _ ~` yang belum ditulis
   sebagai `%XX`, wizard menjelaskan masalahnya tanpa menampilkan nilainya, lalu menawarkan:

   ```text
   Ketik encode untuk meng-encode-nya, atau Enter untuk mengetik ulang URL:
   ```

   Dengan `encode`, wizard meng-encode setiap karakter kata sandi di luar himpunan itu, termasuk
   `%`, lalu memeriksa URL hasilnya sekali lagi. Nilai asli dan hasil encode tidak pernah
   ditampilkan. Dengan Enter, URL diketik ulang dari awal.
6. Ini baru bisa dilakukan setelah push image pertama, yaitu setelah menjalankan
   `scripts/deploy.sh` di bagian 3 untuk pertama kali: jadikan paket GHCR
   `sistem-informasi-manajemen-keuangan` publik lewat GitHub, Packages, Package settings, Change
   visibility. Paket GHCR yang baru didorong selalu mulai sebagai privat, dan tidak ada API untuk
   mengubah visibilitasnya, jadi langkah ini dikerjakan tangan di situs GitHub. Deploy pertama
   karena itu **selalu berhenti di langkah 7**, "pull image <sha-pendek> di VM", dengan galat
   berikut:

   ```text
   Error response from daemon: error from registry: unauthorized
   GAGAL: deploy berhenti di langkah 7, "pull image <sha-pendek> di VM" (kode 1).
   ```

   Setelah paket publik, jalankan `bash scripts/deploy.sh` sekali lagi. Build diambil dari cache
   dan push hanya mendapati layer yang sudah ada di GHCR, jadi jalan kedua sampai ke langkah 7
   dalam sekitar dua puluh detik lalu selesai. Jangan menjalankan `docker login` atau menaruh token di VM
   sebagai jalan pintas.

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

Yang teramati pada deploy pertama (23 September 2026, commit `c5d84c37a8b5`):

- **Durasi.** Dengan cache build terisi, build selesai dalam 4 sampai 14 detik. Push pertama tag
  SHA ke GHCR paket yang masih kosong makan waktu sekitar 3 menit; push berikutnya 3 sampai 6 detik.
  Pull pertama di VM sekitar 45 detik, `up` sampai `migrate` keluar 0 sekitar 9 detik, dan seluruh
  deploy ulang dari awal sampai health check sekitar 40 detik.
- **Digest berubah setiap kali deploy diulang**, walaupun commit dan isi image sama. `docker build`
  menyertakan manifest atestasi yang dibuat baru pada setiap build, sehingga digest daftar manifest
  yang didorong ke tag `<sha-pendek>` dan `latest` ikut berubah. Digest yang benar-benar berjalan
  adalah yang dicetak push pada deploy terakhir yang berhasil; periksa di VM dengan
  `docker image inspect --format '{{json .RepoDigests}}' <image>:<sha-pendek>`.
- **Percobaan health check pertama bisa gagal dengan galat TLS**, misalnya
  `curl: (35) TLS connect error: ... tlsv1 alert internal error`, selama Caddy baru meminta
  sertifikat Let's Encrypt untuk `<ip-statis>.sslip.io`. Itu wajar: percobaan berikutnya, 5 detik
  kemudian, berhasil dengan sertifikat yang sah.

Untuk membaca log di VM:

```bash
ssh -i ~/.ssh/<nama-kunci>.pem <user>@<ip-statis> 'cd /opt/komplek && docker compose -f docker-compose.prod.yml logs migrate app caddy'
```

Bila `migrate` gagal, deploy berhenti sebelum `app` pernah dijalankan dengan skema yang tidak
cocok, di langkah `up -d --remove-orphans` dengan `migrate keluar dengan kode 1.`; log `migrate` di
atas menunjukkan penyebabnya.

**Kegagalan koneksi.** `drizzle-kit` menelan galat penguraian URL, sehingga pada deploy pertama
log `migrate` berakhir tanpa penjelasan (`Using 'pg' driver for database querying`, lalu
`error: script "db:migrate" exited with code 1`). Karena itu `bun run db:migrate` lebih dulu
menjalankan `scripts/migrate-preflight.ts`: skrip ini mengurai `DATABASE_URL` seperti `pg`,
tersambung, menjalankan `SELECT 1`, dan bila gagal mencetak kategori beserta kodenya lalu keluar
dengan kode 1 sebelum `drizzle-kit` dimulai. URL, kata sandi, dan objek galat tidak pernah
dicetak. Setiap baris diawali `migrate-preflight:`, dan baris terakhirnya
`Stopped before drizzle-kit migrate; nothing was migrated.` Baris pertamanya salah satu dari:

| Baris pertama | Penyebab dan perbaikan |
|---|---|
| `DATABASE_URL is not a valid URL (ERR_INVALID_URL).` | Kata sandi memuat karakter yang belum di-percent-encode (bagian 2 langkah 2). |
| `the database refused the user name or password (28P01).` | Pengguna atau kata sandi salah, termasuk `%XX` yang tidak disengaja di kata sandi. |
| `the TLS connection to the database failed (<kode>).` | `sslmode` atau `sslrootcert` di URL, atau isi `certs/supabase-ca.crt`. |
| `the CA certificate named by sslrootcert in DATABASE_URL cannot be read (ENOENT).` | `certs/supabase-ca.crt` belum ada di sebelah `docker-compose.prod.yml`. |
| `the database host cannot be reached (ENOTFOUND).` | Host atau port salah; juga `ECONNREFUSED`, `ETIMEDOUT`, dan sejenisnya. Kata sandi dengan `#`, `/`, atau `?` yang belum di-encode juga membuat URL menunjuk host yang salah. |
| `the database named in DATABASE_URL does not exist (3D000).` | Nama basis data sesudah host; di Supabase namanya `postgres`. |

Perbaiki baris `DATABASE_URL` pada `/opt/komplek/.env` (atau jalankan ulang
`scripts/setup-env.sh`, yang memeriksa URL dan bisa meng-encode kata sandinya), lalu jalankan
`bash scripts/deploy.sh` lagi. Image yang dibangun sebelum #202 belum membawa pemeriksaan ini, dan
`migrate`-nya tetap berakhir tanpa penjelasan.

## 4. Akun pertama

1. Buka `https://<ip-statis>.sslip.io/register` dan daftarkan akun pengurus.
2. Verifikasi email lewat tautan yang dikirim ke kotak masuk.
3. Jadikan akun itu superuser dari dalam container `app` di VM:

   ```bash
   ssh -i ~/.ssh/<nama-kunci>.pem <user>@<ip-statis> 'cd /opt/komplek && docker compose -f docker-compose.prod.yml exec -T app bun run superuser:grant <email>'
   ```

   `-f docker-compose.prod.yml` wajib: `/opt/komplek` hanya memuat berkas itu, dan
   `docker compose` tanpa `-f` berhenti dengan `no configuration file provided: not found`.

   Perintah ini hanya memberi peran kepada akun yang sudah terdaftar, dan menjalankannya dua kali
   tidak mengubah apa pun pada jalan kedua. Alamat yang belum terdaftar ditolak dengan
   `No account is registered with the address "<email>"` dan kode keluar 1, tanpa menulis apa pun.

   Image tidak membawa `src/`, jadi di dalam container perintah yang sama menjalankan
   `scripts/grant-superuser.js`, bundel yang dibuat tahap `build` di `Dockerfile`, bukan berkas
   `.ts` di pohon kerja. Image yang dibangun sebelum #204 tidak memuat bundel itu dan menjawab
   `Module not found "scripts/grant-superuser.ts"`. Deploy ulang dengan image yang lebih baru, lalu
   jalankan perintah di atas lagi.
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

## 9. Pemecahan masalah: 502 dengan `"msg":"EOF"` di log caddy

**Gejala.** Pengguna sesekali melihat layar galat 500 saat berpindah halaman, masuk, atau kembali
ke tab sesudah jeda, lalu halaman yang sama berjalan normal saat dicoba lagi. Log `app` tidak
mencatat apa pun pada waktu itu. Layar 500 itu dirender SvelteKit di peramban ketika potongan
modul (`/_app/immutable/chunks/*.js`) atau `__data.json` yang diminta navigasi dijawab 502 oleh
Caddy.

**Cara menemukannya.** Caddyfile tidak menyalakan access log, jadi satu-satunya catatan ada di log
galat Caddy (logger `http.log.error`). Cari pesan galatnya, bukan kode statusnya:

```bash
ssh -i ~/.ssh/<nama-kunci>.pem <user>@<ip-statis> 'cd /opt/komplek && docker compose -f docker-compose.prod.yml logs --since 24h caddy' | grep '"msg":"EOF"'
```

Setiap baris yang cocok adalah satu permintaan yang dijawab 502 karena koneksi Caddy ke `app:3000`
ditutup tanpa jawaban. Baris itu memuat `"status":502`, `err_trace`
`reverseproxy.statusError`, metode, URI, protokol peramban (`"proto":"HTTP/3.0"` dan seterusnya),
serta `duration` yang biasanya hanya beberapa milidetik.

**Penyebabnya ada di Bun, bukan di Caddy atau aplikasi.** `node:http` di Bun 1.3.14 menutup
koneksi keep-alive tanpa jawaban dan tanpa `Connection: close` bila permintaan berikutnya tiba
saat respons berkas statis sebelumnya belum selesai ditutup di sisi Bun
([oven-sh/bun#31889](https://github.com/oven-sh/bun/issues/31889), diperbaiki mulai Bun 1.4.0).
adapter-node mengirim setiap berkas statis dengan cara yang memicunya, jadi permintaan yang
ditolak itu tidak pernah sampai ke SvelteKit, dan karena itu log `app` kosong. Untuk `GET` dari
peramban yang datang lewat HTTP/1.1 atau HTTP/2, pustaka HTTP Go di dalam Caddy sudah mengirim
ulang permintaan itu sendiri. Untuk `GET` lewat HTTP/3 tidak, sehingga hanya permintaan HTTP/3
yang sampai ke pengguna sebagai 502. Rinciannya, beserta reproduksinya, ada di #213.

**Apa yang dilakukan pengulangan di Caddyfile.** `lb_retries 2` dan
`lb_retry_match { method GET HEAD }` membuat Caddy langsung mengirim ulang `GET` atau `HEAD` yang
round-trip-nya ke `app` gagal, paling banyak dua kali lagi, lewat koneksi lain. Peramban menerima
jawaban dari percobaan yang berhasil, dan percobaan yang gagal tidak dicatat sama sekali. Jadi
sesudah perubahan ini, baris `"msg":"EOF"` untuk `GET` atau `HEAD` hanya muncul bila ketiga
percobaan gagal.

**Apa yang dilakukan `keepalive off` di Caddyfile.** `transport http { keepalive off }` membuat
Caddy membuka koneksi baru ke `app` untuk setiap permintaan dan tidak pernah memakai ulang
koneksi. Bug Bun di atas hanya mengenai permintaan di koneksi yang dipakai ulang, jadi dengan blok
ini bug itu tidak bisa terjadi untuk metode apa pun, termasuk `POST` yang tidak dikirim ulang oleh
pengulangan. Biayanya satu koneksi TCP baru per permintaan di jaringan internal compose. Blok ini
sementara (#223): cabut sesudah image berjalan di Bun 1.4 atau lebih baru. Pengulangannya tetap
dipasang sebagai jaring pengaman.

**Batasnya.**

- `POST` dan metode lain tidak pernah dikirim ulang, karena aksi form tidak idempoten. Selama
  `keepalive off` terpasang, aksi form tidak terkena bug ini. Tanpa blok itu, aksi form yang terkena
  penutupan koneksi tetap dijawab 502, dan baris `"msg":"EOF"` dengan `"method":"POST"` tetap
  muncul. Pada penyebab di atas aksinya tidak pernah dijalankan (Bun membuang permintaannya sebelum
  sampai ke SvelteKit), jadi mengirim ulang form itu dengan tangan aman.
- Pengulangan dan `keepalive off` menutupi gejala, tidak menghapus penyebab. Yang menghapusnya
  adalah Bun 1.4.0 atau lebih baru di `Dockerfile` (#223).
- Permintaan yang koneksinya tidak bisa dibuka sama sekali, misalnya saat `app` sedang dimulai
  ulang, juga dikirim ulang oleh Caddy untuk metode apa pun, karena `app` belum menerimanya. Ketiga
  percobaan itu dikirim berturut-turut tanpa jeda, jadi selama `app` belum siap jawabannya tetap
  502 seperti sebelumnya.
