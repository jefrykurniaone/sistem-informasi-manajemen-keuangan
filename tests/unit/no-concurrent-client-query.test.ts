import { randomUUID } from 'node:crypto';
import ExcelJS, { type CellValue } from 'exceljs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { cashBook } from '$lib/server/services/cash/balance';
import { importResidents } from '$lib/server/services/import/resident-import';
import { IMPORT_HEADER } from '$lib/server/services/import/validation';
import { composeReportFigures } from '$lib/server/services/report/composition';

/**
 * #231: `pg` warns "Calling client.query() when the client is already executing a query is
 * deprecated and will be removed in pg@9.0" whenever a caller fires a second query at a client
 * before the first has answered. That pattern reaches this codebase through `Promise.all` over a
 * writer that is a transaction, or another single lent client, rather than the pool: see the
 * doc comment `composeReportFigures` in `../../src/lib/server/services/report/composition.ts` and
 * `findStoredConflicts` in `../../src/lib/server/services/import/resident-import.ts` carry for the
 * two places this was true.
 *
 * ## Why this file does not read the `pg` warning at all
 *
 * `pg` prints it once per process, from inside `Client.prototype.query`, not once per call, so a
 * test cannot count occurrences of it without the count depending on which worker, and how many
 * other files, happened to share the process. `detectClientQueryOverlap` below reimplements the
 * same check `pg` makes before it prints that warning, whether another query was already running on
 * this exact client, directly, by wrapping `Client.prototype.query` for the length of one call and
 * counting queries in flight per client. That is deterministic, and it is what `pg`'s own warning is
 * evidence of, not a substitute measurement of something else.
 *
 * ## Why this proves the fix rather than only describing it
 *
 * Each test below calls the real, fixed service through the same kind of client the bug needed: a
 * transaction for `composeReportFigures` (`../../src/lib/server/services/report/publication.ts` calls
 * it with one while publishing), and `importResidents`'s own transaction for `findStoredConflicts`
 * (reached through `examine`). Before the fix in this ticket, both fired their queries with
 * `Promise.all` on exactly that client, which `overlapped` below turns `true`; the pull request for
 * #231 records that run. The third test is the contrast case named in the ticket:
 * `cashBook`'s own `Promise.all` is left alone because its client is the pool, where every query in
 * the array gets its own connection, and `overlapped` staying `false` there is what proves the
 * detector does not simply flag every `Promise.all` it sees.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The period `composeReportFigures` is asked about. No cash or invoice rows are needed for it: an
 * empty month still runs all three of its reads, which is all this file is checking. */
const PERIOD = '2026-01';

/** How the wrapped `Client.prototype.query` is restored, and what it found. */
interface OverlapDetection<T> {
	/** What `run` returned. */
	readonly result: T;
	/** True the moment a second query started on a client that already had one outstanding. */
	readonly overlapped: boolean;
}

/**
 * Runs `run` with `pg`'s `Client.prototype.query` wrapped so that a second query starting on a
 * client before an earlier one on the *same* client has settled is caught directly, rather than read
 * off `pg`'s own once-per-process warning.
 *
 * Every `PoolClient` `pg-pool` hands out is a real `pg.Client` instance (`new this.Client(...)` in
 * `pg-pool`), and the pool's own `.query()` acquires one of those per call and releases it
 * afterwards, so patching the one shared prototype covers both a pool query and a transaction's
 * client, and a `WeakMap` keyed by the client instance is what tells the two apart: concurrent calls
 * that land on different clients (the pool) never overlap here, and concurrent calls that land on one
 * client (a transaction, or any other lent client) always do.
 */
async function detectClientQueryOverlap<T>(run: () => Promise<T>): Promise<OverlapDetection<T>> {
	const inFlightByClient = new WeakMap<object, number>();
	let overlapped = false;
	const original = Client.prototype.query;

	Client.prototype.query = function patchedQuery(
		this: InstanceType<typeof Client>,
		...args: Parameters<typeof original>
	) {
		const before = inFlightByClient.get(this) ?? 0;
		if (before > 0) {
			overlapped = true;
		}
		inFlightByClient.set(this, before + 1);

		const settle = (): void => {
			inFlightByClient.set(this, (inFlightByClient.get(this) ?? 1) - 1);
		};

		const outcome: unknown = original.apply(this, args);
		if (outcome instanceof Promise) {
			outcome.then(settle, settle);
		} else {
			// Every call this file makes goes through Drizzle, which never passes a callback, so `pg`
			// always hands back a Promise here. Settling immediately for any other shape keeps the
			// counter honest instead of leaking an in-flight count this probe would otherwise never
			// clear.
			settle();
		}
		return outcome;
	} as typeof original;

	try {
		const result = await run();
		return { result, overlapped };
	} finally {
		Client.prototype.query = original;
	}
}

let sequence = 0;

/** Makes every address and block this file writes different from every other one. */
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** A user holding `role` on top of the default `resident` one. */
async function insertUserWithRole(name: string, role: Role): Promise<string> {
	const id = await insertUser(name);
	await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: new Date(START) });
	return id;
}

/** A one-sheet workbook of one importable row, in the header's own column order. */
async function oneRowImportFile(block: string): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Warga');
	const row: readonly CellValue[] = [
		block,
		'1',
		`Warga ${block}`,
		`warga.${block.toLowerCase()}@komplek.id`,
		'pemilik'
	];
	sheet.addRow([...IMPORT_HEADER]);
	sheet.addRow([...row]);
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('no concurrent client query on a transaction or lent client', () => {
	it('composeReportFigures runs its three reads sequentially on a transaction client', async () => {
		const clock = new FakeClock(START);

		const { overlapped } = await detectClientQueryOverlap(() =>
			testDb.db.transaction(async (transaction) => {
				await composeReportFigures(transaction, clock, PERIOD);
			})
		);

		expect(overlapped).toBe(false);
	});

	it('importResidents runs its conflict checks sequentially on its own transaction client', async () => {
		const superuserId = await insertUserWithRole(unique('Pengurus Impor'), ROLE.superuser);
		const clock = new FakeClock(START);
		const content = await oneRowImportFile(unique('Z'));

		const { overlapped, result } = await detectClientQueryOverlap(() =>
			importResidents(testDb.db, clock, {
				actorId: superuserId,
				fileName: 'warga.xlsx',
				content
			})
		);

		expect(overlapped).toBe(false);
		// The import still has to succeed: a probe that only ever saw a refused transaction would
		// prove nothing about the query pattern inside a real one.
		expect(result.importedRowCount).toBe(1);
	});

	it('cashBook keeps its Promise.all over the pool: every query gets its own connection', async () => {
		const adminId = await insertUserWithRole(unique('Pengurus Kas'), ROLE.admin);

		const { overlapped } = await detectClientQueryOverlap(() => cashBook(testDb.db, adminId));

		expect(overlapped).toBe(false);
	});
});
