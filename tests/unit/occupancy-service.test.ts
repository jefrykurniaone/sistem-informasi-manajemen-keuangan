import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	endOccupancy,
	listAssignableResidents,
	listUnitOccupancies,
	occupiedUnitsForUser,
	OccupancyDateOrderError,
	OccupancyNotFoundError,
	OCCUPANCY_ENDED_ACTION,
	OCCUPANCY_RECORDED_ACTION,
	PRIMARY_OCCUPANT_MARKED_ACTION,
	PrimaryOccupantConflictError,
	recordOccupancy,
	ResidentNotFoundError,
	setPrimaryOccupant
} from '$lib/server/services/occupancy';
import { listUnits, needsPrimaryOccupant, UnitNotFoundError } from '$lib/server/services/unit';

/**
 * The Masa Huni service: recording a stay, ending one, and the one-primary-occupant rule.
 *
 * `tests/unit/schema-resident-unit.test.ts` already proves what the database refuses on its own.
 * This file proves what the service adds: named refusals instead of raw `SQLSTATE`s, the audit
 * trail, and — the reason this ticket exists — the future-dated `ended_on` case the partial index
 * deliberately does not cover.
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

	it('marks the stay as the primary occupant when asked to', async () => {
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
	});

	it('refuses a second primary occupant while the first stay is still running, naming who holds it', async () => {
		const superuserId = await insertSuperuser('Pengurus Penanggung Jawab Ganda');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Penanggung Jawab Sekarang');
		const challenger = await insertResident('Warga Penantang');
		await insertOccupancyRow(unitId, holder.residentId, { isPrimaryOccupant: true });

		const refusal = await rejection(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId: challenger.residentId,
				role: OCCUPANCY_ROLE.tenant,
				startedOn: MID_YEAR,
				isPrimaryOccupant: true
			})
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantConflictError);
		expect(refusal).toMatchObject({
			unitId,
			residentId: holder.residentId,
			residentName: 'Warga Penanggung Jawab Sekarang',
			startedOn: STARTED_ON,
			endedOn: null
		});
	});

	it('refuses a second primary occupant when the first one ends on a day that has not arrived yet', async () => {
		// The gap `src/lib/server/db/schema/occupancy.ts` records and leaves to this layer:
		// `occupancies_primary_occupant_unique` reads "still running" as `ended_on is null`, so a
		// future end date frees the slot early and the database accepts the second row. Nothing about
		// this case is visible to the index — only the service refuses it.
		const superuserId = await insertSuperuser('Pengurus Celah Masa Depan');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Masih Bertanggung Jawab');
		const challenger = await insertResident('Warga Datang Awal');
		await insertOccupancyRow(unitId, holder.residentId, {
			endedOn: FUTURE_END,
			isPrimaryOccupant: true
		});

		const refusal = await rejection(
			recordOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				residentId: challenger.residentId,
				role: OCCUPANCY_ROLE.tenant,
				startedOn: MID_YEAR,
				isPrimaryOccupant: true
			})
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantConflictError);
		expect(refusal).toMatchObject({ residentName: 'Warga Masih Bertanggung Jawab' });
		const rows = await testDb.db
			.select()
			.from(occupancies)
			.where(eq(occupancies.residentId, challenger.residentId));
		expect(rows).toHaveLength(0);
	});

	it('accepts the next primary occupant once the previous one’s days are over', async () => {
		const superuserId = await insertSuperuser('Pengurus Pergantian');
		const unitId = await insertUnitRow();
		const leaving = await insertResident('Warga Pergi');
		const arriving = await insertResident('Warga Datang');
		await insertOccupancyRow(unitId, leaving.residentId, {
			endedOn: ENDED_ON,
			isPrimaryOccupant: true
		});

		const created = await recordOccupancy(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId,
			residentId: arriving.residentId,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		expect(created.isPrimaryOccupant).toBe(true);
	});

	it('refuses a second primary occupant written from another connection mid-flight', async () => {
		// Two calls started together and awaited through Promise.allSettled would prove nothing:
		// nothing makes one of them land inside the other's window. A second connection holding an
		// open transaction does — and because the row it writes carries a future `ended_on`, the
		// database index is not what refuses this. The service's own check is, and it only reaches
		// the right answer because it takes the unit's row lock and reads again behind it.
		const superuserId = await insertSuperuser('Pengurus Adu Cepat');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Menang Cepat');
		const challenger = await insertResident('Warga Kalah Cepat');

		const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
			options: `-c search_path=${testDb.schemaName}`
		});
		const client = await other.pool.connect();
		try {
			await client.query('begin');
			await client.query('select id from units where id = $1 for update', [unitId]);
			await client.query(
				`insert into occupancies (unit_id, resident_id, role, started_on, ended_on, is_primary_occupant, created_at)
				 values ($1, $2, $3, $4, $5, true, $6)`,
				[unitId, holder.residentId, OCCUPANCY_ROLE.owner, STARTED_ON, FUTURE_END, new Date(START)]
			);

			const blocked = rejection(
				recordOccupancy(testDb.db, new FakeClock(START), {
					actorId: superuserId,
					unitId,
					residentId: challenger.residentId,
					role: OCCUPANCY_ROLE.tenant,
					startedOn: MID_YEAR,
					isPrimaryOccupant: true
				})
			);
			await client.query('commit');

			expect(await blocked).toBeInstanceOf(PrimaryOccupantConflictError);
		} finally {
			client.release();
			await other.close();
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

	it('refuses to push a primary occupant’s end date over another primary occupant’s days', async () => {
		const superuserId = await insertSuperuser('Pengurus Perpanjang');
		const unitId = await insertUnitRow();
		const leaving = await insertResident('Warga Pergi Lalu Kembali');
		const arriving = await insertResident('Warga Sudah Menempati');
		const leavingId = await insertOccupancyRow(unitId, leaving.residentId, {
			endedOn: ENDED_ON,
			isPrimaryOccupant: true
		});
		await insertOccupancyRow(unitId, arriving.residentId, {
			startedOn: MID_YEAR,
			isPrimaryOccupant: true
		});

		const refusal = await rejection(
			endOccupancy(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId: leavingId,
				endedOn: FUTURE_END
			})
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantConflictError);
		expect((await readOccupancy(leavingId)).endedOn).toBe(ENDED_ON);
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

	it('leaves the unit with no primary occupant, and the admin list says so', async () => {
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

		const page = await listUnits(testDb.db, { actorId: superuserId, search: block });
		const row = page.units.find((unit) => unit.id === unitId);
		expect(row).toMatchObject({ hasPrimaryOccupant: false, activeOccupantCount: 0 });
		expect(row && needsPrimaryOccupant(row)).toBe(true);
	});
});

describe('setPrimaryOccupant', () => {
	it('marks a running stay and records the change', async () => {
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
			before: { isPrimaryOccupant: false },
			after: { isPrimaryOccupant: true, unitId }
		});
	});

	it('is a no-op, with no audit row, when the stay already carries the flag', async () => {
		const superuserId = await insertSuperuser('Pengurus Tandai Ulang');
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Sudah Ditandai');
		const occupancyId = await insertOccupancyRow(unitId, residentId, { isPrimaryOccupant: true });

		await setPrimaryOccupant(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			occupancyId
		});

		expect(await auditEntriesFor(testDb.db, occupancyId)).toHaveLength(0);
	});

	it('refuses when someone else holds the slot over days this stay covers', async () => {
		const superuserId = await insertSuperuser('Pengurus Tandai Kedua');
		const unitId = await insertUnitRow();
		const holder = await insertResident('Warga Suami');
		const other = await insertResident('Warga Istri');
		await insertOccupancyRow(unitId, holder.residentId, { isPrimaryOccupant: true });
		const otherId = await insertOccupancyRow(unitId, other.residentId);

		const refusal = await rejection(
			setPrimaryOccupant(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				occupancyId: otherId
			})
		);

		expect(refusal).toBeInstanceOf(PrimaryOccupantConflictError);
		expect(refusal).toMatchObject({ residentName: 'Warga Suami' });
		expect((await readOccupancy(otherId)).isPrimaryOccupant).toBe(false);
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
			listUnitOccupancies(testDb.db, await insertUser('Warga Pengintip'), unitId)
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

		const history = await listUnitOccupancies(testDb.db, superuserId, unitId);

		expect(history.map((row) => row.residentName)).toEqual(['Warga Baru', 'Warga Lama']);
		expect(history[0]).toMatchObject({ unitId, startedOn: MID_YEAR, endedOn: null });
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

		expect(await occupiedUnitsForUser(testDb.db, userId)).toEqual([]);
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

		const [mine] = await occupiedUnitsForUser(testDb.db, me.userId);

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

		const [mine] = await occupiedUnitsForUser(testDb.db, movedOut.userId);

		expect(mine).toMatchObject({ unitId, endedOn: ENDED_ON });
		expect(mine.occupants).toEqual([]);
	});
});
