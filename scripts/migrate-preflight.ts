import { Client, DatabaseError } from 'pg';

/**
 * Proves that `DATABASE_URL` reaches the database before `drizzle-kit migrate` runs, and says why
 * when it does not.
 *
 * ## Why it exists
 *
 * `drizzle-kit migrate` swallows the error `pg` throws for a URL it cannot parse. The first deploy
 * (#180) therefore ended with `error: script "db:migrate" exited with code 1` and nothing else, and
 * the cause, a Supabase password that was not percent-encoded, took a diagnosis on the server
 * (#202). The `db:migrate` script in package.json runs this file first, joined with `&&`, so the
 * same check guards `bun run db:migrate` in a working tree and in the `migrate` service of
 * docker-compose.prod.yml. It parses the URL the way `pg` does (by building a `Client`, which
 * parses the connection string on the spot), connects, runs `SELECT 1`, and on failure prints a
 * category and a code and exits 1, so `drizzle-kit` never starts.
 *
 * ## What it never prints
 *
 * The URL, the password, `err.input`, an error's message, or a whole error object. Node's
 * `ERR_INVALID_URL` carries the complete input, password included, in `input` and in its message,
 * and `pg`'s messages can quote the host or the user. Every line printed here is written in this
 * file; the only part taken from an error is its `code`, and only when it has the shape of one
 * (upper-case letters, digits and underscores). The last-resort handlers at the bottom turn
 * anything thrown outside the checks into the same kind of line, so Bun never prints an error
 * object on its own.
 *
 * ## How it reaches the production image
 *
 * The Dockerfile copies this file as it is, to the same path, instead of bundling it the way it
 * bundles `scripts/grant-superuser.ts`. That script needs a bundle because it imports from `src/`,
 * which the image does not carry. This one imports nothing but `pg`, which the image's
 * node_modules already holds, and Bun runs a `.ts` file directly, so a bundle would add a build
 * step and change nothing. The consequence is a rule: never import `$lib` or anything under
 * `src/` here.
 */

const PREFIX = 'migrate-preflight:';

/** How long a connection attempt may take before it counts as an unreachable host. */
const CONNECT_TIMEOUT_MS = 15_000;

/** The shape of a code worth printing. Anything else is reported as having no code. */
const PRINTABLE_CODE = /^[A-Z0-9_]{1,64}$/;

/** The shape of an error name worth printing, for an error that has no code. */
const PRINTABLE_NAME = /^[A-Za-z]{1,64}$/;

/** Node and OpenSSL codes for a certificate or TLS handshake failure. */
const TLS_CODE = /CERT|SSL|TLS/;

/** How deep `codeOf` follows `cause` and `errors`, so a cycle cannot hang it. */
const MAX_ERROR_DEPTH = 5;

const INVALID_URL_CODE = 'ERR_INVALID_URL';

/** A host that does not resolve, refuses the connection, or does not answer. */
const UNREACHABLE_CODES = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH'
]);

/** SQLSTATE codes for a refused user name or password. */
const AUTHENTICATION_CODES = new Set(['28P01', '28000']);

/** SQLSTATE for a database name that does not exist on the server. */
const NO_SUCH_DATABASE_CODE = '3D000';

/** `pg` reads the file named by `sslrootcert` while it parses the URL; these are its failures. */
const UNREADABLE_FILE_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR']);

/** Fixed messages `pg` 8 uses for two failures that carry no code. */
const PG_TIMEOUT_MESSAGE = 'connection timeout';
const PG_NO_SSL_MESSAGE = 'does not support SSL';

/**
 * Takes the first printable `code` off an error, its `cause` chain, or the errors inside an
 * `AggregateError` (what a connection to a name with several addresses fails with).
 */
function codeOf(error: unknown, depth = 0): string | undefined {
	if (depth > MAX_ERROR_DEPTH || typeof error !== 'object' || error === null) {
		return undefined;
	}
	const { code } = error as { code?: unknown };
	if (typeof code === 'string' && PRINTABLE_CODE.test(code)) {
		return code;
	}
	if (error instanceof AggregateError) {
		for (const inner of error.errors) {
			const innerCode = codeOf(inner, depth + 1);
			if (innerCode) {
				return innerCode;
			}
		}
	}
	return codeOf((error as { cause?: unknown }).cause, depth + 1);
}

/** The code to print for an error: its own code, else its class name, else `unknown`. */
function labelOf(error: unknown): string {
	const code = codeOf(error);
	if (code) {
		return code;
	}
	if (error instanceof Error && PRINTABLE_NAME.test(error.name)) {
		return error.name;
	}
	return 'unknown';
}

/** Read to recognise a failure, never printed. */
function messageIncludes(error: unknown, fragment: string): boolean {
	return error instanceof Error && error.message.includes(fragment);
}

/** Prints what went wrong and what to check, and answers with the exit status. */
function fail(summary: string, hint: string): number {
	console.error(`${PREFIX} ${summary}`);
	console.error(`${PREFIX} ${hint}`);
	console.error(`${PREFIX} Stopped before drizzle-kit migrate; nothing was migrated.`);
	return 1;
}

function failUnreachable(label: string): number {
	return fail(
		`the database host cannot be reached (${label}).`,
		'Check the host and port in DATABASE_URL; the Supabase session pooler listens on port 5432. A password holding an unencoded #, / or ? also makes the URL name the wrong host.'
	);
}

function failTls(label: string): number {
	return fail(
		`the TLS connection to the database failed (${label}).`,
		'Check sslmode and sslrootcert in DATABASE_URL, and that certs/supabase-ca.crt next to docker-compose.prod.yml is the CA certificate from the Supabase dashboard.'
	);
}

/** A failure while `pg` parses the URL, before any connection is attempted. */
function reportParseFailure(error: unknown): number {
	const code = codeOf(error);
	if (code === INVALID_URL_CODE) {
		return fail(
			`DATABASE_URL is not a valid URL (${INVALID_URL_CODE}).`,
			'A character in the password most likely has to be percent-encoded: every character outside A-Z a-z 0-9 - . _ ~ is written as %XX, for example # as %23, / as %2F, ? as %3F and @ as %40. scripts/setup-env.sh checks this and can encode the password for you.'
		);
	}
	if (code && UNREADABLE_FILE_CODES.has(code)) {
		return fail(
			`the CA certificate named by sslrootcert in DATABASE_URL cannot be read (${code}).`,
			'On the server it is certs/supabase-ca.crt next to docker-compose.prod.yml, mounted at /app/certs.'
		);
	}
	return fail(
		`DATABASE_URL could not be read as a connection string (${labelOf(error)}).`,
		'Compare it with the DATABASE_URL line of .env.production.example.'
	);
}

/** A failure the database server itself reported, with a SQLSTATE code. */
function reportDatabaseRefusal(label: string): number {
	if (AUTHENTICATION_CODES.has(label)) {
		return fail(
			`the database refused the user name or password (${label}).`,
			'Check the user and password in DATABASE_URL. A % followed by two hexadecimal digits is read as an encoded character, so a password that holds one literally has to write that % as %25.'
		);
	}
	if (label === NO_SUCH_DATABASE_CODE) {
		return fail(
			`the database named in DATABASE_URL does not exist (${label}).`,
			'Check the database name after the host; on Supabase it is postgres.'
		);
	}
	return fail(
		`the database refused the connection (SQLSTATE ${label}).`,
		'Look the code up in the PostgreSQL documentation, appendix "PostgreSQL Error Codes".'
	);
}

/** A failure while connecting or running `SELECT 1`. */
function reportConnectFailure(error: unknown): number {
	const label = labelOf(error);
	if (error instanceof DatabaseError) {
		return reportDatabaseRefusal(label);
	}
	if (UNREACHABLE_CODES.has(label)) {
		return failUnreachable(label);
	}
	if (TLS_CODE.test(label)) {
		return failTls(label);
	}
	if (messageIncludes(error, PG_TIMEOUT_MESSAGE)) {
		return failUnreachable(`no answer within ${CONNECT_TIMEOUT_MS / 1000} seconds`);
	}
	if (messageIncludes(error, PG_NO_SSL_MESSAGE)) {
		return failTls('the server does not offer TLS');
	}
	return fail(
		`the connection to the database failed (${label}).`,
		'Check DATABASE_URL against the DATABASE_URL line of .env.production.example.'
	);
}

async function main(): Promise<number> {
	const url = process.env.DATABASE_URL?.trim();
	if (!url) {
		return fail(
			'DATABASE_URL is not set.',
			'Set it in .env, or on the server in /opt/komplek/.env, which docker-compose.prod.yml hands to the migrate service.'
		);
	}

	let client: Client;
	try {
		client = new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
	} catch (error) {
		return reportParseFailure(error);
	}
	// An `error` event without a listener is thrown, and Bun would print the whole error object.
	client.on('error', () => undefined);

	try {
		await client.connect();
	} catch (error) {
		// No `end()` here: the connection never opened, and the process exits right after.
		return reportConnectFailure(error);
	}
	try {
		await client.query('SELECT 1');
	} catch (error) {
		return reportConnectFailure(error);
	} finally {
		await client.end().catch(() => undefined);
	}

	console.log(`${PREFIX} DATABASE_URL parses, and the database answered SELECT 1.`);
	return 0;
}

/** Anything thrown outside the checks above, reported by its code alone. */
function lastResort(error: unknown): never {
	console.error(`${PREFIX} unexpected failure (${labelOf(error)}). Nothing was migrated.`);
	process.exit(1);
}

process.on('uncaughtException', lastResort);
process.on('unhandledRejection', lastResort);

try {
	process.exit(await main());
} catch (error) {
	lastResort(error);
}
