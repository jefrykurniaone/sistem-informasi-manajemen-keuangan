import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll } from 'vitest';
import { createConnection, readDatabaseUrl, type Connection, type Database } from './index';

/**
 * The database test harness: one clean PostgreSQL schema per test file.
 *
 * ## Contract
 *
 * `testDatabase()` is called once at the top of a test file. It registers `beforeAll` and
 * `afterAll` hooks and returns a handle whose `db` is ready to use inside every `it`. That file
 * gets a PostgreSQL schema of its own, already migrated and empty, and the schema is dropped
 * entirely once the file finishes.
 *
 * ## Why a schema per file rather than a rolled-back transaction
 *
 * Wrapping each test in a transaction and rolling it back is the fastest approach, and it is
 * **deliberately not used**. The financial specs write to an append-only cash book, and the rules
 * there are rules about committing: the sequence number taken at commit, the row lock held until
 * commit, the trigger refusing an update after commit, and the scheduled job taking a lock for
 * one period. None of that can be tested from inside a transaction that never commits — the test
 * would pass against behaviour that never happens in production. Inside its own schema a test
 * commits for real, reads back what it committed, and still stays invisible to other files.
 *
 * Cleaning with `truncate` between tests is rejected too: it shares one namespace, so two files
 * running at the same time — and Vitest does run files in parallel — would delete each other's
 * rows. A schema per file gives the same isolation without forcing tests to run serially.
 *
 * The price: migrations are re-run for every test file. While the migrations are still tens of
 * SQL files, that costs under a second per file. If it ever becomes noticeable, the next step is
 * to prepare one template schema once and copy it, not to go back to rolling back.
 *
 * ## Which database
 *
 * `TEST_DATABASE_URL`, which must differ from `DATABASE_URL`. This harness drops schemas and
 * creates databases; pointing it at the same database as the development server is an expensive
 * mistake, so it is rejected here rather than allowed to run. The test database is created
 * automatically when it does not exist, so `docker compose up db` followed by `bun run test` is
 * enough without a manual setup step.
 */

/** The name of the migration journal table inside the test schema. It is dropped with the schema. */
const MIGRATIONS_TABLE = '__migrations__';

/** The PostgreSQL error code for a database that does not exist. */
const DATABASE_DOES_NOT_EXIST = '3D000';

/**
 * The PostgreSQL error codes meaning "the database already exists" when two test files running in
 * parallel race to create it. `42P04` comes from the name check, `23505` from the
 * `pg_database_datname_index` unique index when that race is lost by a hair; both mean another
 * file has already done the work.
 */
const DATABASE_ALREADY_EXISTS = ['42P04', '23505'];

/** The handle returned by `testDatabase()`. */
export interface TestDatabase {
	/** This file's database. Only available once `beforeAll` has run. */
	readonly db: Database;
	/** The name of this file's PostgreSQL schema, useful when reading error messages. */
	readonly schemaName: string;
}

/**
 * Prepares a clean PostgreSQL schema for the test file that calls it.
 *
 * ```ts
 * const testDb = testDatabase();
 *
 * it('stores a row', async () => {
 *   await testDb.db.insert(scaffoldProbe).values({ description: 'one', amount: rupiah(1) });
 * });
 * ```
 */
export function testDatabase(): TestDatabase {
	const schemaName = `test_${randomUUID().replaceAll('-', '')}`.slice(0, 40);
	let connection: Connection | undefined;

	beforeAll(async () => {
		const url = testDatabaseUrl();
		await ensureDatabaseExists(url);
		connection = createConnection(url, { options: `-c search_path=${schemaName}` });
		await prepareSchema(connection.db, schemaName);
	});

	afterAll(async () => {
		if (!connection) {
			return;
		}
		await connection.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
		await connection.close();
	});

	return {
		schemaName,
		get db() {
			if (!connection) {
				throw new Error(
					'The test database is not ready. testDatabase() must be called at the top of a test file, and its db may only be used inside it() or beforeEach, not at module scope.'
				);
			}
			return connection.db;
		}
	};
}

/** Reads `TEST_DATABASE_URL` and refuses it when it points at the development server's database. */
function testDatabaseUrl(): string {
	const url = readDatabaseUrl('TEST_DATABASE_URL');
	if (url === process.env.DATABASE_URL?.trim()) {
		throw new Error(
			'TEST_DATABASE_URL is identical to DATABASE_URL. The test harness creates and drops schemas, so it refuses to run against the development server database. Set TEST_DATABASE_URL to a database of its own, for example komplek_test.'
		);
	}
	return url;
}

/** Creates this file's schema, proves `search_path` really points at it, then migrates. */
async function prepareSchema(db: Database, schemaName: string): Promise<void> {
	await db.execute(sql.raw(`create schema if not exists "${schemaName}"`));

	// `search_path` is set when the connection is opened, at which point the schema does not exist
	// yet. This check proves it really applies now; without it a misconfiguration would put the
	// tables in `public` and cross-file isolation would be lost without a single test failing.
	const result = await db.execute<{ schemaName: string | null }>(
		sql`select current_schema() as "schemaName"`
	);
	if (result.rows[0]?.schemaName !== schemaName) {
		throw new Error(
			`search_path does not point at the test schema: current_schema() is ${result.rows[0]?.schemaName}, expected ${schemaName}.`
		);
	}

	await migrate(db, {
		migrationsFolder: path.resolve(process.cwd(), 'drizzle'),
		migrationsSchema: schemaName,
		migrationsTable: MIGRATIONS_TABLE
	});
}

/**
 * Creates the test database when it does not exist yet, by connecting to the `postgres`
 * maintenance database on the same server. The normal path pays nothing: creation is only
 * attempted after the first connection is refused with `3D000`.
 */
async function ensureDatabaseExists(url: string): Promise<void> {
	const connection = createConnection(url);
	try {
		await connection.db.execute(sql`select 1`);
		return;
	} catch (error) {
		if (errorCode(error) !== DATABASE_DOES_NOT_EXIST) {
			throw error;
		}
	} finally {
		await connection.close();
	}
	await createDatabase(url);
}

/** Runs `create database` through the `postgres` maintenance database. */
async function createDatabase(url: string): Promise<void> {
	const target = new URL(url);
	const name = decodeURIComponent(target.pathname.slice(1));
	target.pathname = '/postgres';

	const connection = createConnection(target.toString());
	try {
		await connection.db.execute(sql.raw(`create database "${name.replaceAll('"', '""')}"`));
	} catch (error) {
		// Two test files running in parallel can both reach this point.
		const code = errorCode(error);
		if (!code || !DATABASE_ALREADY_EXISTS.includes(code)) {
			throw error;
		}
	} finally {
		await connection.close();
	}
}

/**
 * Takes `code` off a PostgreSQL error, or `undefined` when the error does not have that shape.
 *
 * Drizzle wraps driver errors inside its own, so the code is on the `cause` chain rather than on
 * the outermost error.
 */
function errorCode(error: unknown): string | undefined {
	let current: unknown = error;
	while (current instanceof Error) {
		if ('code' in current && typeof current.code === 'string') {
			return current.code;
		}
		current = current.cause;
	}
	return undefined;
}
