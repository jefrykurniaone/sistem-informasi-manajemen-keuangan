import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDatabaseUrl } from '$lib/server/db';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * `scripts/migrate-preflight.ts`, run the way `bun run db:migrate` runs it: as its own `bun`
 * process, reading `DATABASE_URL` from the environment. The point of the script is what it prints,
 * so every failing case asserts the category and code it names, and that the password appears in
 * neither stdout nor stderr (#202).
 *
 * `testDatabase()` is called only so that its `beforeAll` creates the database behind
 * `TEST_DATABASE_URL` when it does not exist yet, as on a fresh CI service container; the schema it
 * prepares is not used.
 */

testDatabase();

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = 'scripts/migrate-preflight.ts';

/** A fake password holding `#` and `@`, the characters that broke the first deploy (#180). */
const UNENCODED_PASSWORD = 'palsu#Rahasia@2026';
const FAKE_PASSWORD = 'kata-sandi-palsu-202';

/**
 * One run takes half a second from a shell, but 4 to 7 seconds from a Vitest worker on a loaded
 * Windows machine (measured 2026-09-25), so the default 20 second test timeout is too close.
 */
const SPAWN_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

interface Run {
	readonly status: number | null;
	readonly output: string;
}

/** Runs the script under Bun with only `DATABASE_URL` changed, and joins stdout and stderr. */
function runPreflight(databaseUrl: string): Run {
	const result = spawnSync('bun', [SCRIPT], {
		cwd: ROOT,
		env: { ...process.env, DATABASE_URL: databaseUrl },
		encoding: 'utf8',
		timeout: SPAWN_TIMEOUT_MS
	});
	if (result.error) {
		throw result.error;
	}
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('migrate-preflight', { timeout: TEST_TIMEOUT_MS }, () => {
	it('names an unparseable URL and never prints its password', () => {
		const run = runPreflight(`postgres://postgres:${UNENCODED_PASSWORD}@127.0.0.1:5432/postgres`);

		expect(run.status).toBe(1);
		expect(run.output).toContain('DATABASE_URL is not a valid URL (ERR_INVALID_URL)');
		expect(run.output).not.toContain(UNENCODED_PASSWORD);
		// Neither piece either: a parser that stops at `#` or `@` would quote only part of it.
		for (const piece of UNENCODED_PASSWORD.split(/[#@]/)) {
			expect(run.output).not.toContain(piece);
		}
	});

	it('names an unreachable host and never prints the password', () => {
		const run = runPreflight(`postgres://postgres:${FAKE_PASSWORD}@127.0.0.1:1/postgres`);

		expect(run.status).toBe(1);
		expect(run.output).toContain('the database host cannot be reached (ECONNREFUSED)');
		expect(run.output).not.toContain(FAKE_PASSWORD);
	});

	it('passes against the test database', () => {
		const run = runPreflight(readDatabaseUrl('TEST_DATABASE_URL'));

		expect(run.output).toContain('the database answered SELECT 1');
		expect(run.status).toBe(0);
	});
});
