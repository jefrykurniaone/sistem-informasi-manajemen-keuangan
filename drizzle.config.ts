import { defineConfig } from 'drizzle-kit';

/**
 * The `drizzle-kit` settings, used by `bun run db:generate` and `bun run db:migrate`.
 *
 * The URL is read from `DATABASE_URL`. That check is repeated here rather than imported from
 * `src/lib/server/db/index.ts` because `drizzle-kit` bundles this file on its own, and importing
 * that module would pull `pg` and the whole of Drizzle into the settings bundle just to read one
 * variable.
 *
 * `DATABASE_URL` in `.env` uses the host name `localhost`, which is the view from the host
 * machine where `drizzle-kit` runs. The `app` container does not use it: `docker-compose.yml`
 * builds its own URL with the host name `db`.
 */
const url = process.env.DATABASE_URL?.trim();
if (!url) {
	throw new Error(
		'Environment variable DATABASE_URL is not set. Copy .env.example to .env, then set DATABASE_URL to a PostgreSQL URL, for example postgres://user:password@localhost:5432/komplek.'
	);
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	// Has to match the `casing` on the `drizzle()` call in src/lib/server/db/index.ts.
	casing: 'snake_case',
	dbCredentials: { url },
	// Ask for confirmation before running a statement that could drop data.
	strict: true,
	verbose: true
});
