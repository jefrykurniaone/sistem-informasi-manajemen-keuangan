import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

/**
 * The single place where the Drizzle connection to PostgreSQL is built.
 *
 * Decisions settled here and used by every later spec:
 *
 * 1. **Factory first, singleton second.** `createConnection()` is a factory taking the database
 *    URL as an argument, and `database()` is a lazy singleton on top of it. The order matters
 *    because tests need a connection to a *different* database than the development server, and
 *    a single test file even needs a schema of its own. If this module exported one `db` object
 *    built at import time, there would be no way to open a second connection without patching
 *    environment variables.
 * 2. **Lazy, not at import time.** The singleton is built on first call. This module is pulled
 *    into the import graph of pure unit tests and command-line tooling that never touch the
 *    database at all; building a connection pool at import time would make them fail for reasons
 *    unrelated to what is under test.
 * 3. **`process.env`, not `$env/dynamic/private`.** This file is read from three places with
 *    different module loaders: the SvelteKit server, Vitest, and `drizzle-kit`. Only the first
 *    can resolve the `$env` alias. `process.env` works in all three, and `bun run` has already
 *    loaded `.env` into it before any command runs.
 * 4. **Errors that name the variable.** An empty URL is rejected here with a message naming its
 *    environment variable, rather than being passed to the driver and surfacing a dozen frames
 *    down as a `TypeError` about an undefined `host` property.
 */

/** The application database, already bound to the schema in `./schema`. */
export type Database = NodePgDatabase<typeof schema>;

/** A live connection together with the way to close it. */
export interface Connection {
	readonly db: Database;
	readonly pool: Pool;
	close(): Promise<void>;
}

/**
 * Reads a database URL from an environment variable.
 *
 * @param name the variable's name — `DATABASE_URL` for the application, `TEST_DATABASE_URL` for
 *   the test harness.
 * @throws {Error} with a message naming the variable when it is empty or missing.
 */
export function readDatabaseUrl(
	name = 'DATABASE_URL',
	environment: NodeJS.ProcessEnv = process.env
): string {
	const url = environment[name]?.trim();
	if (!url) {
		throw new Error(
			`Environment variable ${name} is not set. Copy .env.example to .env, then set ${name} to a PostgreSQL URL, for example postgres://user:password@localhost:5432/komplek.`
		);
	}
	return url;
}

/**
 * Builds a new Drizzle connection. Every call produces its own connection pool, which the caller
 * has to close.
 *
 * @param url the full PostgreSQL URL.
 * @param options extra `pg` settings. The test harness uses them to pin a test file's
 *   `search_path` to its own schema.
 */
export function createConnection(url: string, options: PoolConfig = {}): Connection {
	const pool = new Pool({ ...options, connectionString: url });
	// `casing` has to match the one in drizzle.config.ts. See the note in ./schema.
	const db = drizzle({ client: pool, schema, casing: 'snake_case' });
	return {
		db,
		pool,
		close: () => pool.end()
	};
}

let applicationConnection: Connection | undefined;

/**
 * The running application's database, built once from `DATABASE_URL` on first call. The service
 * layer uses this; tests do not — they use `createConnection()` through `./test-helpers`.
 */
export function database(): Database {
	applicationConnection ??= createConnection(readDatabaseUrl());
	return applicationConnection.db;
}

/** Closes the application connection if it was ever built. Used on process shutdown. */
export async function closeDatabase(): Promise<void> {
	const connection = applicationConnection;
	applicationConnection = undefined;
	await connection?.close();
}
