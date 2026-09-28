import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { auditLog } from '$lib/server/db/schema/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { emailQueue } from '$lib/server/db/schema/email';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { INVOICE_ISSUED_KIND } from '$lib/server/email/templates/invoice-issued';
import type { Clock } from '$lib/server/ports/clock';
import { FakeClock } from '$lib/server/ports/fakes';
import { notifyInvoiceIssued } from '$lib/server/services/dues/notification';
import {
	endOccupancy,
	listAssignableResidents,
	listUnitOccupancies,
	listUnitOccupanciesGrouped,
	occupiedUnitsForUser,
	occupiedUnitsForUserGrouped,
	OccupancyDateOrderError,
	OccupancyEndOverlapError,
	OccupancyNotFoundError,
	OccupancyOverlapError,
	OCCUPANCY_ENDED_ACTION,
	OCCUPANCY_RECORDED_ACTION,
	PRIMARY_OCCUPANT_MARKED_ACTION,
	PrimaryOccupantAlreadyEndedError,
	PrimaryOccupantNotStartedError,
	recordOccupancy,
	ResidentNotFoundError,
	setPrimaryOccupant
} from '$lib/server/services/occupancy';
import {
	getUnit,
	listUnits,
	needsPrimaryOccupant,
	UnitNotFoundError
} from '$lib/server/services/unit';

/**
 * The Masa Huni service: recording a stay, ending one, and moving the Penanggung Jawab flag.
 *
 * `tests/unit/schema-resident-unit.test.ts` already proves what the database refuses on its own.
 * This file proves what the service adds: named refusals instead of raw `SQLSTATE`s, the audit
 * trail, and ADR 0001's model of the flag — it moves, it lands only on a stay running today, and
 * per unit at most one row among the stays that have not passed carries it, including the rows whose
 * last day is written but has not arrived, which the partial index deliberately does not cover.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';
const STARTED_ON = '2026-01-01';
/** A day after `STARTED_ON`, used as an end date that has already passed. */
const ENDED_ON = '2026-03-31';
/** A day well after `ENDED_ON`: an end date written before it arrives. */
const FUTURE_END = '2026-12-31';
/** A day inside the stretch `STARTED_ON`–`FUTURE_END` covers. */
const MID_YEAR = '2026-06-01';

/**
 * The instant every *read* in this file happens at, and therefore the day the reads decide "living
 * here now" against. It sits after `ENDED_ON` and before `FUTURE_END`, so a stay ending on the first
 * really has ended while one ending on the second has not — which is the whole distinction the
 * occupant count and `/my-unit` turn on. Writes that decide nothing about today keep using a clock at
 * `START`, because what they stamp is `createdAt` and the audit row.
 */
const READ_CLOCK = new FakeClock('2026-08-01T12:00:00.000Z');

/**
 * The clock every write that moves the Penanggung Jawab flag reads today from. Moving the flag is a
 * decision about today — its target has to be living here — so those writes happen on the same day
 * the reads look at. `TODAY` is that day in WIB, and `YESTERDAY` and `TOMORROW` the days either side.
 */
const TODAY_CLOCK = READ_CLOCK;
const TODAY = '2026-08-01';
const YESTERDAY = '2026-07-31';
/** The day after `READ_CLOCK`'s: a start date that has been written but has not arrived. */
const TOMORROW = '2026-08-02';

/** How long a call is given to start waiting on a lock before the test gives up on it. */
const WAIT_TIMEOUT_MILLISECONDS = 10_000;
/** How often `waitUntilWaitingOn` asks PostgreSQL again. */
const POLL_MILLISECONDS = 10;

/** Makes every block this file writes different from every other one, across every test. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any real sign-up. */
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

/** A superuser, ready to act as `actorId` in every test that needs one who may manage occupancies. */
async function insertSuperuser(name: string): Promise<string> {
	const id = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId: id, role: ROLE.superuser, createdAt: new Date(START) });
	return id;
}

/** An account together with the `residents` row that points at it. */
async function insertResident(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = await insertUser(name);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return { userId, residentId: row.id };
}

/** A unit row written directly, bypassing the service under test, for building a fixture. */
async function insertUnitRow(block = unique('B')): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block, number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** An occupancy row written directly, for a fixture the service is not what is under test for. */
async function insertOccupancyRow(
	unitId: string,
	residentId: string,
	overrides: Partial<{ startedOn: string; endedOn: string | null; isPrimaryOccupant: boolean }> = {}
): Promise<string> {
	const [row] = await testDb.db
		.insert(occupancies)
		.values({
			unitId,
			residentId,
			role: OCCUPANCY_ROLE.owner,
			startedOn: overrides.startedOn ?? STARTED_ON,
			endedOn: overrides.endedOn ?? null,
			isPrimaryOccupant: overrides.isPrimaryOccupant ?? false,
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/**
 * Runs something that must be refused and hands back how it was refused.
 *
 * The rejection is caught the moment the promise is made, not at the `await` — a test that starts a
 * call, does something else, and only then awaits it would otherwise trip Node's unhandled-rejection
 * warning on the way.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('The service accepted a change it was supposed to refuse.');
}

/** The one occupancy row named by `occupancyId`. */
async function readOccupancy(occupancyId: string) {
	const [row] = await testDb.db.select().from(occupancies).where(eq(occupancies.id, occupancyId));
	return row;
}

/**
 * The ids of the unit's flagged rows whose last day has not passed on `day`, or has not been written
 * — the set ADR 0001's invariant says holds at most one row.
 */
async function flaggedNotPassed(unitId: string, day = TODAY): Promise<readonly string[]> {
	const rows = await testDb.db
		.select({ id: occupancies.id, endedOn: occupancies.endedOn })
		.from(occupancies)
		.where(and(eq(occupancies.unitId, unitId), eq(occupancies.isPrimaryOccupant, true)));
	return rows.filter((row) => row.endedOn === null || row.endedOn >= day).map((row) => row.id);
}

/** Every `PRIMARY_OCCUPANT_MARKED_ACTION` entry about one unit, whichever occupancy it targets. */
async function markedEntriesOf(unitId: string) {
	const rows = await testDb.db
		.select()
		.from(auditLog)
		.where(eq(auditLog.action, PRIMARY_OCCUPANT_MARKED_ACTION));
	return rows.filter((row) => (row.after as { unitId?: string } | null)?.unitId === unitId);
}

/**
 * Who `notifyInvoiceIssued` addresses this unit's invoice email to on `clock`'s day, as an account
 * id, or `undefined` when it finds nobody. Every test account's address is `<user id>@komplek.local`.
 */
async function invoiceRecipient(unitId: string, clock: Clock): Promise<string | undefined> {
	const block = unique('SURAT');
	await notifyInvoiceIssued(testDb.db, clock, {
		unitId,
		block,
		number: '1',
		period: '2026-08',
		amount: rupiah(150_000),
		dueDate: '2026-08-05'
	});
	const rows = await testDb.db
		.select({ recipient: emailQueue.recipient, payload: emailQueue.payload })
		.from(emailQueue)
		.where(eq(emailQueue.kind, INVOICE_ISSUED_KIND));
	const queued = rows.filter((row) => (row.payload as { block?: string }).block === block);
	expect(queued.length).toBeLessThanOrEqual(1);
	return queued[0]?.recipient.replace('@komplek.local', '');
}

/**
 * A second, independent connection into this file's own schema, standing in for a concurrent
 * request with its own transaction.
 */
async function connectToSchema() {
	const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
		options: `-c search_path=${testDb.schemaName}`
	});
	const client = await other.pool.connect();
	const [{ pid }] = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows;
	return {
		client,
		pid,
		release: async () => {
			client.release();
			await other.close();
		}
	};
}

/**
 * Waits until at least `waiters` backends are waiting, directly or down a queue, on a lock the
 * backend `blockerPid` holds. Polled, because PostgreSQL announces no event for a statement starting
 * to wait.
 *
 * "Down a queue" matters as soon as two calls wait for one row: the first waits on the holder, and
 * the second waits on the first — `pg_blocking_pids` names whoever stands directly in its way — so
 * the chain is followed rather than only the holder's own waiters counted. Only this file's own calls
 * can wait on a connection this file opened itself, so the count is theirs alone.
 */
async function waitUntilWaitingOn(blockerPid: number, waiters = 1): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MILLISECONDS;
	while (Date.now() < deadline) {
		const result = await testDb.db.execute<{ waiting: number }>(
			sql`with recursive waiting_on_blocker(pid) as (
				select activity.pid from pg_stat_activity activity
				where ${blockerPid}::int = any(pg_blocking_pids(activity.pid))
				union
				select activity.pid from pg_stat_activity activity
				join waiting_on_blocker behind on behind.pid = any(pg_blocking_pids(activity.pid))
			)
			select count(*)::int as waiting from waiting_on_blocker`
		);
		if ((result.rows[0]?.waiting ?? 0) >= waiters) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
	}
	throw new Error(`Fewer than ${waiters} backends ever waited on backend ${blockerPid}.`);
}

/**
 * The move ADR 0001 describes, written by hand on another connection's open transaction: the unit's
 * row lock, the flag off every row that has not passed, the flag on `targetId`. It stops before
 * `commit`, which is the caller's to send.
 *
 * The unit row is locked `for no key update` rather than the service's `for update`. The two
 * conflict, so a service call still has to wait for this transaction in `lockUnit`; but a foreign-key
 * check on the unit — the `insert` in `recordOccupancy` takes `for key share` on it — does not wait
 * for `for no key update`, where it would for `for update`. That leaves the service's own lock as the
 * only thing that can hold the call back, so a test built on this fails if that lock goes missing
 * rather than passing on the foreign key's account.
 */
async function moveFlagByHand(
	client: Awaited<ReturnType<typeof connectToSchema>>['client'],
	unitId: string,
	targetId: string
): Promise<void> {
	await client.query('begin');
	await client.query('select id from units where id = $1 for no key update', [unitId]);
	await client.query(
		`update occupancies set is_primary_occupant = false
		 where unit_id = $1 and is_primary_occupant and (ended_on is null or ended_on >= $2)`,
		[unitId, TODAY]
	);
	await client.query('update occupancies set is_primary_occupant = true where id = $1', [targetId]);
}

describe('recordOccupancy', () => {
	it('refuses a caller who is not a superuser, and records nothing', async () => {
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Tak Berhak Dicatat');
		const outsiderId = await insertUser('Warga Iseng');

		await expect(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: outsiderId,
				unitId,
				residentId,
				role: OCCUPANCY_ROLE.owner,
				startedOn: STARTED_ON
			})
		).rejects.toThrow(PermissionDeniedError);

		const rows = await testDb.db.select().from(occupancies).where(eq(occupancies.unitId, unitId));
		expect(rows).toHaveLength(0);
	});

	it('records a still-running stay and writes one audit row', async () => {
		const superuserId = await insertSuperuser('Pengurus Pencatat');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Masuk');

		const created = await recordOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId,
			residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: STARTED_ON
		});

		expect(created).toMatchObject({
			unitId,
			residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: STARTED_ON,
			endedOn: null,
			isPrimaryOccupant: false
		});
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: OCCUPANCY_RECORDED_ACTION,
			targetId: created.id,
			after: { unitId, residentId, startedOn: STARTED_ON, isPrimaryOccupant: false }
		});
	});

	it('rejects a start date that is not a calendar day', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanggal Ngawur');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Tanggal Ngawur');

		await expect(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId,
				role: OCCUPANCY_ROLE.owner,
				startedOn: '1 Januari 2026'
			})
		).rejects.toThrow(TypeError);
	});

	it('throws UnitNotFoundError for a unit id that names no house', async () => {
		const superuserId = await insertSuperuser('Pengurus Unit Hilang');
		const { residentId } = await insertResident('Warga Tanpa Rumah');

		await expect(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId: randomUUID(),
				residentId,
				role: OCCUPANCY_ROLE.owner,
				startedOn: STARTED_ON
			})
		).rejects.toThrow(UnitNotFoundError);
	});

	it('throws ResidentNotFoundError for a resident id that names nobody', async () => {
		const superuserId = await insertSuperuser('Pengurus Warga Hilang');
		const unitId = await insertUnitRow();

		await expect(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId: randomUUID(),
				role: OCCUPANCY_ROLE.owner,
				startedOn: STARTED_ON
			})
		).rejects.toThrow(ResidentNotFoundError);
	});

	it('marks the stay as the primary occupant when asked to, recording it and then the move', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Penanggung Jawab');

		const created = await recordOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId,
			residentId,
			role: OCCUPANCY_ROLE.owner,
			startedOn: STARTED_ON,
			isPrimaryOccupant: true
		});

		expect(created.isPrimaryOccupant).toBe(true);
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries.map((entry) => entry.action).sort()).toEqual(
			[OCCUPANCY_RECORDED_ACTION, PRIMARY_OCCUPANT_MARKED_ACTION].sort()
		);
		// Nobody held the flag before, so the move's `before` is empty.
		expect(entries.find((entry) => entry.action === PRIMARY_OCCUPANT_MARKED_ACTION)).toMatchObject({
			before: null,
			after: { occupancyId: created.id, residentId, unitId }
		});
	});

	it('moves the flag onto the new stay while another Penanggung Jawab lives there, who stays', async () => {
		// Under the date-clash model this was refused with "Unit ini sudah punya penanggung jawab pada
		// rentang tanggal itu". ADR 0001 makes ticking the box a move instead.
		const superuserId = await insertSuperuser('Pengurus Catat Sambil Pindah');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Penanggung Jawab Sekarang');
		const newcomer = await insertResident('Warga Penanggung Jawab Baru');
		const holderId = await insertOccupancyRow(unitId, holder.residentId, {
			isPrimaryOccupant: true
		});

		const created = await recordOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			unitId,
			residentId: newcomer.residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		expect(created.isPrimaryOccupant).toBe(true);
		expect(await readOccupancy(holderId)).toMatchObject({
			isPrimaryOccupant: false,
			endedOn: null
		});
		expect(await flaggedNotPassed(unitId)).toEqual([created.id]);
		const entries = await markedEntriesOf(unitId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			targetId: created.id,
			before: { occupancyId: holderId, residentId: holder.residentId },
			after: { occupancyId: created.id, residentId: newcomer.residentId, unitId }
		});
	});

	it('takes the flag off a holder whose last day has not arrived, which the partial index cannot see', async () => {
		// `occupancies_primary_occupant_unique` covers flagged rows with no last day only. A flagged
		// row whose last day is written but still ahead is outside it and inside ADR 0001's invariant,
		// so only the service's move keeps the house at one flag here.
		const superuserId = await insertSuperuser('Pengurus Celah Masa Depan');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Masih Bertanggung Jawab');
		const newcomer = await insertResident('Warga Datang Awal');
		const holderId = await insertOccupancyRow(unitId, holder.residentId, {
			endedOn: FUTURE_END,
			isPrimaryOccupant: true
		});

		const created = await recordOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			unitId,
			residentId: newcomer.residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		expect(await readOccupancy(holderId)).toMatchObject({
			isPrimaryOccupant: false,
			endedOn: FUTURE_END
		});
		expect(await flaggedNotPassed(unitId)).toEqual([created.id]);
	});

	it('accepts the next primary occupant once the previous one’s days are over, and leaves that finished stay alone', async () => {
		// A flag on a stay whose last day has passed names nobody and is not cleared: nothing reads it,
		// and the spec leaves those flags where they are. The move therefore has no previous holder.
		const superuserId = await insertSuperuser('Pengurus Pergantian');
		const unitId = await insertUnitRow();
		const leaving = await insertResident('Warga Pergi');
		const arriving = await insertResident('Warga Datang');
		const leavingId = await insertOccupancyRow(unitId, leaving.residentId, {
			endedOn: ENDED_ON,
			isPrimaryOccupant: true
		});

		const created = await recordOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			unitId,
			residentId: arriving.residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		expect(created.isPrimaryOccupant).toBe(true);
		expect((await readOccupancy(leavingId)).isPrimaryOccupant).toBe(true);
		expect(await markedEntriesOf(unitId)).toEqual([
			expect.objectContaining({ before: null, after: expect.objectContaining({ unitId }) })
		]);
	});

	it('hands the house over on one day: the last day of A is today, F starts today, and the invoice email goes to F', async () => {
		const superuserId = await insertSuperuser('Pengurus Serah Terima');
		const unitId = await insertUnitRow();
		const a = await insertResident('Warga A Pindah Hari Ini');
		const f = await insertResident('Warga F Masuk Hari Ini');
		const aId = await insertOccupancyRow(unitId, a.residentId, { isPrimaryOccupant: true });

		await endOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId: aId,
			endedOn: TODAY
		});
		// Ending leaves the flag where it is: A is still living here today, and still the recipient.
		expect(await readOccupancy(aId)).toMatchObject({ endedOn: TODAY, isPrimaryOccupant: true });
		expect(await invoiceRecipient(unitId, TODAY_CLOCK)).toBe(a.userId);

		const created = await recordOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			unitId,
			residentId: f.residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: TODAY,
			isPrimaryOccupant: true
		});

		expect(await invoiceRecipient(unitId, TODAY_CLOCK)).toBe(f.userId);
		const history = await listUnitOccupancies(testDb.db, TODAY_CLOCK, superuserId, unitId);
		expect(history.find((row) => row.occupancyId === aId)).toMatchObject({
			isRunning: true,
			isPrimaryOccupant: false
		});
		expect(await markedEntriesOf(unitId)).toEqual([
			expect.objectContaining({
				before: { occupancyId: aId, residentId: a.residentId },
				after: { occupancyId: created.id, residentId: f.residentId, unitId }
			})
		]);
	});

	it('refuses to record a stay starting tomorrow with the box ticked, naming its start date, and records nothing', async () => {
		const superuserId = await insertSuperuser('Pengurus Centang Kecepatan');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Tetap Penanggung Jawab');
		const early = await insertResident('Warga Belum Masuk Dicentang');
		const holderId = await insertOccupancyRow(unitId, holder.residentId, {
			isPrimaryOccupant: true
		});

		const refusal = await rejection(
			recordOccupancy(testDb.db, TODAY_CLOCK, {
				actorId: superuserId,
				unitId,
				residentId: early.residentId,
				role: OCCUPANCY_ROLE.tenant,
				startedOn: TOMORROW,
				isPrimaryOccupant: true
			})
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantNotStartedError);
		expect(refusal).toMatchObject({ startedOn: TOMORROW });
		const rows = await testDb.db
			.select()
			.from(occupancies)
			.where(eq(occupancies.residentId, early.residentId));
		expect(rows).toHaveLength(0);
		expect(await flaggedNotPassed(unitId)).toEqual([holderId]);
		expect(await markedEntriesOf(unitId)).toEqual([]);
	});

	it('still records a stay starting tomorrow when the box is not ticked', async () => {
		const superuserId = await insertSuperuser('Pengurus Catat Besok');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Masuk Besok Tanpa Centang');

		const created = await recordOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			unitId,
			residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: TOMORROW
		});

		expect(created).toMatchObject({ startedOn: TOMORROW, isPrimaryOccupant: false });
	});

	it('takes the flag off a holder another connection marked mid-flight, leaving exactly one', async () => {
		// The second connection moves the flag to B by hand, exactly as the service would, and holds
		// its transaction open. B's last day is written but still ahead, so the partial index cannot
		// see B at all: if this record read the unit before B's commit, B would keep its flag beside
		// the new one and nothing in the database would object. The test waits until PostgreSQL
		// reports the call blocked on the unit lock before it commits, so the call provably ran its
		// move after that commit and not before it.
		const superuserId = await insertSuperuser('Pengurus Adu Cepat');
		const unitId = await insertUnitRow();
		const a = await insertResident('Warga Pemegang Awal');
		const b = await insertResident('Warga Menang Cepat');
		const c = await insertResident('Warga Dicatat Belakangan');
		await insertOccupancyRow(unitId, a.residentId, { isPrimaryOccupant: true });
		const bId = await insertOccupancyRow(unitId, b.residentId, { endedOn: FUTURE_END });

		const other = await connectToSchema();
		try {
			await moveFlagByHand(other.client, unitId, bId);

			const recorded = recordOccupancy(testDb.db, TODAY_CLOCK, {
				actorId: superuserId,
				unitId,
				residentId: c.residentId,
				role: OCCUPANCY_ROLE.tenant,
				startedOn: MID_YEAR,
				isPrimaryOccupant: true
			});
			await waitUntilWaitingOn(other.pid);
			await other.client.query('commit');
			const created = await recorded;

			expect(await flaggedNotPassed(unitId)).toEqual([created.id]);
			expect(await markedEntriesOf(unitId)).toEqual([
				expect.objectContaining({
					before: { occupancyId: bId, residentId: b.residentId },
					after: { occupancyId: created.id, residentId: c.residentId, unitId }
				})
			]);
		} finally {
			await other.release();
		}
	});

	it('refuses a second stay that overlaps the first only at the boundary day, naming the day after', async () => {
		const superuserId = await insertSuperuser('Pengurus Tumpang Tindih');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Bersinggungan');
		await insertOccupancyRow(unitId, residentId, { startedOn: STARTED_ON, endedOn: ENDED_ON });

		const refusal = await rejection(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId,
				role: OCCUPANCY_ROLE.tenant,
				startedOn: ENDED_ON
			})
		);

		expect(refusal).toBeInstanceOf(OccupancyOverlapError);
		expect(refusal).toMatchObject({ earliestStartedOn: '2026-04-01', mustEndFirst: false });
		expect(
			await testDb.db.select().from(occupancies).where(eq(occupancies.residentId, residentId))
		).toHaveLength(1);
	});

	it('accepts a stay starting the day after the conflicting stay’s last day', async () => {
		const superuserId = await insertSuperuser('Pengurus Sambung Hari');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Lanjut');
		await insertOccupancyRow(unitId, residentId, { startedOn: STARTED_ON, endedOn: ENDED_ON });

		const created = await recordOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId,
			residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: '2026-04-01'
		});

		expect(created.startedOn).toBe('2026-04-01');
	});

	it('refuses to overlap a stay with no last day yet, naming that it must be ended first', async () => {
		const superuserId = await insertSuperuser('Pengurus Belum Berakhir');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Belum Diakhiri');
		await insertOccupancyRow(unitId, residentId, { startedOn: STARTED_ON, endedOn: null });

		const refusal = await rejection(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId,
				role: OCCUPANCY_ROLE.tenant,
				startedOn: MID_YEAR
			})
		);

		expect(refusal).toBeInstanceOf(OccupancyOverlapError);
		expect(refusal).toMatchObject({ earliestStartedOn: undefined, mustEndFirst: true });
	});

	it('accepts the same resident recorded again in a different unit', async () => {
		const superuserId = await insertSuperuser('Pengurus Dua Unit');
		const unitOne = await insertUnitRow();
		const unitTwo = await insertUnitRow();
		const { residentId } = await insertResident('Warga Dua Rumah');
		await insertOccupancyRow(unitOne, residentId, { startedOn: STARTED_ON, endedOn: null });

		const created = await recordOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId: unitTwo,
			residentId,
			role: OCCUPANCY_ROLE.owner,
			startedOn: STARTED_ON
		});

		expect(created.unitId).toBe(unitTwo);
	});

	it('refuses a recording that would overlap a row another connection committed while it waited on the lock', async () => {
		// Two real requests to record the same resident and unit must not both succeed. The other
		// connection takes the unit's row lock `for update` — the same mode `lockUnit` itself takes —
		// and inserts a stay for the resident while the service call waits behind it, then commits.
		// Read committed gives the service call's own overlap check a snapshot taken after the lock was
		// granted, so it is provably reading the committed row and not a stale "no conflict" answer.
		const superuserId = await insertSuperuser('Pengurus Kunci Rebutan');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Direbutkan');

		const other = await connectToSchema();
		try {
			await other.client.query('begin');
			await other.client.query('select id from units where id = $1 for update', [unitId]);

			const recorded = recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId,
				role: OCCUPANCY_ROLE.owner,
				startedOn: STARTED_ON
			});
			await waitUntilWaitingOn(other.pid);

			await other.client.query(
				`insert into occupancies (unit_id, resident_id, role, started_on, ended_on, is_primary_occupant, created_at)
				 values ($1, $2, 'owner', $3, null, false, $4)`,
				[unitId, residentId, STARTED_ON, START]
			);
			await other.client.query('commit');

			const refusal = await rejection(recorded);

			expect(refusal).toBeInstanceOf(OccupancyOverlapError);
			expect(refusal).toMatchObject({ mustEndFirst: true });
			expect(
				await testDb.db.select().from(occupancies).where(eq(occupancies.residentId, residentId))
			).toHaveLength(1);
		} finally {
			await other.release();
		}
	});
});

describe('endOccupancy', () => {
	it('ends a running stay and records the change', async () => {
		const superuserId = await insertSuperuser('Pengurus Pengakhir');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Keluar');
		const occupancyId = await insertOccupancyRow(unitId, residentId);

		const ended = await endOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId,
			endedOn: ENDED_ON
		});

		expect(ended.endedOn).toBe(ENDED_ON);
		const entries = await auditEntriesFor(testDb.db, occupancyId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: OCCUPANCY_ENDED_ACTION,
			targetId: occupancyId,
			before: { endedOn: null },
			after: { endedOn: ENDED_ON }
		});
	});

	it('refuses an end date earlier than the start date, and leaves the stay running', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanggal Terbalik');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Tanggal Terbalik');
		const occupancyId = await insertOccupancyRow(unitId, residentId);

		const refusal = await rejection(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId,
				endedOn: '2025-12-31'
			})
		);

		expect(refusal).toBeInstanceOf(OccupancyDateOrderError);
		expect(refusal).toMatchObject({ startedOn: STARTED_ON, endedOn: '2025-12-31' });
		expect((await readOccupancy(occupancyId)).endedOn).toBeNull();
	});

	it('accepts an end date on the start date, because the rule is earlier, not different', async () => {
		const superuserId = await insertSuperuser('Pengurus Sehari');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Sehari');
		const occupancyId = await insertOccupancyRow(unitId, residentId);

		const ended = await endOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId,
			endedOn: STARTED_ON
		});

		expect(ended.endedOn).toBe(STARTED_ON);
	});

	it('is a no-op, with no audit row, when the stay already ends on that day', async () => {
		const superuserId = await insertSuperuser('Pengurus Akhiri Ulang');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Sudah Keluar');
		const occupancyId = await insertOccupancyRow(unitId, residentId, { endedOn: ENDED_ON });

		await endOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId,
			endedOn: ENDED_ON
		});

		expect(await auditEntriesFor(testDb.db, occupancyId)).toHaveLength(0);
	});

	it('moves a finished Penanggung Jawab’s last day later without a clash check, and drops the stale flag', async () => {
		// Under the date-clash model this was refused, because the corrected stay would overlap the
		// next Penanggung Jawab's. ADR 0001 took that check out of ending. The corrected stay comes
		// back among the ones that have not passed, and its dead flag must not come back with it: that
		// would make two flags in the house, and change the invoice recipient with no move and no
		// marked entry. The flag goes, and the audit entry says so.
		const superuserId = await insertSuperuser('Pengurus Perpanjang');
		const unitId = await insertUnitRow();
		const leaving = await insertResident('Warga Pergi Lalu Kembali');
		const arriving = await insertResident('Warga Sudah Menempati');
		const leavingId = await insertOccupancyRow(unitId, leaving.residentId, {
			endedOn: ENDED_ON,
			isPrimaryOccupant: true
		});
		const arrivingId = await insertOccupancyRow(unitId, arriving.residentId, {
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		const ended = await endOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId: leavingId,
			endedOn: FUTURE_END
		});

		expect(ended).toMatchObject({ endedOn: FUTURE_END, isPrimaryOccupant: false });
		expect(await flaggedNotPassed(unitId)).toEqual([arrivingId]);
		expect(await invoiceRecipient(unitId, TODAY_CLOCK)).toBe(arriving.userId);
		expect(await auditEntriesFor(testDb.db, leavingId)).toEqual([
			expect.objectContaining({
				action: OCCUPANCY_ENDED_ACTION,
				before: { endedOn: ENDED_ON, isPrimaryOccupant: true },
				after: { endedOn: FUTURE_END, isPrimaryOccupant: false }
			})
		]);
	});

	it('leaves the flag on a Penanggung Jawab whose stay it ends, living there or not', async () => {
		const superuserId = await insertSuperuser('Pengurus Akhiri Penanggung Jawab');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Penanggung Jawab Diakhiri');
		const occupancyId = await insertOccupancyRow(unitId, residentId, { isPrimaryOccupant: true });

		const today = await endOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId,
			endedOn: TODAY
		});
		const earlier = await endOccupancy(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId,
			endedOn: YESTERDAY
		});

		expect(today.isPrimaryOccupant).toBe(true);
		expect(earlier.isPrimaryOccupant).toBe(true);
		expect(await markedEntriesOf(unitId)).toEqual([]);
	});

	it('throws OccupancyNotFoundError for an id that names no stay', async () => {
		const superuserId = await insertSuperuser('Pengurus Masa Huni Hilang');

		await expect(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId: randomUUID(),
				endedOn: ENDED_ON
			})
		).rejects.toThrow(OccupancyNotFoundError);
	});

	it('refuses a caller who is not a superuser', async () => {
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Coba Akhiri');
		const occupancyId = await insertOccupancyRow(unitId, residentId);

		await expect(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: await insertUser('Warga Bukan Pengurus'),
				occupancyId,
				endedOn: ENDED_ON
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	it('leaves the unit with no primary occupant once the last day has passed, and the admin list says so', async () => {
		const superuserId = await insertSuperuser('Pengurus Tinggalkan Kosong');
		const block = unique('KOSONG');
		const unitId = await insertUnitRow(block);
		const { residentId } = await insertResident('Warga Penanggung Jawab Pergi');
		const occupancyId = await insertOccupancyRow(unitId, residentId, { isPrimaryOccupant: true });

		await endOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId,
			endedOn: ENDED_ON
		});

		const page = await listUnits(testDb.db, READ_CLOCK, { actorId: superuserId, search: block });
		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ primaryOccupantNeed: { kind: 'missing' }, activeOccupantCount: 0 });
		expect(row && needsPrimaryOccupant(row)).toBe(true);
	});

	// #258: the fifth path decision 6 was extended to. The story from the ticket's own "Temuan": a
	// stay is ended, the same resident is recorded again in the same unit starting the day after, and
	// then the first stay's last day is pushed forward until it reaches the second — which must be
	// refused the same way a fresh, overlapping recording would have been.
	it('refuses a last day that reaches a later stay of the same resident in the same unit, naming the day before it', async () => {
		const superuserId = await insertSuperuser('Pengurus Hari Terakhir Bersinggungan');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Budi Santoso');
		const firstId = await insertOccupancyRow(unitId, residentId, {
			startedOn: STARTED_ON,
			endedOn: '2026-10-31'
		});
		await insertOccupancyRow(unitId, residentId, { startedOn: '2026-11-01', endedOn: null });

		const refusal = await rejection(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId: firstId,
				endedOn: '2026-12-31'
			})
		);

		expect(refusal).toBeInstanceOf(OccupancyEndOverlapError);
		expect(refusal).toMatchObject({ latestEndedOn: '2026-10-31', nextStartedOn: '2026-11-01' });
		expect((await readOccupancy(firstId)).endedOn).toBe('2026-10-31');
		expect(await auditEntriesFor(testDb.db, firstId)).toHaveLength(0);
	});

	it('refuses a last day landing exactly on the later stay’s first day, the boundary being inclusive', async () => {
		const superuserId = await insertSuperuser('Pengurus Batas Inklusif');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Batas Sehari');
		const firstId = await insertOccupancyRow(unitId, residentId, {
			startedOn: STARTED_ON,
			endedOn: '2026-10-31'
		});
		await insertOccupancyRow(unitId, residentId, { startedOn: '2026-11-01', endedOn: null });

		const refusal = await rejection(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId: firstId,
				endedOn: '2026-11-01'
			})
		);

		expect(refusal).toBeInstanceOf(OccupancyEndOverlapError);
		expect(refusal).toMatchObject({ latestEndedOn: '2026-10-31', nextStartedOn: '2026-11-01' });
	});

	it('accepts a last day the day before the later stay begins', async () => {
		const superuserId = await insertSuperuser('Pengurus Sehari Sebelum');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Sehari Sebelum Lanjut');
		const firstId = await insertOccupancyRow(unitId, residentId, {
			startedOn: STARTED_ON,
			endedOn: '2026-09-30'
		});
		await insertOccupancyRow(unitId, residentId, { startedOn: '2026-11-01', endedOn: null });

		const ended = await endOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId: firstId,
			endedOn: '2026-10-31'
		});

		expect(ended.endedOn).toBe('2026-10-31');
		const entries = await auditEntriesFor(testDb.db, firstId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: OCCUPANCY_ENDED_ACTION,
			before: { endedOn: '2026-09-30' },
			after: { endedOn: '2026-10-31' }
		});
	});

	it('is not blocked by the same resident’s stay in a different unit, or another resident’s stay in the same unit', async () => {
		const superuserId = await insertSuperuser('Pengurus Tak Terhalang');
		const unitId = await insertUnitRow();
		const otherUnitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Dua Unit Tak Terhalang');
		const { residentId: otherResidentId } = await insertResident('Warga Lain Serumah');

		const firstId = await insertOccupancyRow(unitId, residentId, {
			startedOn: STARTED_ON,
			endedOn: '2026-09-30'
		});
		// A later stay of the same resident, but in a different unit — must not block.
		await insertOccupancyRow(otherUnitId, residentId, { startedOn: '2026-11-01', endedOn: null });
		// A later stay in the same unit, but of a different resident — must not block either.
		await insertOccupancyRow(unitId, otherResidentId, { startedOn: '2026-11-01', endedOn: null });

		const ended = await endOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId: firstId,
			endedOn: '2026-12-31'
		});

		expect(ended.endedOn).toBe('2026-12-31');
	});

	it('names the earliest of two later stays when both would be reached', async () => {
		const superuserId = await insertSuperuser('Pengurus Dua Masa Huni Berikutnya');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Dua Kali Kembali');
		const firstId = await insertOccupancyRow(unitId, residentId, {
			startedOn: STARTED_ON,
			endedOn: '2026-10-31'
		});
		await insertOccupancyRow(unitId, residentId, {
			startedOn: '2026-11-01',
			endedOn: '2026-11-30'
		});
		await insertOccupancyRow(unitId, residentId, { startedOn: '2026-12-01', endedOn: null });

		const refusal = await rejection(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId: firstId,
				endedOn: '2026-12-15'
			})
		);

		expect(refusal).toBeInstanceOf(OccupancyEndOverlapError);
		expect(refusal).toMatchObject({ latestEndedOn: '2026-10-31', nextStartedOn: '2026-11-01' });
	});
});

describe('setPrimaryOccupant', () => {
	it('marks a running stay and records the move, with nobody before it', async () => {
		const superuserId = await insertSuperuser('Pengurus Tandai');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Ditandai');
		const occupancyId = await insertOccupancyRow(unitId, residentId);

		const marked = await setPrimaryOccupant(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId
		});

		expect(marked.isPrimaryOccupant).toBe(true);
		const entries = await auditEntriesFor(testDb.db, occupancyId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: PRIMARY_OCCUPANT_MARKED_ACTION,
			before: null,
			after: { occupancyId, residentId, unitId }
		});
	});

	it('is a no-op, with no audit row, when the stay already carries the flag', async () => {
		const superuserId = await insertSuperuser('Pengurus Tandai Ulang');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Sudah Ditandai');
		const housemate = await insertResident('Warga Serumah Tak Tersentuh');
		const occupancyId = await insertOccupancyRow(unitId, residentId, { isPrimaryOccupant: true });
		const housemateId = await insertOccupancyRow(unitId, housemate.residentId);

		const result = await setPrimaryOccupant(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId
		});

		expect(result.isPrimaryOccupant).toBe(true);
		expect((await readOccupancy(housemateId)).isPrimaryOccupant).toBe(false);
		expect(await auditEntriesFor(testDb.db, occupancyId)).toHaveLength(0);
		expect(await markedEntriesOf(unitId)).toEqual([]);
	});

	it('makes a housemate the Penanggung Jawab, and the previous holder keeps living there unflagged', async () => {
		// The case the date-clash model made impossible: this used to be refused with
		// PrimaryOccupantConflictError naming the husband, on any date, because the wife's stay
		// always overlapped his past. ADR 0001 exists for it.
		const superuserId = await insertSuperuser('Pengurus Tandai Kedua');
		const unitId = await insertUnitRow();
		const husband = await insertResident('Warga Suami');
		const wife = await insertResident('Warga Istri');
		const husbandId = await insertOccupancyRow(unitId, husband.residentId, {
			isPrimaryOccupant: true
		});
		const wifeId = await insertOccupancyRow(unitId, wife.residentId);
		const before = await getUnit(testDb.db, superuserId, unitId, TODAY_CLOCK);

		const marked = await setPrimaryOccupant(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId: wifeId
		});

		expect(marked.isPrimaryOccupant).toBe(true);
		expect(await readOccupancy(husbandId)).toMatchObject({
			isPrimaryOccupant: false,
			endedOn: null
		});
		expect(await flaggedNotPassed(unitId)).toEqual([wifeId]);
		expect(await invoiceRecipient(unitId, TODAY_CLOCK)).toBe(wife.userId);
		const after = await getUnit(testDb.db, superuserId, unitId, TODAY_CLOCK);
		expect(after.activeOccupantCount).toBe(before.activeOccupantCount);
		expect(after.activeOccupants).toEqual([
			{ residentId: wife.residentId, name: 'Warga Istri', isPrimaryOccupant: true },
			{ residentId: husband.residentId, name: 'Warga Suami', isPrimaryOccupant: false }
		]);
	});

	it('moves the flag back to a holder whose last day is today', async () => {
		const superuserId = await insertSuperuser('Pengurus Kembalikan');
		const unitId = await insertUnitRow();
		const a = await insertResident('Warga Hari Terakhir Dikembalikan');
		const f = await insertResident('Warga Pemegang Sementara');
		const aId = await insertOccupancyRow(unitId, a.residentId, { endedOn: TODAY });
		const fId = await insertOccupancyRow(unitId, f.residentId, {
			startedOn: TODAY,
			isPrimaryOccupant: true
		});

		await setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId: aId });

		expect(await flaggedNotPassed(unitId)).toEqual([aId]);
		expect((await readOccupancy(fId)).isPrimaryOccupant).toBe(false);
		const unit = await getUnit(testDb.db, superuserId, unitId, TODAY_CLOCK);
		expect(unit.primaryOccupantNeed).toEqual({
			kind: 'leaving',
			residentId: a.residentId,
			name: 'Warga Hari Terakhir Dikembalikan',
			endedOn: TODAY
		});
	});

	it('refuses a stay that starts tomorrow, naming its start date, and moves nothing', async () => {
		const superuserId = await insertSuperuser('Pengurus Tandai Terlalu Awal');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Pemegang Bertahan');
		const early = await insertResident('Warga Mulai Besok');
		const holderId = await insertOccupancyRow(unitId, holder.residentId, {
			isPrimaryOccupant: true
		});
		const earlyId = await insertOccupancyRow(unitId, early.residentId, { startedOn: TOMORROW });

		const refusal = await rejection(
			setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId: earlyId })
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantNotStartedError);
		expect(refusal).toMatchObject({ startedOn: TOMORROW });
		expect(await flaggedNotPassed(unitId)).toEqual([holderId]);
		expect(await markedEntriesOf(unitId)).toEqual([]);
	});

	it('refuses a stay whose last day has passed', async () => {
		const superuserId = await insertSuperuser('Pengurus Tandai Terlambat');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Pergi Kemarin');
		const occupancyId = await insertOccupancyRow(unitId, residentId, { endedOn: YESTERDAY });

		const refusal = await rejection(
			setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId })
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantAlreadyEndedError);
		expect(refusal).toMatchObject({ endedOn: YESTERDAY });
		expect((await readOccupancy(occupancyId)).isPrimaryOccupant).toBe(false);
	});

	it('takes the flag off every stay that has not passed, one flagged ahead of time included', async () => {
		// The date-clash model let a stay be flagged before it began, as long as the days did not
		// overlap the current holder's. Such a row is in ADR 0001's set — its last day has not passed —
		// so a move clears it too. The entry names the holder the invoices were going to today.
		const superuserId = await insertSuperuser('Pengurus Bersihkan Penanda Lama');
		const unitId = await insertUnitRow();
		const current = await insertResident('Warga Pemegang Sampai Akhir Tahun');
		const upcoming = await insertResident('Warga Ditandai Sebelum Masuk');
		const housemate = await insertResident('Warga Serumah Penerima Baru');
		const currentId = await insertOccupancyRow(unitId, current.residentId, {
			endedOn: FUTURE_END,
			isPrimaryOccupant: true
		});
		const upcomingId = await insertOccupancyRow(unitId, upcoming.residentId, {
			startedOn: '2027-01-01',
			isPrimaryOccupant: true
		});
		const housemateId = await insertOccupancyRow(unitId, housemate.residentId);

		await setPrimaryOccupant(testDb.db, TODAY_CLOCK, {
			actorId: superuserId,
			occupancyId: housemateId
		});

		expect(await flaggedNotPassed(unitId)).toEqual([housemateId]);
		expect((await readOccupancy(upcomingId)).isPrimaryOccupant).toBe(false);
		expect(await markedEntriesOf(unitId)).toEqual([
			expect.objectContaining({
				before: { occupancyId: currentId, residentId: current.residentId },
				after: { occupancyId: housemateId, residentId: housemate.residentId, unitId }
			})
		]);
	});

	it('writes exactly one marked entry per move, naming the previous and the new holder', async () => {
		const superuserId = await insertSuperuser('Pengurus Pindah Bolak Balik');
		const unitId = await insertUnitRow();
		const a = await insertResident('Warga Bolak');
		const b = await insertResident('Warga Balik');
		const aId = await insertOccupancyRow(unitId, a.residentId, { isPrimaryOccupant: true });
		const bId = await insertOccupancyRow(unitId, b.residentId, { endedOn: FUTURE_END });

		await setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId: bId });
		await setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId: aId });

		const entries = await markedEntriesOf(unitId);
		expect(entries).toHaveLength(2);
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetId: bId,
					before: { occupancyId: aId, residentId: a.residentId },
					after: { occupancyId: bId, residentId: b.residentId, unitId }
				}),
				expect.objectContaining({
					targetId: aId,
					before: { occupancyId: bId, residentId: b.residentId },
					after: { occupancyId: aId, residentId: a.residentId, unitId }
				})
			])
		);
		expect(await flaggedNotPassed(unitId)).toEqual([aId]);
	});

	it('leaves exactly one flag when two moves on the same unit come from two connections', async () => {
		// The concurrency argument in `src/lib/server/services/occupancy/index.ts`, proved. The second
		// connection moves the flag from A to B by hand and holds its transaction open; B's last day
		// is written but still ahead, so the partial index cannot see B. The service's move to C is
		// then started, and the test waits until PostgreSQL reports it blocked on the unit lock the
		// other connection holds before committing. Behind that lock, C's move reads B's committed
		// flag and takes it off, so one flag is left and the audit entry names B, not A.
		const superuserId = await insertSuperuser('Pengurus Dua Koneksi');
		const unitId = await insertUnitRow();
		const a = await insertResident('Warga Pemegang Lama Dua Koneksi');
		const b = await insertResident('Warga Koneksi Kedua');
		const c = await insertResident('Warga Koneksi Pertama');
		await insertOccupancyRow(unitId, a.residentId, { isPrimaryOccupant: true });
		const bId = await insertOccupancyRow(unitId, b.residentId, { endedOn: FUTURE_END });
		const cId = await insertOccupancyRow(unitId, c.residentId);

		const other = await connectToSchema();
		try {
			await moveFlagByHand(other.client, unitId, bId);

			const moved = setPrimaryOccupant(testDb.db, TODAY_CLOCK, {
				actorId: superuserId,
				occupancyId: cId
			});
			await waitUntilWaitingOn(other.pid);
			await other.client.query('commit');
			await moved;

			expect(await flaggedNotPassed(unitId)).toEqual([cId]);
			expect(await markedEntriesOf(unitId)).toEqual([
				expect.objectContaining({
					before: { occupancyId: bId, residentId: b.residentId },
					after: { occupancyId: cId, residentId: c.residentId, unitId }
				})
			]);
		} finally {
			await other.release();
		}
	});

	it('serialises two service moves waiting on the same unit lock, one after the other', async () => {
		// Both moves go through the service here. A third connection holds the unit lock until both
		// are provably waiting on it, then lets go: whichever is granted the lock first moves the flag,
		// and the other then moves it again from that holder, never from A.
		const superuserId = await insertSuperuser('Pengurus Dua Pindahan');
		const unitId = await insertUnitRow();
		const a = await insertResident('Warga Pemegang Semula');
		const b = await insertResident('Warga Calon Satu');
		const c = await insertResident('Warga Calon Dua');
		const aId = await insertOccupancyRow(unitId, a.residentId, { isPrimaryOccupant: true });
		const bId = await insertOccupancyRow(unitId, b.residentId, { endedOn: FUTURE_END });
		const cId = await insertOccupancyRow(unitId, c.residentId, { endedOn: FUTURE_END });

		const other = await connectToSchema();
		try {
			await other.client.query('begin');
			await other.client.query('select id from units where id = $1 for update', [unitId]);

			const moves = Promise.all([
				setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId: bId }),
				setPrimaryOccupant(testDb.db, TODAY_CLOCK, { actorId: superuserId, occupancyId: cId })
			]);
			await waitUntilWaitingOn(other.pid, 2);
			await other.client.query('commit');
			await moves;

			const flagged = await flaggedNotPassed(unitId);
			expect(flagged).toHaveLength(1);
			const [last] = flagged;
			const first = last === bId ? cId : bId;
			const entries = await markedEntriesOf(unitId);
			expect(entries).toHaveLength(2);
			expect(entries.find((entry) => entry.targetId === first)).toMatchObject({
				before: { occupancyId: aId }
			});
			expect(entries.find((entry) => entry.targetId === last)).toMatchObject({
				before: { occupancyId: first }
			});
		} finally {
			await other.release();
		}
	});

	it('refuses a caller who is not a superuser', async () => {
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Coba Tandai');
		const occupancyId = await insertOccupancyRow(unitId, residentId);

		await expect(
			setPrimaryOccupant(testDb.db, new FakeClock(START), {
				actorId: await insertUser('Warga Bukan Pengurus Lagi'),
				occupancyId
			})
		).rejects.toThrow(PermissionDeniedError);
	});
});

describe('listUnitOccupancies', () => {
	it('refuses a caller who is not a superuser', async () => {
		const unitId = await insertUnitRow();

		await expect(
			listUnitOccupancies(testDb.db, READ_CLOCK, await insertUser('Warga Pengintip'), unitId)
		).rejects.toThrow(PermissionDeniedError);
	});

	it('returns the whole history of one unit, newest stay first, with each occupant named', async () => {
		const superuserId = await insertSuperuser('Pengurus Riwayat');
		const unitId = await insertUnitRow();
		const otherUnitId = await insertUnitRow();
		const earlier = await insertResident('Warga Lama');
		const later = await insertResident('Warga Baru');
		const stranger = await insertResident('Warga Rumah Lain');
		await insertOccupancyRow(unitId, earlier.residentId, { endedOn: ENDED_ON });
		await insertOccupancyRow(unitId, later.residentId, { startedOn: MID_YEAR });
		await insertOccupancyRow(otherUnitId, stranger.residentId);

		const history = await listUnitOccupancies(testDb.db, READ_CLOCK, superuserId, unitId);

		expect(history.map((row) => row.residentName)).toEqual(['Warga Baru', 'Warga Lama']);
		expect(history[0]).toMatchObject({ unitId, startedOn: MID_YEAR, endedOn: null });
	});

	it('marks a stay whose end date has not arrived as still running, and a past one as not', async () => {
		const superuserId = await insertSuperuser('Pengurus Riwayat Berjalan');
		const unitId = await insertUnitRow();
		const leavingNextYear = await insertResident('Warga Akan Pergi');
		const alreadyGone = await insertResident('Warga Sudah Pergi Lama');
		await insertOccupancyRow(unitId, leavingNextYear.residentId, { endedOn: FUTURE_END });
		await insertOccupancyRow(unitId, alreadyGone.residentId, {
			startedOn: '2025-01-01',
			endedOn: ENDED_ON
		});

		const history = await listUnitOccupancies(testDb.db, READ_CLOCK, superuserId, unitId);

		expect(history.map((row) => [row.residentName, row.isRunning])).toEqual([
			['Warga Akan Pergi', true],
			['Warga Sudah Pergi Lama', false]
		]);
	});

	it('does not mark a stay that starts tomorrow as running', async () => {
		const superuserId = await insertSuperuser('Pengurus Riwayat Belum Mulai');
		const unitId = await insertUnitRow();
		const arriving = await insertResident('Warga Masuk Besok');
		await insertOccupancyRow(unitId, arriving.residentId, { startedOn: TOMORROW });

		const history = await listUnitOccupancies(testDb.db, READ_CLOCK, superuserId, unitId);

		expect(history.map((row) => [row.residentName, row.isRunning])).toEqual([
			['Warga Masuk Besok', false]
		]);
	});
});

describe('listUnitOccupanciesGrouped', () => {
	it('refuses a caller who is not a superuser', async () => {
		const unitId = await insertUnitRow();

		await expect(
			listUnitOccupanciesGrouped(testDb.db, READ_CLOCK, await insertUser('Warga Pengintip'), unitId)
		).rejects.toThrow(PermissionDeniedError);
	});

	it('splits one unit into current, upcoming and history, with each occupant named', async () => {
		const superuserId = await insertSuperuser('Pengurus Riwayat Kelompok');
		const unitId = await insertUnitRow();
		const otherUnitId = await insertUnitRow();
		const running = await insertResident('Warga Baru Kelompok');
		const ended = await insertResident('Warga Lama Kelompok');
		const stranger = await insertResident('Warga Rumah Lain Kelompok');
		await insertOccupancyRow(unitId, ended.residentId, { endedOn: ENDED_ON });
		await insertOccupancyRow(unitId, running.residentId, { startedOn: MID_YEAR });
		await insertOccupancyRow(otherUnitId, stranger.residentId);

		const groups = await listUnitOccupanciesGrouped(testDb.db, READ_CLOCK, superuserId, unitId);

		expect(groups.current.map((row) => row.residentName)).toEqual(['Warga Baru Kelompok']);
		expect(groups.upcoming).toEqual([]);
		expect(groups.history.map((row) => row.residentName)).toEqual(['Warga Lama Kelompok']);
		expect(groups.current[0]).toMatchObject({ unitId, startedOn: MID_YEAR, endedOn: null });
	});

	it('sorts every start-date boundary into current or upcoming, and every end-date boundary into current or history', async () => {
		// Batas wajib per acceptance criteria #245: tanggal mulai kemarin/hari ini/besok, dan hari
		// terakhir kemarin/hari ini/besok.
		const superuserId = await insertSuperuser('Pengurus Batas Tanggal');
		const unitId = await insertUnitRow();
		const startedYesterday = await insertResident('Warga Mulai Kemarin');
		const startedToday = await insertResident('Warga Mulai Hari Ini');
		const startedTomorrow = await insertResident('Warga Mulai Besok');
		const endedYesterday = await insertResident('Warga Selesai Kemarin');
		const endedToday = await insertResident('Warga Selesai Hari Ini');
		const endedTomorrow = await insertResident('Warga Selesai Besok');
		await insertOccupancyRow(unitId, startedYesterday.residentId, { startedOn: YESTERDAY });
		await insertOccupancyRow(unitId, startedToday.residentId, { startedOn: TODAY });
		await insertOccupancyRow(unitId, startedTomorrow.residentId, { startedOn: TOMORROW });
		await insertOccupancyRow(unitId, endedYesterday.residentId, { endedOn: YESTERDAY });
		await insertOccupancyRow(unitId, endedToday.residentId, { endedOn: TODAY });
		await insertOccupancyRow(unitId, endedTomorrow.residentId, { endedOn: TOMORROW });

		const groups = await listUnitOccupanciesGrouped(testDb.db, TODAY_CLOCK, superuserId, unitId);

		expect(new Set(groups.current.map((row) => row.residentName))).toEqual(
			new Set([
				'Warga Mulai Kemarin',
				'Warga Mulai Hari Ini',
				'Warga Selesai Hari Ini',
				'Warga Selesai Besok'
			])
		);
		expect(groups.upcoming.map((row) => row.residentName)).toEqual(['Warga Mulai Besok']);
		expect(groups.history.map((row) => row.residentName)).toEqual(['Warga Selesai Kemarin']);
		expect(groups.history.every((row) => row.endedOn !== null)).toBe(true);
	});

	it('orders current with the Penanggung Jawab first, then by start date', async () => {
		const superuserId = await insertSuperuser('Pengurus Urutan Saat Ini');
		const unitId = await insertUnitRow();
		const early = await insertResident('Warga Lebih Dulu Mulai');
		const late = await insertResident('Warga Belakangan Mulai');
		const holder = await insertResident('Warga Penanggung Jawab Urutan');
		await insertOccupancyRow(unitId, late.residentId, { startedOn: MID_YEAR });
		await insertOccupancyRow(unitId, early.residentId, { startedOn: STARTED_ON });
		await insertOccupancyRow(unitId, holder.residentId, {
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		const groups = await listUnitOccupanciesGrouped(testDb.db, READ_CLOCK, superuserId, unitId);

		expect(groups.current.map((row) => row.residentName)).toEqual([
			'Warga Penanggung Jawab Urutan',
			'Warga Lebih Dulu Mulai',
			'Warga Belakangan Mulai'
		]);
	});

	it('orders upcoming by start date, and history by last day, most recent first', async () => {
		const superuserId = await insertSuperuser('Pengurus Urutan Lain');
		const unitId = await insertUnitRow();
		const soonest = await insertResident('Warga Masuk Duluan');
		const later = await insertResident('Warga Masuk Belakangan');
		const recentlyGone = await insertResident('Warga Baru Pergi');
		const longGone = await insertResident('Warga Lama Pergi');
		await insertOccupancyRow(unitId, later.residentId, { startedOn: '2027-02-01' });
		await insertOccupancyRow(unitId, soonest.residentId, { startedOn: '2027-01-01' });
		await insertOccupancyRow(unitId, longGone.residentId, {
			startedOn: '2025-01-01',
			endedOn: '2025-06-01'
		});
		await insertOccupancyRow(unitId, recentlyGone.residentId, { endedOn: ENDED_ON });

		const groups = await listUnitOccupanciesGrouped(testDb.db, READ_CLOCK, superuserId, unitId);

		expect(groups.upcoming.map((row) => row.residentName)).toEqual([
			'Warga Masuk Duluan',
			'Warga Masuk Belakangan'
		]);
		expect(groups.history.map((row) => row.residentName)).toEqual([
			'Warga Baru Pergi',
			'Warga Lama Pergi'
		]);
	});
});

describe('listAssignableResidents', () => {
	it('refuses a caller who is not a superuser', async () => {
		await expect(
			listAssignableResidents(testDb.db, await insertUser('Warga Penasaran Daftar'))
		).rejects.toThrow(PermissionDeniedError);
	});

	it('lists residents by name, with the address their account signs in with', async () => {
		const superuserId = await insertSuperuser('Pengurus Daftar Warga');
		const { residentId, userId } = await insertResident('Warga Bisa Dikaitkan');

		const assignable = await listAssignableResidents(testDb.db, superuserId);

		expect(assignable).toContainEqual({
			residentId,
			name: 'Warga Bisa Dikaitkan',
			email: `${userId}@komplek.local`
		});
	});
});

describe('occupiedUnitsForUser', () => {
	it('returns nothing for a signed-in account with no residents row yet', async () => {
		const userId = await insertUser('Warga Belum Tercatat');

		expect(await occupiedUnitsForUser(testDb.db, READ_CLOCK, userId)).toEqual([]);
	});

	it('returns the resident’s own running stay together with everyone recorded in that house', async () => {
		const block = unique('RUMAH');
		const unitId = await insertUnitRow(block);
		const me = await insertResident('Warga Penghuni Saya');
		const housemate = await insertResident('Warga Serumah');
		const formerNeighbour = await insertResident('Warga Sudah Pindah');
		await insertOccupancyRow(unitId, me.residentId, { isPrimaryOccupant: true });
		await insertOccupancyRow(unitId, housemate.residentId);
		await insertOccupancyRow(unitId, formerNeighbour.residentId, { endedOn: ENDED_ON });

		const [mine] = await occupiedUnitsForUser(testDb.db, READ_CLOCK, me.userId);

		expect(mine).toMatchObject({
			unitId,
			block,
			number: '1',
			startedOn: STARTED_ON,
			endedOn: null,
			isPrimaryOccupant: true
		});
		expect(mine.occupants.map((occupant) => occupant.name)).toEqual([
			'Warga Penghuni Saya',
			'Warga Serumah'
		]);
	});

	it('shows a stay that has ended without naming whoever lives there now', async () => {
		const unitId = await insertUnitRow();
		const movedOut = await insertResident('Warga Pindah Keluar');
		const movedIn = await insertResident('Warga Pindah Masuk');
		await insertOccupancyRow(unitId, movedOut.residentId, { endedOn: ENDED_ON });
		await insertOccupancyRow(unitId, movedIn.residentId, { startedOn: MID_YEAR });

		const [mine] = await occupiedUnitsForUser(testDb.db, READ_CLOCK, movedOut.userId);

		expect(mine).toMatchObject({ unitId, endedOn: ENDED_ON, isRunning: false });
		expect(mine.occupants).toEqual([]);
	});

	it('still calls the stay running, and still names the household, when the end date has not arrived', async () => {
		// Reported from the running application: a resident whose `ended_on` was set to next year was
		// shown "Masa huni Anda di rumah ini sudah selesai" on the same screen as "Sejak … sampai
		// <next year>", and the household was hidden from them — while they were living in the house.
		const unitId = await insertUnitRow();
		const leavingNextYear = await insertResident('Warga Pamit Untuk Tahun Depan');
		const housemate = await insertResident('Warga Masih Serumah');
		await insertOccupancyRow(unitId, leavingNextYear.residentId, {
			endedOn: FUTURE_END,
			isPrimaryOccupant: true
		});
		await insertOccupancyRow(unitId, housemate.residentId);

		const [mine] = await occupiedUnitsForUser(testDb.db, READ_CLOCK, leavingNextYear.userId);

		expect(mine).toMatchObject({ unitId, endedOn: FUTURE_END, isRunning: true });
		expect(mine.occupants.map((occupant) => occupant.name)).toEqual([
			'Warga Masih Serumah',
			'Warga Pamit Untuk Tahun Depan'
		]);
	});

	it('calls that same stay over once the day it ends on has passed', async () => {
		const unitId = await insertUnitRow();
		const leavingNextYear = await insertResident('Warga Pamit Lalu Pergi');
		await insertOccupancyRow(unitId, leavingNextYear.residentId, { endedOn: FUTURE_END });

		const [mine] = await occupiedUnitsForUser(
			testDb.db,
			new FakeClock('2027-01-01T00:00:00.000Z'),
			leavingNextYear.userId
		);

		expect(mine).toMatchObject({ endedOn: FUTURE_END, isRunning: false });
		expect(mine.occupants).toEqual([]);
	});

	it('counts the last day of a stay as still living there, not as already gone', async () => {
		const unitId = await insertUnitRow();
		const leavingToday = await insertResident('Warga Pergi Hari Ini');
		await insertOccupancyRow(unitId, leavingToday.residentId, { endedOn: '2026-08-01' });

		const [mine] = await occupiedUnitsForUser(testDb.db, READ_CLOCK, leavingToday.userId);

		expect(mine).toMatchObject({ endedOn: '2026-08-01', isRunning: true });
	});

	it('does not call a stay that starts tomorrow running, and names no household for it', async () => {
		const unitId = await insertUnitRow();
		const arriving = await insertResident('Warga Pindah Besok');
		const alreadyThere = await insertResident('Warga Sudah Tinggal');
		await insertOccupancyRow(unitId, arriving.residentId, { startedOn: TOMORROW });
		await insertOccupancyRow(unitId, alreadyThere.residentId);

		const [mine] = await occupiedUnitsForUser(testDb.db, READ_CLOCK, arriving.userId);

		expect(mine).toMatchObject({ unitId, startedOn: TOMORROW, isRunning: false });
		expect(mine.occupants).toEqual([]);
	});

	it('leaves someone whose stay starts tomorrow out of the household list', async () => {
		const unitId = await insertUnitRow();
		const me = await insertResident('Warga Penghuni Lama');
		const arriving = await insertResident('Warga Serumah Mulai Besok');
		await insertOccupancyRow(unitId, me.residentId);
		await insertOccupancyRow(unitId, arriving.residentId, { startedOn: TOMORROW });

		const [mine] = await occupiedUnitsForUser(testDb.db, READ_CLOCK, me.userId);

		expect(mine.occupants.map((occupant) => occupant.name)).toEqual(['Warga Penghuni Lama']);
	});
});

describe('occupiedUnitsForUserGrouped', () => {
	it('returns an empty split for a signed-in account with no residents row yet', async () => {
		const userId = await insertUser('Warga Belum Tercatat Kelompok');

		expect(await occupiedUnitsForUserGrouped(testDb.db, READ_CLOCK, userId)).toEqual({
			current: [],
			upcoming: [],
			history: []
		});
	});

	it('sorts every start-date and end-date boundary the same way listUnitOccupancies does', async () => {
		// Batas wajib per acceptance criteria #245, ditegakkan lagi untuk "Rumah saya": tanggal mulai
		// kemarin/hari ini/besok, dan hari terakhir kemarin/hari ini/besok.
		const me = await insertResident('Warga Rumah Saya Batas');
		const blockYesterday = await insertUnitRow(unique('KEMARIN'));
		const blockToday = await insertUnitRow(unique('HARIINI'));
		const blockTomorrow = await insertUnitRow(unique('BESOK'));
		const blockEndedYesterday = await insertUnitRow(unique('SELESAI-KEMARIN'));
		const blockEndedToday = await insertUnitRow(unique('SELESAI-HARIINI'));
		const blockEndedTomorrow = await insertUnitRow(unique('SELESAI-BESOK'));
		await insertOccupancyRow(blockYesterday, me.residentId, { startedOn: YESTERDAY });
		await insertOccupancyRow(blockToday, me.residentId, { startedOn: TODAY });
		await insertOccupancyRow(blockTomorrow, me.residentId, { startedOn: TOMORROW });
		await insertOccupancyRow(blockEndedYesterday, me.residentId, { endedOn: YESTERDAY });
		await insertOccupancyRow(blockEndedToday, me.residentId, { endedOn: TODAY });
		await insertOccupancyRow(blockEndedTomorrow, me.residentId, { endedOn: TOMORROW });

		const groups = await occupiedUnitsForUserGrouped(testDb.db, TODAY_CLOCK, me.userId);

		expect(groups.current.map((row) => row.unitId).sort()).toEqual(
			[blockYesterday, blockToday, blockEndedToday, blockEndedTomorrow].sort()
		);
		expect(groups.upcoming.map((row) => row.unitId)).toEqual([blockTomorrow]);
		expect(groups.history.map((row) => row.unitId)).toEqual([blockEndedYesterday]);
	});

	it('orders current with the Penanggung Jawab house first, upcoming by start date, and history by last day, most recent first', async () => {
		const me = await insertResident('Warga Rumah Saya Urutan');
		const holderUnit = await insertUnitRow(unique('SAYA-PENANGGUNG-JAWAB'));
		const earlyUnit = await insertUnitRow(unique('SAYA-MULAI-LEBIH-DULU'));
		const soonestUnit = await insertUnitRow(unique('SAYA-AKAN-MASUK-DULUAN'));
		const laterUnit = await insertUnitRow(unique('SAYA-AKAN-MASUK-BELAKANGAN'));
		const recentlyGoneUnit = await insertUnitRow(unique('SAYA-BARU-PERGI'));
		const longGoneUnit = await insertUnitRow(unique('SAYA-LAMA-PERGI'));
		// The Penanggung Jawab house starts later than the other current house, so its place at the
		// front of `current` can only come from the flag, never from the start date.
		await insertOccupancyRow(holderUnit, me.residentId, {
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});
		await insertOccupancyRow(earlyUnit, me.residentId, { startedOn: STARTED_ON });
		await insertOccupancyRow(laterUnit, me.residentId, { startedOn: '2027-02-01' });
		await insertOccupancyRow(soonestUnit, me.residentId, { startedOn: '2027-01-01' });
		await insertOccupancyRow(longGoneUnit, me.residentId, {
			startedOn: '2025-01-01',
			endedOn: '2025-06-01'
		});
		await insertOccupancyRow(recentlyGoneUnit, me.residentId, { endedOn: ENDED_ON });

		const groups = await occupiedUnitsForUserGrouped(testDb.db, READ_CLOCK, me.userId);

		expect(groups.current.map((row) => row.unitId)).toEqual([holderUnit, earlyUnit]);
		expect(groups.upcoming.map((row) => row.unitId)).toEqual([soonestUnit, laterUnit]);
		expect(groups.history.map((row) => row.unitId)).toEqual([recentlyGoneUnit, longGoneUnit]);
	});

	it('includes the household only for a house in current, not for one upcoming or in history', async () => {
		const me = await insertResident('Warga Rumah Saya Daftar Penghuni');
		const housemate = await insertResident('Warga Serumah Rumah Saya');
		const currentUnit = await insertUnitRow(unique('SAAT-INI'));
		const upcomingUnit = await insertUnitRow(unique('AKAN-MASUK'));
		const historyUnit = await insertUnitRow(unique('RIWAYAT'));
		await insertOccupancyRow(currentUnit, me.residentId);
		await insertOccupancyRow(currentUnit, housemate.residentId);
		await insertOccupancyRow(upcomingUnit, me.residentId, { startedOn: TOMORROW });
		await insertOccupancyRow(historyUnit, me.residentId, { endedOn: ENDED_ON });

		const groups = await occupiedUnitsForUserGrouped(testDb.db, READ_CLOCK, me.userId);

		expect(groups.current).toHaveLength(1);
		expect(groups.current[0].occupants.map((occupant) => occupant.name)).toEqual([
			'Warga Rumah Saya Daftar Penghuni',
			'Warga Serumah Rumah Saya'
		]);
		expect(groups.upcoming).toHaveLength(1);
		expect(groups.upcoming[0].occupants).toEqual([]);
		expect(groups.history).toHaveLength(1);
		expect(groups.history[0].occupants).toEqual([]);
	});
});
