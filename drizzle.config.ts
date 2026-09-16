import { defineConfig } from 'drizzle-kit';

/**
 * Setelan `drizzle-kit`, dipakai oleh `bun run db:generate` dan `bun run db:migrate`.
 *
 * Alamat dibaca dari `DATABASE_URL`. Pemeriksaan ini diulang di sini alih-alih diimpor dari
 * `src/lib/server/db/index.ts` karena `drizzle-kit` membundel berkas ini sendiri, dan mengimpor
 * modul itu akan ikut menarik `pg` dan seluruh Drizzle ke dalam bundel setelan hanya untuk
 * membaca satu variabel.
 *
 * `DATABASE_URL` di `.env` memakai nama host `localhost`, yaitu pandangan dari mesin host tempat
 * `drizzle-kit` dijalankan. Container `app` tidak memakainya: `docker-compose.yml` menyusun
 * alamatnya sendiri dengan nama host `db`.
 */
const alamat = process.env.DATABASE_URL?.trim();
if (!alamat) {
	throw new Error(
		'Variabel lingkungan DATABASE_URL tidak diisi. Salin .env.example menjadi .env, lalu isi DATABASE_URL dengan alamat PostgreSQL, misalnya postgres://pengguna:kata-sandi@localhost:5432/komplek.'
	);
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	// Harus sama dengan `casing` pada panggilan `drizzle()` di src/lib/server/db/index.ts.
	casing: 'snake_case',
	dbCredentials: { url: alamat },
	// Minta konfirmasi sebelum menjalankan pernyataan yang bisa menghapus data.
	strict: true,
	verbose: true
});
