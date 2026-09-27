import {
	createConnection,
	failureCode,
	isConnectionFailure,
	readDatabaseUrl
} from '../src/lib/server/db/index';
import { systemClock } from '../src/lib/server/ports/clock';
import {
	DATA_FIX_ACTOR_ID,
	fixDuplicateOccupancies,
	type DuplicateFixMode,
	type DuplicateFixOutcome,
	type DuplicateFixPlan,
	type PlannedOccupancy
} from '../src/lib/server/services/occupancy/duplicate-fix';

/**
 * Deletes duplicate Masa Huni, the same resident recorded more than once in the same unit over days
 * that overlap, once, against whatever database `DATABASE_URL` names. `docs/spec-penghuni-v1.md`
 * decision 8 and ticket #242. Every rule, and the argument that it is safe, is in
 * `src/lib/server/services/occupancy/duplicate-fix.ts`; this file reads one flag and prints.
 *
 * ## Running it
 *
 * ```sh
 * bun --tsconfig-override scripts/tsconfig.seed.json scripts/fix-duplicate-occupancies.ts
 * bun --tsconfig-override scripts/tsconfig.seed.json scripts/fix-duplicate-occupancies.ts --yes
 * ```
 *
 * The first prints the plan and writes nothing. The second carries the plan out in one transaction.
 * There is deliberately no `package.json` entry and no `Dockerfile` step: this runs once. The
 * production image carries no `src/`, so for that one run it is bundled the way the `Dockerfile`
 * bundles `scripts/grant-superuser.ts`, with only `pg` and `drizzle-orm` left external, copied into
 * the `app` container, run there, and removed:
 *
 * ```sh
 * bun build scripts/fix-duplicate-occupancies.ts --target bun \
 *   --tsconfig-override scripts/tsconfig.seed.json \
 *   --external pg --external drizzle-orm --outfile <somewhere>/fix-duplicate-occupancies.js
 * ```
 *
 * There is no `localhost` guard, unlike `scripts/seed-dev.ts`: production is the database this is
 * for. What stands between it and a mistake is the dry run, which is the default, and `--yes`, which
 * has to be typed.
 *
 * ## What it never prints
 *
 * A name or an email: the plan carries neither, only block and number, occupancy ids, roles, days
 * and marker moves. An error object, an error's message, or `DATABASE_URL`: a failure is reported as
 * a category and a code, the code from `failureCode` in `src/lib/server/db/index.ts`, because a
 * Drizzle query error's message is the SQL followed by every parameter value, and a connection
 * error's can quote the host or the user. The handlers at the bottom make sure nothing thrown
 * outside `main` is printed by Bun on its own either.
 */

const PREFIX = 'fix-duplicate-occupancies:';

const USAGE = `Usage: bun --tsconfig-override scripts/tsconfig.seed.json scripts/fix-duplicate-occupancies.ts [--yes]`;

/** The flag that turns the dry run into the real thing. */
const APPLY_FLAG = '--yes';

/**
 * The mode the arguments ask for, or `undefined` when they are not understood. Nothing at all is a
 * dry run and `--yes` alone applies; anything else is refused, so that a mistyped flag cannot turn
 * into either one silently.
 */
function modeFrom(args: readonly string[]): DuplicateFixMode | undefined {
	if (args.length === 0) {
		return 'dryRun';
	}
	if (args.length === 1 && args[0] === APPLY_FLAG) {
		return 'apply';
	}
	return undefined;
}

/** A failure as the operator reads it: a category, a code, and what that means for the data. */
function stopped(category: string, code: string, consequence: string): number {
	console.error(`${PREFIX} stopped (${category}, ${code}). ${consequence}`);
	return 1;
}

/**
 * Codes meaning the database could not be reached, or stopped answering, beyond the ones
 * `isConnectionFailure` already knows: a Node socket code such as `ECONNREFUSED` or `ENOTFOUND`, and
 * `failureCode`'s own labels for `pg`'s uncoded timeouts and unusable clients.
 */
const UNREACHABLE_CODE = /^(E[A-Z_]+|connect-timeout|query-timeout|connection-unusable)$/;

/** A SQLSTATE: the database received the statement and refused it. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The category a failure is reported under. The code says the rest. */
function categoryOf(error: unknown): string {
	const code = failureCode(error);
	if (isConnectionFailure(error) || UNREACHABLE_CODE.test(code)) {
		return 'connection';
	}
	return SQLSTATE.test(code) ? 'database' : 'unexpected';
}

/** `count` with the noun that agrees with it: `1 occupancy`, `2 occupancies`. */
function counted(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** One row of the plan, on one line. */
function describeOccupancy(verdict: 'keep' | 'delete', row: PlannedOccupancy): string {
	const lastDay = row.endedOn ?? 'no last day';
	const marker = row.isPrimaryOccupant ? '  [Penanggung Jawab]' : '';
	return `    ${verdict.padEnd(6)}  ${row.occupancyId}  ${row.role.padEnd(6)}  ${row.startedOn} to ${lastDay}${marker}`;
}

/** Prints the plan unit by unit, and answers how many rows it deletes and markers it moves. */
function printPlan(plan: DuplicateFixPlan): { deletions: number; moves: number } {
	let deletions = 0;
	let moves = 0;
	console.log(
		`Duplicate occupancies, judged against ${plan.day} (the complex's calendar day, WIB).`
	);
	for (const unit of plan.units) {
		console.log('');
		console.log(`Unit block ${unit.block}, number ${unit.number}`);
		for (const group of unit.groups) {
			const rows = group.kept.length + group.deleted.length;
			console.log(`  One resident, ${counted(rows, 'occupancy', 'occupancies')}:`);
			for (const row of group.kept) {
				console.log(describeOccupancy('keep', row));
			}
			for (const row of group.deleted) {
				console.log(describeOccupancy('delete', row));
			}
			deletions += group.deleted.length;
		}
		for (const move of unit.moves) {
			console.log(
				`  Penanggung Jawab marker moves from ${move.fromOccupancyId} to ${move.toOccupancyId}.`
			);
		}
		moves += unit.moves.length;
	}
	console.log('');
	console.log(
		`Plan: delete ${counted(deletions, 'occupancy', 'occupancies')} in ${counted(plan.units.length, 'unit', 'units')}, move ${counted(moves, 'Penanggung Jawab marker', 'Penanggung Jawab markers')}.`
	);
	return { deletions, moves };
}

/** Prints the outcome and answers with the process exit code it deserves. */
function report(outcome: DuplicateFixOutcome, mode: DuplicateFixMode): number {
	if (outcome.kind === 'clean') {
		console.log(
			`No duplicate occupancies (same resident, same unit, overlapping days counted inclusively), judged against ${outcome.day}. Nothing to do, and nothing was written.`
		);
		return 0;
	}

	const { deletions, moves } = printPlan(outcome.plan);

	if (outcome.kind === 'refused') {
		console.log('');
		for (const conflict of outcome.conflicts) {
			console.log(
				`Refused: unit block ${conflict.block}, number ${conflict.number} would keep ${conflict.occupancyIds.length} Penanggung Jawab markers on occupancies whose last day has not passed: ${conflict.occupancyIds.join(', ')}.`
			);
		}
		console.log(
			'The whole plan is refused and nothing was written. Move the Penanggung Jawab of each unit above to one occupancy on its Penghuni page, then run this again.'
		);
		// A dry run has done its job by showing the refusal; a run asked to write has not.
		return mode === 'dryRun' ? 0 : 1;
	}

	if (outcome.kind === 'planned') {
		console.log(
			`Dry run: nothing was written. Run again with ${APPLY_FLAG} to carry out this plan in one transaction.`
		);
		return 0;
	}

	console.log(
		`Done in one transaction: ${counted(deletions, 'occupancy', 'occupancies')} deleted, ${counted(moves, 'marker', 'markers')} moved, ${counted(deletions + moves, 'audit entry', 'audit entries')} written by "${DATA_FIX_ACTOR_ID}".`
	);
	return 0;
}

/** Reads the flag, runs the clean-up, and closes the connection it opened. */
async function main(): Promise<number> {
	const mode = modeFrom(process.argv.slice(2));
	if (!mode) {
		console.error(USAGE);
		return 1;
	}

	let url: string;
	try {
		url = readDatabaseUrl();
	} catch {
		return stopped('configuration', 'DATABASE_URL-unset', 'Nothing was read or written.');
	}

	const connection = createConnection(url);
	try {
		return report(await fixDuplicateOccupancies(connection.db, systemClock, mode), mode);
	} catch (error) {
		return stopped(
			categoryOf(error),
			failureCode(error),
			mode === 'dryRun'
				? 'Nothing was written.'
				: `The transaction was rolled back unless the failure came while it committed. Run this again without ${APPLY_FLAG} to see what is left.`
		);
	} finally {
		await connection.close();
	}
}

/** Anything thrown outside `main`'s own handling, reported the same way and never printed whole. */
function lastResort(error: unknown): never {
	process.exit(
		stopped(
			'unexpected',
			failureCode(error),
			`Run this again without ${APPLY_FLAG} to see what is left.`
		)
	);
}

process.on('uncaughtException', lastResort);
process.on('unhandledRejection', lastResort);

try {
	process.exit(await main());
} catch (error) {
	lastResort(error);
}
