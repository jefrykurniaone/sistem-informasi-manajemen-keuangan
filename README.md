# Sistem Informasi dan Manajemen Keuangan Komplek

Aplikasi internal satu komplek perumahan (sekitar 100 rumah, 300–400 warga) untuk empat hal:

1. **Iuran dan kas** — tagihan iuran bulanan per rumah, pencatatan pembayaran beserta buktinya,
   dan buku kas komplek.
2. **Laporan keuangan bulanan** — diterbitkan dari buku kas, bukan diketik ulang dari spreadsheet.
3. **Kegiatan dan pengumuman** — posyandu, kerja bakti, perayaan 17 Agustus, rapat warga.
4. **Laporan warga** — keluhan yang bisa dipantau statusnya sampai selesai.

Warga yang berlangganan menerima laporan keuangan bulanan lewat email.

## Status

Belum ada kode. Repositori ini saat ini berisi perencanaan: spesifikasi di `docs/`, dan tiket
pelaksanaan di GitHub Issues.

## Stack

| Lapisan | Pilihan |
|---|---|
| Runtime | Bun |
| Aplikasi | SvelteKit (Svelte 5), monolith |
| Permukaan HTTP | ElysiaJS, dipasang di `src/routes/api/[...slugs]/+server.ts` |
| Logika domain | Lapisan service di `src/lib/server/services/` |
| Basis data | PostgreSQL + Drizzle ORM |
| Autentikasi | better-auth, dipasang di `hooks.server.ts` |
| Antarmuka | Tailwind CSS v4 + shadcn-svelte, mobile-first |
| i18n | Paraglide JS, bahasa dasar Indonesia |
| Pengembangan lokal | Docker Compose — aplikasi, PostgreSQL, Mailpit |

## Dokumen

- [Spesifikasi](./docs) — salinan setiap spesifikasi run yang sedang berjalan.
- [Tracker](./docs/agents/issue-tracker.md) — di mana spesifikasi dan tiket hidup.
