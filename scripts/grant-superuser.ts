import { createConnection, readDatabaseUrl } from '../src/lib/server/db/index';
import { systemClock } from '../src/lib/server/ports/clock';
import {
	bootstrapSuperuser,
	type BootstrapSuperuserOutcome
} from '../src/lib/server/services/user/bootstrap';

/**
 * Gives an already-registered account the `superuser` role, so that a freshly migrated database has
 * somebody who can open `/admin/roles` and grant every role after this one.
 *
 * ## Why a command, and not one of the other two shapes
 *
 * A **command naming an address** is what this is. It is run by a person, at the moment they mean
 * it, on the machine that holds `DATABASE_URL`, and the address is an argument rather than stored
 * configuration. There is no route, no form action and no endpoint, which is the requirement: "the
 * first account to sign up becomes superuser" would be a race against anyone who learns the
 * application's address before the committee has registered.
 *
 * An **environment variable read at start-up** was rejected. It re-decides the grant on every boot
 * rather than once, so whoever can edit the deployment environment — a CI variable, a compose file,
 * a hosting dashboard — appoints a superuser at the next restart, silently and with no moment a
 * person can point at. Its audit row would be stamped at boot time, which is not when anybody
 * decided anything, and removing the variable afterwards revokes nothing, so its value stops
 * describing the system it configures.
 *
 * A **seed step attached to the migrations** was rejected too. Migrations run unattended in every
 * environment and carry no argument, so the address would have to be either hard-coded — a real
 * person's email in version control, wrong the day the committee changes — or read from the
 * environment, which is the previous option wearing a different hat. The grant also has to stay
 * available months after the last migration, when a new committee takes over.
 *
 * ## Running it
 *
 * ```sh
 * bun run superuser:grant pengurus@komplek.local
 * ```
 *
 * `bun run` loads `.env` before the script starts, which is where `DATABASE_URL` comes from.
 *
 * ## What it must not import
 *
 * Only `db`, the `Clock` port and `bootstrap.ts`. `src/lib/server/auth.ts` imports `$app/server`,
 * which only SvelteKit's module loader can resolve, so pulling it — or anything that pulls it — in
 * would make this script need a shim to run at all. Everything it does touch resolves under plain
 * `bun run`.
 *
 * The real work lives in `bootstrap.ts` rather than here on purpose, and not only for testing:
 * `scripts/` is outside the `include` list of the generated `.svelte-kit/tsconfig.json`, so
 * `bun run check` does not type-check this file. Keeping it to argument handling and printing
 * leaves every decision in a file the gate does check.
 */

const USAGE = 'Usage: bun run superuser:grant <email>';

/** Prints the outcome and answers with the process exit code it deserves. */
function report(outcome: BootstrapSuperuserOutcome): number {
	if (outcome.kind === 'noSuchUser') {
		console.error(
			`No account is registered with the address "${outcome.email}". This command only grants a role to an account that already exists, so that account has to sign up first.`
		);
		return 1;
	}
	if (outcome.kind === 'alreadySuperuser') {
		// Not a failure: the operator asked for a state, and the state holds. Saying so plainly is
		// what lets somebody who is unsure whether the first run took effect simply run it again.
		console.log(
			`"${outcome.email}" (user ${outcome.userId}) already holds the "superuser" role. Nothing was changed, and no audit row was written.`
		);
		return 0;
	}
	console.log(
		`Granted the "superuser" role to "${outcome.email}" (user ${outcome.userId}). One "role_change" row was written to the audit log.`
	);
	return 0;
}

/** Reads the address off the command line, does the grant, and closes the connection it opened. */
async function main(): Promise<number> {
	const args = process.argv.slice(2);
	// Exactly one argument, so that a mistyped second word is refused rather than ignored.
	if (args.length !== 1) {
		console.error(USAGE);
		return 1;
	}

	const connection = createConnection(readDatabaseUrl());
	try {
		return report(await bootstrapSuperuser(connection.db, systemClock, args[0]));
	} finally {
		await connection.close();
	}
}

try {
	process.exit(await main());
} catch (error) {
	// A missing `DATABASE_URL` and a database that refuses the connection both land here. The
	// message alone is what an operator needs; the stack trace is noise at a shell prompt.
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
