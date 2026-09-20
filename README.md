# Sistem Informasi dan Manajemen Keuangan Komplek

Aplikasi internal satu komplek perumahan (sekitar 100 rumah, 300–400 warga) untuk empat hal:

1. **Iuran dan kas** — tagihan iuran bulanan per rumah, pencatatan pembayaran beserta buktinya,
   dan buku kas komplek.
2. **Laporan keuangan bulanan** — diterbitkan dari buku kas, bukan diketik ulang dari spreadsheet.
3. **Kegiatan dan pengumuman** — posyandu, kerja bakti, perayaan 17 Agustus, rapat warga.
4. **Laporan warga** — keluhan yang bisa dipantau statusnya sampai selesai.

Warga yang berlangganan menerima laporan keuangan bulanan lewat email.

## Status

Rangka aplikasi sudah berdiri: SvelteKit berjalan, Tailwind CSS v4 dan shadcn-svelte terpasang,
empat perintah gerbang mutu ada dan lulus, dan `docker compose up` menyalakan aplikasi, PostgreSQL,
serta Mailpit. Belum ada satu pun fitur domain — tidak ada tagihan, kas, kegiatan, atau keluhan.

## Stack

| Lapisan            | Pilihan                                                      |
| ------------------ | ------------------------------------------------------------ |
| Runtime            | Bun                                                          |
| Aplikasi           | SvelteKit (Svelte 5), monolith                               |
| Permukaan HTTP     | ElysiaJS, dipasang di `src/routes/api/[...slugs]/+server.ts` |
| Logika domain      | Lapisan service di `src/lib/server/services/`                |
| Basis data         | PostgreSQL + Drizzle ORM                                     |
| Autentikasi        | better-auth, dipasang di `hooks.server.ts`                   |
| Antarmuka          | Tailwind CSS v4 + shadcn-svelte, mobile-first                |
| i18n               | Paraglide JS, bahasa dasar Indonesia                         |
| Pengembangan lokal | Docker Compose — aplikasi, PostgreSQL, Mailpit               |

Empat baris di tabel itu belum terpasang — ElysiaJS, Drizzle ORM, better-auth, dan Paraglide JS.
Semuanya ditetapkan di `docs/spec-fondasi-v1.md` dan dikerjakan oleh tiket berikutnya.

## Menjalankan di mesin lokal

```bash
cp .env.example .env     # sesuaikan porta kalau ada yang bentrok
docker compose up
```

| Layanan        | Alamat                  |
| -------------- | ----------------------- |
| Aplikasi       | <http://localhost:5173> |
| Mailpit (web)  | <http://localhost:8025> |
| Mailpit (SMTP) | `localhost:1025`        |
| PostgreSQL     | `localhost:5432`        |

Semua porta di atas diambil dari `.env`; `.env.example` memuat nilai bawaannya. Layanan `app`
memakai target `dev` dari `Dockerfile`, memasang direktori kerja sebagai bind mount, dan menjalankan
server pengembangan Vite, sehingga perubahan berkas langsung terlihat tanpa membangun ulang image.
Kalau perubahan berkas tidak terdeteksi di dalam container, isi `VITE_USE_POLLING=true` di `.env`.

Untuk bekerja tanpa Docker, jalankan `bun install` lalu `bun run dev`; PostgreSQL dan Mailpit tetap
bisa dinyalakan sendiri dengan `docker compose up db mailpit`. Perintah itu menjalankan `vite dev` di
bawah Node, yang tidak mewarisi muatan `.env` milik proses Bun, jadi `vite.config.ts` yang menyalin
isi `.env` ke `process.env` — variabel yang sudah ada di lingkungan sungguhan tetap menang atas nilai
di berkas itu.

### Penyiapan awal: migrasi, lalu superuser pertama

Basis data yang baru dimigrasi belum memiliki satu pun superuser. Pemicu basis data memberi setiap
akun baru peran `resident` saja, sementara pemberian peran di dalam aplikasi menuntut peran
`superuser`, sehingga tanpa langkah ini halaman `/admin/roles` menjawab 403 kepada siapa pun. Karena
itu superuser pertama dibuat dari baris perintah, bukan dari halaman mana pun: tidak ada rute, tidak
ada form action, dan tidak ada endpoint yang bisa memberi peran ini.

```bash
bun run db:migrate                                # jalankan migrasi
# daftarkan akun pengurus lewat aplikasi, lalu berikan perannya:
bun run superuser:grant pengurus@komplek.local
```

Perintah itu hanya memberi peran kepada akun yang **sudah terdaftar**. Kalau alamatnya tidak ada, ia
berhenti dengan pesan yang menyebut alamat tersebut dan keluar dengan kode 1. Menjalankannya dua kali
tidak mengubah apa pun pada jalan kedua — tidak ada baris peran kedua dan tidak ada baris `audit_log`
kedua. Setiap pemberian yang berhasil meninggalkan satu baris `audit_log` dengan `actor_id` bernilai
`system:bootstrap`, penanda bahwa perubahan itu datang dari operator mesin dan bukan dari seseorang
yang sedang masuk.

Perintah ini tetap bekerja pada sistem yang sudah punya superuser, dan sengaja tidak menolaknya: itu
satu-satunya jalan kembali kalau akun superuser terakhir hilang. Perlu dicatat bahwa peran
`superuser` saja belum cukup untuk setiap layar — sebagian tindakan, misalnya memberi Pembebasan,
dinisbahkan pada baris `residents` milik pelakunya, jadi akun pengurus tetap perlu terdaftar sebagai
warga sebuah Unit.

## Gerbang mutu

Empat perintah ini adalah gerbangnya. Semua harus lulus sebelum sebuah pull request digabungkan, dan
GitHub Actions menjalankan keempatnya pada setiap pull request lewat `.github/workflows/ci.yml`.

| Perintah        | Isi                                   |
| --------------- | ------------------------------------- |
| `bun run check` | `svelte-kit sync` lalu `svelte-check` |
| `bun run lint`  | `prettier --check .` lalu `eslint .`  |
| `bun run test`  | Vitest, sekali jalan                  |
| `bun run build` | Build produksi SvelteKit              |

Pengujian ujung ke ujung berjalan terpisah dengan `bun run test:e2e` dan **bukan** bagian dari
gerbang per-penggabungan: ia membangun aplikasi, menyalakan `vite preview`, dan menjalankan
Playwright. `bun run format` merapikan berkas dengan Prettier.

## Konvensi

Keputusan di bawah ditetapkan oleh tiket rangka dan diikuti oleh seluruh pekerjaan berikutnya.

**Tata letak direktori.**

| Direktori                  | Isi                                                                    |
| -------------------------- | ---------------------------------------------------------------------- |
| `src/routes/`              | Halaman dan endpoint SvelteKit. Tidak menyimpan aturan domain.         |
| `src/lib/server/services/` | Satu-satunya tempat aturan domain tinggal. Diuji langsung, tanpa HTTP. |
| `src/lib/components/ui/`   | Komponen shadcn-svelte yang disalin ke repositori dan boleh diubah.    |
| `src/lib/components/`      | Komponen antarmuka milik aplikasi ini sendiri.                         |
| `src/lib/utils.ts`         | Pembantu lintas lapisan, termasuk `cn` untuk menggabungkan kelas.      |
| `tests/unit/`              | Vitest. Berkas `*.test.ts`.                                            |
| `tests/e2e/`               | Playwright. Berkas `*.spec.ts`.                                        |

Port keluar `EmailSender`, `FileStore`, dan `Clock` akan tinggal di bawah `src/lib/server/`
berdampingan dengan lapisan service, dan dipalsukan dalam pengujian. Tempatnya sengaja dikosongkan
di sini; tiket port keluar yang mengisinya.

**Konfigurasi peralatan.** Mulai SvelteKit 2.63 dengan `@sveltejs/vite-plugin-svelte` 7, konfigurasi
SvelteKit tidak lagi tinggal di `svelte.config.js` melainkan di dalam opsi plugin `sveltekit()` pada
`vite.config.ts`. Berkas itu juga memegang plugin Tailwind CSS v4 dan konfigurasi Vitest, jadi ia
adalah satu-satunya tempat menambahkan plugin Vite berikutnya. Tailwind v4 memakai plugin Vite
`@tailwindcss/vite` dengan konfigurasi di dalam CSS (`src/app.css`), bukan `tailwind.config.js`.

**Bahasa.** Bahasa dasar antarmuka adalah Indonesia. Nama di kode dan di antarmuka memakai kosakata
di `CONTEXT.md`; kosakata baru ditambahkan ke sana lebih dulu, bukan diciptakan di kode.

**Mobile-first.** Halaman harus terbaca dan bisa dipakai pada lebar 390 piksel sebelum lebar yang
lain diperhatikan.

## Dokumen

- [Spesifikasi](./docs) — salinan setiap spesifikasi run yang sedang berjalan.
- [Tracker](./docs/agents/issue-tracker.md) — di mana spesifikasi dan tiket hidup.
- [Glosarium](./CONTEXT.md) — bahasa kanonik yang dipakai di kode, antarmuka, dan percakapan.
