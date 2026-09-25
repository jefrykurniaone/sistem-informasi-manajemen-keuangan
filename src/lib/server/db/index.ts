import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type ClientBase, type PoolClient, type PoolConfig } from 'pg';
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
 * 5. **Every pool survives the server ending a connection, and bounds every wait.** Added by ticket
 *    #215, after Supabase ended the scheduler's connections four times in a day with
 *    `terminating connection due to administrator command` (SQLSTATE `57P01`). Every setting is in
 *    `createConnection`, so the application, the test harness and the scripts all get the same
 *    pool; each value and the reason for it is on its constant below.
 *
 * ## What a connection the server ends used to do to this process
 *
 * `pg` reports a connection the server ended as an `error` event, and Node turns an `error` event
 * nobody listens to into an uncaught exception, which ends an adapter-node server. Two places had
 * no listener, and `tests/unit/scheduler-resilience.test.ts` reproduces both against a real
 * `pg_terminate_backend`:
 *
 * - **A client idle in the pool.** `pg-pool` drops it and re-emits the error on the pool itself,
 *   where nothing listened. `pool.on('error')` below now does.
 * - **A client checked out and held between statements**, which is every `db.transaction`.
 *   `pg-pool` takes its own listener off a client while it is lent out, and Drizzle adds none, so
 *   the client's own `error` event reached nobody. `guardLentClient` below gives every client a
 *   listener for its whole life. The caller is not left unaware: every query waiting on that
 *   client fails with the same error, the next one fails with "not queryable", and the pool drops
 *   the client when it is released.
 *
 * A dropped client is never reused: the pool opens a new connection the next time one is needed.
 *
 * ## What is logged about it
 *
 * The code and nothing else; see `failureCode`. The error object is never printed: the one the
 * pool emits carries the client on it, and the client carries its connection parameters, password
 * included, where `console` would print them. A query error from Drizzle is no better: its message
 * is the SQL text followed by every parameter value.
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
 * How long opening a connection may take, and how long a caller may wait for a free one when every
 * connection in the pool is busy, before it gets an error instead: ten seconds.
 *
 * `pg` waits forever by default. A connection attempt into a network that drops packets rather
 * than refusing them then hangs for as long as the operating system retries a TCP handshake (two
 * minutes on Linux), and a scheduler tick, or a request, hangs with it. Opening a TLS connection to
 * the Supabase pooler takes well under a second, and waiting ten seconds for one of the pool's
 * connections to come free means something is holding all of them far longer than any request or
 * job does, so failing is more useful than queueing behind it.
 */
const CONNECTION_TIMEOUT_MILLISECONDS = 10_000;

/**
 * How long a connection may sit unused in the pool before the pool closes it: ten seconds, which is
 * `pg`'s own default, written down here so that it reads as a decision.
 *
 * Lowering it would not have prevented a single one of the failures #215 was about. `57P01` is the
 * server being told to end a session (`pg_terminate_backend`, a restart, the pooler shutting a
 * connection down), not an idle limit running out, which PostgreSQL reports as `57P05`. Ten seconds
 * is also far below any idle limit a pooler applies, which are counted in minutes. Raising it would
 * only keep more connections open, and so exposed to such a termination, for nothing.
 */
const IDLE_TIMEOUT_MILLISECONDS = 10_000;

/**
 * How long a connection is silent before TCP starts probing whether the other end is still there:
 * ten seconds, the same as the idle timeout.
 *
 * `keepAlive` is on so that a connection dropped silently by something between this server and the
 * database, such as a NAT table or a firewall, is noticed rather than waited on. Turning it on with
 * no delay leaves the operating system's default, which is two hours on Linux and longer than any
 * connection here lives. With ten seconds, and the pool closing a connection after ten idle seconds
 * anyway, a probe only ever goes out on a connection waiting on a long statement or held open by a
 * transaction, which is exactly where a dead peer would otherwise go unnoticed.
 */
const KEEP_ALIVE_INITIAL_DELAY_MILLISECONDS = 10_000;

/**
 * The longest one statement may run on the server before PostgreSQL cancels it: one minute.
 *
 * Every statement in this application is short. The longest legitimate work is issuing a month's
 * Tagihan for every Unit and composing a Laporan Bulanan, and both are many statements rather than
 * one (issuance opens a transaction per Unit), so the longest single statement is a read of every
 * active Unit or one Periode's rows, which takes milliseconds for a housing complex. A minute is
 * three orders of magnitude above that, including a wait for a row lock another short transaction
 * holds, and it is below the two minutes Supabase applies to the `postgres` role by default, so it
 * is this value that decides rather than a platform default nobody here chose.
 *
 * It is the server that enforces it, so a statement that runs too long is cancelled cleanly: it
 * fails with `57014`, its transaction rolls back, and the connection stays usable. It is set with a
 * `set_config` right after connecting rather than as a startup parameter, because Supabase documents
 * session-level settings as working through its session pooler, which is what `DATABASE_URL` points
 * at (`docs/deploy.md`), and does not say that its pooler accepts one in the startup packet.
 */
const STATEMENT_TIMEOUT_MILLISECONDS = 60_000;

/**
 * How long the client waits for the answer to one statement before giving up on it: ninety seconds,
 * thirty more than `STATEMENT_TIMEOUT_MILLISECONDS`.
 *
 * This is the bound for the case the server-side timeout cannot cover: a connection that went dead
 * without either end closing it, where the server's cancellation would never arrive.
 *
 * It is kept above the statement timeout on purpose. A client-side timeout abandons a statement the
 * server may still be running, and inside a `db.transaction` the connection could then go back to
 * the pool with that transaction still open, for the next caller to write into. Because the server
 * cancels every statement at one minute, a server that can still answer always does so before this
 * fires, so it only ever fires on a connection that no longer reaches one, where nothing can be
 * written into anything.
 */
const QUERY_TIMEOUT_MILLISECONDS = STATEMENT_TIMEOUT_MILLISECONDS + 30_000;

/** The settings every pool this module builds starts from. See each constant for its reason. */
const POOL_DEFAULTS: PoolConfig = {
	connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
	idleTimeoutMillis: IDLE_TIMEOUT_MILLISECONDS,
	keepAlive: true,
	keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MILLISECONDS,
	query_timeout: QUERY_TIMEOUT_MILLISECONDS
};

/**
 * Builds a new Drizzle connection. Every call produces its own connection pool, which the caller
 * has to close.
 *
 * @param url the full PostgreSQL URL.
 * @param options extra `pg` settings, applied over `POOL_DEFAULTS`. The test harness uses them to
 *   pin a test file's `search_path` to its own schema. `onConnect` is not one of them: it is what
 *   applies the statement timeout, so it is always this module's own.
 */
export function createConnection(url: string, options: PoolConfig = {}): Connection {
	const pool = new Pool({
		...POOL_DEFAULTS,
		...options,
		connectionString: url,
		onConnect: applySessionSettings
	});
	pool.on('error', reportIdleConnectionLost);
	pool.on('connect', guardLentClient);
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

/**
 * SQLSTATEs meaning the server ended the session a statement was running in, rather than refusing
 * the statement: `57P01` admin_shutdown (`pg_terminate_backend`, a server or pooler shutting the
 * session down), `57P02` crash_shutdown (the server resetting after another backend crashed) and
 * `57P03` cannot_connect_now (the server starting up or shutting down).
 */
const SESSION_ENDED_SQLSTATES: ReadonlySet<string> = new Set(['57P01', '57P02', '57P03']);

/** SQLSTATE class `08`, connection_exception: `08000`, `08003`, `08006`, `08P01` and the rest. */
const CONNECTION_EXCEPTION_SQLSTATE = /^08[0-9A-Z]{3}$/;

/** What a failure `pg` reports as "Connection terminated unexpectedly" is logged and matched as. */
const CONNECTION_TERMINATED = 'connection-terminated';

/** Node's code for a socket the other end reset. */
const SOCKET_RESET = 'ECONNRESET';

/**
 * The failures `pg` raises with a message and no code, each with the label `failureCode` answers
 * for it. The messages are the driver's own fixed strings, so matching them is exact.
 */
const UNCODED_DRIVER_FAILURES: ReadonlyMap<string, string> = new Map([
	['Connection terminated unexpectedly', CONNECTION_TERMINATED],
	['Connection terminated due to connection timeout', 'connect-timeout'],
	['timeout exceeded when trying to connect', 'connect-timeout'],
	['Query read timeout', 'query-timeout'],
	['Client has encountered a connection error and is not queryable', 'connection-unusable']
]);

/**
 * The code that says what went wrong, safe to write to a log: the SQLSTATE of a PostgreSQL error,
 * the code of a Node socket error, a fixed label for one of `pg`'s own uncoded failures, or failing
 * all of those, the name of the innermost error's class.
 *
 * Never a message. A Drizzle query error's message is the SQL text followed by every parameter
 * value, and even PostgreSQL's own messages quote the value that was refused. The code is looked
 * for along the `cause` chain, because Drizzle wraps the driver's error rather than rethrowing it,
 * the same walk `./test-helpers.ts` does for the database-creation race.
 */
export function failureCode(error: unknown): string {
	let innermost: Error | undefined;
	for (const link of causeChain(error)) {
		if ('code' in link && typeof link.code === 'string') {
			return link.code;
		}
		const label = UNCODED_DRIVER_FAILURES.get(link.message);
		if (label) {
			return label;
		}
		innermost = link;
	}
	return innermost?.name ?? typeof error;
}

/**
 * Whether `error` is a failure of the connection a statement travelled on, rather than of the
 * statement: one of `SESSION_ENDED_SQLSTATES`, SQLSTATE class `08`, `pg`'s "Connection terminated
 * unexpectedly", or the socket being reset under it. A statement that failed this way may or may not
 * have been carried out, and is worth trying once more on a new connection; see the scheduler's
 * `writeJobRun` for the one place that does.
 *
 * Deliberately not included: the two timeouts this module sets. A statement that has already
 * waited `QUERY_TIMEOUT_MILLISECONDS`, or a caller that has waited `CONNECTION_TIMEOUT_MILLISECONDS`
 * for a connection, would wait as long again for a retry with no reason to expect another answer.
 * Every other SQLSTATE is a verdict on the statement, which repeating it will not change.
 */
export function isConnectionFailure(error: unknown): boolean {
	const code = failureCode(error);
	return (
		SESSION_ENDED_SQLSTATES.has(code) ||
		CONNECTION_EXCEPTION_SQLSTATE.test(code) ||
		code === CONNECTION_TERMINATED ||
		code === SOCKET_RESET
	);
}

/** `error`, then its `cause`, then that one's, for as long as each is an `Error` not already seen. */
function* causeChain(error: unknown): Generator<Error> {
	const seen = new Set<Error>();
	let current: unknown = error;
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		yield current;
		current = current.cause;
	}
}

/**
 * Runs on every new connection before the pool lends it to anyone: sets the statement timeout for
 * the session. `set_config` with parameters rather than a `set` statement built from a string.
 */
async function applySessionSettings(client: ClientBase): Promise<void> {
	await client.query('select set_config($1, $2, false)', [
		'statement_timeout',
		String(STATEMENT_TIMEOUT_MILLISECONDS)
	]);
}

/**
 * The pool's `error` listener: a connection idle in the pool was ended by the server, or its socket
 * failed, and the pool has already dropped it. Logged by its code alone, for the reason this module's
 * doc comment gives, and never rethrown, because nothing is waiting on an idle connection.
 */
function reportIdleConnectionLost(error: Error): void {
	console.warn(
		`A database connection idle in the pool was closed (${failureCode(error)}). The pool dropped it and opens a new one when one is next needed.`
	);
}

/** Gives a new client an `error` listener for its whole life. See this module's doc comment. */
function guardLentClient(client: PoolClient): void {
	client.on('error', ignoreErrorTheCallerAlreadyHas);
}

/**
 * The `error` listener every client carries while it is lent out, when `pg-pool` has taken its own
 * off. Doing nothing is the whole point: every query waiting on the client has already failed with
 * this error, the next one fails with "not queryable", and the pool drops the client when it is
 * released. The listener only exists so that Node does not also turn the event into an uncaught
 * exception.
 */
function ignoreErrorTheCallerAlreadyHas(): void {
	// Intentionally empty; the error has already reached the caller through its own query.
}
