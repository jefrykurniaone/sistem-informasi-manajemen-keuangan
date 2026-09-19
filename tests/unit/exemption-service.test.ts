import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { exemptions } from '$lib/server/db/schema/exemption';
import { invoices } from '$lib/server/db/schema/invoice';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	endExemption,
	EXEMPTION_ENDED_ACTION,
	EXEMPTION_GRANTED_ACTION,
	ExemptionActorNotRegisteredError,
	ExemptionDateOrderError,
	ExemptionNotFoundError,
	ExemptionOverlapError,
	grantExemption,
	isUnitExemptOn,
	listActiveExemptions
} from '$lib/server/services/dues/exemption';
import { UnitNotFoundError } from '$lib/server/services/unit';

/**
 * The Pembebasan service: granting an exemption, ending one that is running, the admin list of
 * units currently exempt, and `isUnitExemptOn` — the read contract #26 (issuance) will call.
 *
 * `tests/unit/schema-exemption.test.ts`, if it exists, proves the database's own rules (the date
 * order check); this file proves what the service adds on top — permission, attribution to a
 * `residents` row, the audit trail, and the overlap rule the schema deliberately does not enforce
 * itself (see `src/lib/server/db/schema/exemption.ts`).
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The instant every read in this file happens at, so "today" is `2026-06-15` for every assertion. */
const READ_CLOCK = new FakeClock('2026-06-15T12:00:00.000Z');

/**
 * Every exemption and every Tagihan is cleared before each test.
 *
 * `listActiveExemptions` is a global read, the same shape `listDuesRates` is in
 * `tests/unit/dues-rate-service.test.ts` and for the same reason: a row left behind by an earlier
 * test would silently appear in a later test's list. This deletes only inside this file's own
 * PostgreSQL schema — see `src/lib/server/db/test-helpers.ts` — so it cannot reach another file's
 * rows.
 */
beforeEach(async () => {
	await testDb.db.delete(invoices);
	await testDb.db.delete(exemptions);
});

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

/** A superuser with a `residents` row, ready to act as `actorId` and to be attributed a grant. */
async function insertSuperuser(name: string): Promise<string> {
	const userId = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.superuser, createdAt: new Date(START) });
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** A house, for an exemption to belong to. */
async function insertUnit(): Promise<{ unitId: string; block: string; number: string }> {
	sequence += 1;
	const block = `EXEMPT-${sequence}`;
	const [row] = await testDb.db
		.insert(units)
		.values({ block, number: '1', createdAt: new Date(START) })
		.returning();
	return { unitId: row.id, block: row.block, number: row.number };
}

/**
 * The `residents` row belonging to `userId` — every fixture needs it, because `exemptions.createdBy`
 * references `residents.id`, not the account id the service layer's `actorId` is.
 */
async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

/**
 * An exemption row written directly, bypassing the service under test, for building a fixture.
 * `grantedByUserId` is the account id — the same shape `insertSuperuser` returns — not a
 * `residents.id`; this looks that row up itself.
 */
async function insertExemption(
	unitId: string,
	startedOn: string,
	endedOn: string | null,
	grantedByUserId: string
): Promise<string> {
	const [row] = await testDb.db
		.insert(exemptions)
		.values({
			unitId,
			startedOn,
			endedOn,
			reason: 'Fixture',
			createdBy: await residentIdOf(grantedByUserId),
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** A Tagihan for `period`, written straight into `invoices` — nothing here issues one for real. */
async function insertInvoice(unitId: string, period: string): Promise<void> {
	await testDb.db.insert(invoices).values({
		unitId,
		period,
		amount: rupiah(150_000),
		dueDate: `${period}-05`,
		issuedAt: new Date(START)
	});
}

/**
 * Runs something that must be refused and hands back how it was refused. The rejection is caught the
 * moment the promise is made, not at the `await` — the same reasoning
 * `tests/unit/occupancy-service.test.ts` records for its own copy of this helper.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('The service accepted a change it was supposed to refuse.');
}

describe('grantExemption', () => {
	it('grants the exemption and records one audit row for it', async () => {
		const superuserId = await insertSuperuser('Pengurus Pembebas');
		const { unitId } = await insertUnit();
		const clock = new FakeClock(START);

		const granted = await grantExemption(testDb.db, clock, {
			actorId: superuserId,
			unitId,
			startedOn: '2026-02-01',
			reason: 'Rumah kosong sejak pemilik pindah'
		});

		expect(granted).toMatchObject({
			unitId,
			startedOn: '2026-02-01',
			endedOn: null,
			reason: 'Rumah kosong sejak pemilik pindah'
		});
		const entries = await auditEntriesFor(testDb.db, granted.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: EXEMPTION_GRANTED_ACTION,
			targetId: granted.id,
			after: { unitId, startedOn: '2026-02-01', endedOn: null }
		});
	});

	it('accepts an explicit end date, on or after the start date', async () => {
		const superuserId = await insertSuperuser('Pengurus Pembebas Terbatas');
		const { unitId } = await insertUnit();

		const granted = await grantExemption(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId,
			startedOn: '2026-02-01',
			endedOn: '2026-02-01',
			reason: 'Satu hari saja'
		});

		expect(granted).toMatchObject({ startedOn: '2026-02-01', endedOn: '2026-02-01' });
	});

	it('refuses an end date earlier than the start date, and writes nothing', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanggal Ngawur');
		const { unitId } = await insertUnit();

		const failure = grantExemption(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			unitId,
			startedOn: '2026-02-10',
			endedOn: '2026-02-01',
			reason: 'Alasan apa saja'
		});

		await expect(failure).rejects.toThrow(ExemptionDateOrderError);
		await expect(failure).rejects.toMatchObject({ startedOn: '2026-02-10', endedOn: '2026-02-01' });
		expect(await testDb.db.select().from(exemptions)).toHaveLength(0);
	});

	it('refuses an empty reason', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanpa Alasan');
		const { unitId } = await insertUnit();

		await expect(
			grantExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				startedOn: '2026-02-01',
				reason: '   '
			})
		).rejects.toThrow(TypeError);
	});

	it('refuses a start date that is not a real calendar day', async () => {
		const superuserId = await insertSuperuser('Pengurus Tanggal Palsu');
		const { unitId } = await insertUnit();

		await expect(
			grantExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				startedOn: '2026-02-30',
				reason: 'Alasan apa saja'
			})
		).rejects.toThrow(TypeError);
	});

	it('refuses a unit id that names no unit', async () => {
		const superuserId = await insertSuperuser('Pengurus Unit Hilang');

		await expect(
			grantExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId: randomUUID(),
				startedOn: '2026-02-01',
				reason: 'Alasan apa saja'
			})
		).rejects.toThrow(UnitNotFoundError);
	});

	it('refuses a caller who is not a superuser, and writes nothing', async () => {
		const residentId = await insertUser('Warga Tak Berhak Bebaskan');
		const { unitId } = await insertUnit();

		await expect(
			grantExemption(testDb.db, new FakeClock(START), {
				actorId: residentId,
				unitId,
				startedOn: '2026-02-01',
				reason: 'Alasan apa saja'
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(await testDb.db.select().from(exemptions)).toHaveLength(0);
	});

	it('refuses a superuser who has no residents row to be attributed to', async () => {
		const userId = await insertUser('Pengurus Tanpa Data Warga');
		await testDb.db
			.insert(userRoles)
			.values({ userId, role: ROLE.superuser, createdAt: new Date(START) });
		const { unitId } = await insertUnit();

		const failure = grantExemption(testDb.db, new FakeClock(START), {
			actorId: userId,
			unitId,
			startedOn: '2026-02-01',
			reason: 'Alasan apa saja'
		});

		await expect(failure).rejects.toThrow(ExemptionActorNotRegisteredError);
		await expect(failure).rejects.toMatchObject({ actorId: userId });
	});

	describe('the overlap rule', () => {
		it('refuses a period that overlaps an existing exemption of the same unit', async () => {
			const superuserId = await insertSuperuser('Pengurus Tabrakan Periode');
			const { unitId } = await insertUnit();
			const existing = await insertExemption(unitId, '2026-01-01', '2026-03-31', superuserId);

			const failure = grantExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				startedOn: '2026-03-01',
				reason: 'Periode bertindih'
			});

			await expect(failure).rejects.toThrow(ExemptionOverlapError);
			await expect(failure).rejects.toMatchObject({ unitId, exemptionId: existing });
		});

		it('refuses a new open-ended period against an existing open-ended one', async () => {
			const superuserId = await insertSuperuser('Pengurus Tabrakan Tanpa Batas');
			const { unitId } = await insertUnit();
			await insertExemption(unitId, '2026-01-01', null, superuserId);

			await expect(
				grantExemption(testDb.db, new FakeClock(START), {
					actorId: superuserId,
					unitId,
					startedOn: '2026-06-01',
					reason: 'Periode bertindih tanpa batas'
				})
			).rejects.toThrow(ExemptionOverlapError);
		});

		it('allows a period that starts the day after an existing one ends', async () => {
			const superuserId = await insertSuperuser('Pengurus Periode Bersambung');
			const { unitId } = await insertUnit();
			await insertExemption(unitId, '2026-01-01', '2026-01-31', superuserId);

			const granted = await grantExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId,
				startedOn: '2026-02-01',
				reason: 'Periode berikutnya'
			});

			expect(granted).toMatchObject({ startedOn: '2026-02-01' });
		});

		it('allows an overlapping period on a different unit', async () => {
			const superuserId = await insertSuperuser('Pengurus Unit Lain');
			const { unitId: unitA } = await insertUnit();
			const { unitId: unitB } = await insertUnit();
			await insertExemption(unitA, '2026-01-01', '2026-03-31', superuserId);

			const granted = await grantExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				unitId: unitB,
				startedOn: '2026-02-01',
				reason: 'Unit yang berbeda'
			});

			expect(granted).toMatchObject({ unitId: unitB });
		});

		it('refuses a second exemption written from another connection mid-flight', async () => {
			// Two calls started together and awaited through Promise.allSettled would prove nothing —
			// nothing makes one of them land inside the other's window. A second connection holding an
			// open transaction does, and only because the service takes the unit's row lock and reads
			// its exemptions again behind it: with no exemption row yet to lock, a check that skipped
			// the unit lock would let both grants read an empty table and both insert.
			const superuserId = await insertSuperuser('Pengurus Adu Cepat Bebas');
			const { unitId } = await insertUnit();
			const residentId = await residentIdOf(superuserId);

			const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
				options: `-c search_path=${testDb.schemaName}`
			});
			const client = await other.pool.connect();
			try {
				await client.query('begin');
				await client.query('select id from units where id = $1 for update', [unitId]);
				await client.query(
					`insert into exemptions (unit_id, started_on, ended_on, reason, created_by, created_at)
					 values ($1, $2, $3, $4, $5, $6)`,
					[unitId, '2026-01-01', null, 'Ditulis dari koneksi lain', residentId, new Date(START)]
				);

				const blocked = rejection(
					grantExemption(testDb.db, new FakeClock(START), {
						actorId: superuserId,
						unitId,
						startedOn: '2026-06-01',
						reason: 'Kalah cepat'
					})
				);
				await client.query('commit');

				expect(await blocked).toBeInstanceOf(ExemptionOverlapError);
			} finally {
				client.release();
				await other.close();
			}
		});
	});

	it('grants an exemption whose start date is in the past without touching an invoice already issued', async () => {
		// The acceptance criteria's explicit requirement: a backdated grant never voids or edits an
		// existing Tagihan, including one already inside the period being granted.
		const superuserId = await insertSuperuser('Pengurus Bebaskan Mundur');
		const { unitId } = await insertUnit();
		await insertInvoice(unitId, '2026-02');
		const [before] = await testDb.db.select().from(invoices).where(eq(invoices.unitId, unitId));

		await grantExemption(testDb.db, new FakeClock('2026-06-01T00:00:00.000Z'), {
			actorId: superuserId,
			unitId,
			startedOn: '2026-01-01',
			reason: 'Rumah sudah kosong sejak awal tahun'
		});

		const [after] = await testDb.db.select().from(invoices).where(eq(invoices.unitId, unitId));
		expect(after).toEqual(before);
	});
});

describe('endExemption', () => {
	it('ends a running exemption and records one audit row', async () => {
		const superuserId = await insertSuperuser('Pengurus Pengakhir Bebas');
		const { unitId } = await insertUnit();
		const exemptionId = await insertExemption(unitId, '2026-01-01', null, superuserId);

		const ended = await endExemption(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			exemptionId,
			endedOn: '2026-06-30'
		});

		expect(ended.endedOn).toBe('2026-06-30');
		const entries = await auditEntriesFor(testDb.db, exemptionId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: EXEMPTION_ENDED_ACTION,
			targetId: exemptionId,
			before: { endedOn: null },
			after: { endedOn: '2026-06-30' }
		});
	});

	it('is a no-op, with no second audit row, when asked for the end date it already has', async () => {
		const superuserId = await insertSuperuser('Pengurus Ulang Akhir');
		const { unitId } = await insertUnit();
		const exemptionId = await insertExemption(unitId, '2026-01-01', '2026-06-30', superuserId);

		await endExemption(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			exemptionId,
			endedOn: '2026-06-30'
		});

		expect(await auditEntriesFor(testDb.db, exemptionId)).toHaveLength(0);
	});

	it('refuses an end date earlier than the exemption started', async () => {
		const superuserId = await insertSuperuser('Pengurus Akhir Ngawur');
		const { unitId } = await insertUnit();
		const exemptionId = await insertExemption(unitId, '2026-03-01', null, superuserId);

		const failure = endExemption(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			exemptionId,
			endedOn: '2026-02-01'
		});

		await expect(failure).rejects.toThrow(ExemptionDateOrderError);
	});

	it('throws ExemptionNotFoundError for an id that names no exemption', async () => {
		const superuserId = await insertSuperuser('Pengurus Bebas Hilang');

		await expect(
			endExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				exemptionId: randomUUID(),
				endedOn: '2026-06-30'
			})
		).rejects.toThrow(ExemptionNotFoundError);
	});

	it('refuses a caller who is not a superuser', async () => {
		const superuserId = await insertSuperuser('Pengurus Pemilik Bebas');
		const residentId = await insertUser('Warga Tak Berhak Akhiri');
		const { unitId } = await insertUnit();
		const exemptionId = await insertExemption(unitId, '2026-01-01', null, superuserId);

		await expect(
			endExemption(testDb.db, new FakeClock(START), {
				actorId: residentId,
				exemptionId,
				endedOn: '2026-06-30'
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	describe('the overlap rule', () => {
		it('refuses extending an exemption to overlap a later exemption granted afterward', async () => {
			// The exact reproduction the hand-back described: grant B, grant C after it with no
			// overlap, then push B's end date past C's start through the end form alone.
			const superuserId = await insertSuperuser('Pengurus Akhir Tabrakan');
			const { unitId } = await insertUnit();
			const clock = new FakeClock(START);
			const grantedB = await grantExemption(testDb.db, clock, {
				actorId: superuserId,
				unitId,
				startedOn: '2026-09-01',
				endedOn: '2026-09-30',
				reason: 'Rumah B kosong'
			});
			await grantExemption(testDb.db, clock, {
				actorId: superuserId,
				unitId,
				startedOn: '2026-10-15',
				endedOn: '2026-10-31',
				reason: 'Rumah C kosong'
			});

			const failure = endExemption(testDb.db, clock, {
				actorId: superuserId,
				exemptionId: grantedB.id,
				endedOn: '2026-11-30'
			});

			await expect(failure).rejects.toThrow(ExemptionOverlapError);
			const [unchanged] = await testDb.db
				.select()
				.from(exemptions)
				.where(eq(exemptions.id, grantedB.id));
			expect(unchanged.endedOn).toBe('2026-09-30');
		});

		it('accepts an end date that does not reach a later exemption of the same unit', async () => {
			const superuserId = await insertSuperuser('Pengurus Akhir Aman');
			const { unitId } = await insertUnit();
			const exemptionId = await insertExemption(unitId, '2026-09-01', '2026-09-30', superuserId);
			await insertExemption(unitId, '2026-10-15', '2026-10-31', superuserId);

			const ended = await endExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				exemptionId,
				endedOn: '2026-10-01'
			});

			expect(ended.endedOn).toBe('2026-10-01');
		});

		it('accepts shortening an exemption even when another exemption exists on the same unit', async () => {
			const superuserId = await insertSuperuser('Pengurus Akhir Pendek');
			const { unitId } = await insertUnit();
			const exemptionId = await insertExemption(unitId, '2026-01-01', '2026-06-30', superuserId);
			await insertExemption(unitId, '2026-10-01', null, superuserId);

			const ended = await endExemption(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				exemptionId,
				endedOn: '2026-03-01'
			});

			expect(ended.endedOn).toBe('2026-03-01');
		});

		it('refuses ending into an overlap created by a second connection mid-flight', async () => {
			// The same reasoning as grantExemption's own race test above: two calls raced through
			// Promise.allSettled would prove nothing, because nothing would make one of them land
			// inside the other's window. A second connection holding an open transaction does, and
			// only because endExemption takes the unit's row lock before reading its exemptions again.
			const superuserId = await insertSuperuser('Pengurus Akhir Adu Cepat');
			const { unitId } = await insertUnit();
			const exemptionId = await insertExemption(unitId, '2026-01-01', '2026-01-31', superuserId);
			const residentId = await residentIdOf(superuserId);

			const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
				options: `-c search_path=${testDb.schemaName}`
			});
			const client = await other.pool.connect();
			try {
				await client.query('begin');
				await client.query('select id from units where id = $1 for update', [unitId]);
				await client.query(
					`insert into exemptions (unit_id, started_on, ended_on, reason, created_by, created_at)
					 values ($1, $2, $3, $4, $5, $6)`,
					[unitId, '2026-03-01', null, 'Ditulis dari koneksi lain', residentId, new Date(START)]
				);

				const blocked = rejection(
					endExemption(testDb.db, new FakeClock(START), {
						actorId: superuserId,
						exemptionId,
						endedOn: '2026-04-01'
					})
				);
				await client.query('commit');

				expect(await blocked).toBeInstanceOf(ExemptionOverlapError);
			} finally {
				client.release();
				await other.close();
			}
		});
	});
});

describe('listActiveExemptions', () => {
	it('refuses a caller who is not a superuser', async () => {
		const residentId = await insertUser('Warga Penasaran Bebas');

		await expect(listActiveExemptions(testDb.db, READ_CLOCK, residentId)).rejects.toThrow(
			PermissionDeniedError
		);
	});

	it('lists a unit exempt today, with its reason and period, ordered by block then number', async () => {
		const superuserId = await insertSuperuser('Pengurus Daftar Bebas');
		const second = await insertUnit();
		const first = await insertUnit();
		await testDb.db.update(units).set({ block: 'AAA' }).where(eq(units.id, first.unitId));
		await testDb.db.update(units).set({ block: 'ZZZ' }).where(eq(units.id, second.unitId));
		await insertExemption(first.unitId, '2026-06-01', null, superuserId);
		await insertExemption(second.unitId, '2026-06-01', '2026-06-20', superuserId);

		const list = await listActiveExemptions(testDb.db, READ_CLOCK, superuserId);

		expect(list.map((row) => row.unitId)).toEqual([first.unitId, second.unitId]);
		expect(list[0]).toMatchObject({ startedOn: '2026-06-01', endedOn: null, reason: 'Fixture' });
		expect(list[1]).toMatchObject({ startedOn: '2026-06-01', endedOn: '2026-06-20' });
	});

	it('leaves out an exemption scheduled to start later than today', async () => {
		const superuserId = await insertSuperuser('Pengurus Bebas Nanti');
		const { unitId } = await insertUnit();
		await insertExemption(unitId, '2026-07-01', null, superuserId);

		expect(await listActiveExemptions(testDb.db, READ_CLOCK, superuserId)).toEqual([]);
	});

	it('leaves out an exemption that has already ended', async () => {
		const superuserId = await insertSuperuser('Pengurus Bebas Lampau');
		const { unitId } = await insertUnit();
		await insertExemption(unitId, '2026-01-01', '2026-01-31', superuserId);

		expect(await listActiveExemptions(testDb.db, READ_CLOCK, superuserId)).toEqual([]);
	});

	it('answers an empty list rather than failing when nothing is exempt', async () => {
		const superuserId = await insertSuperuser('Pengurus Bebas Kosong');

		expect(await listActiveExemptions(testDb.db, READ_CLOCK, superuserId)).toEqual([]);
	});
});

describe('isUnitExemptOn', () => {
	it('answers true for a day inside an open-ended exemption', async () => {
		const superuserId = await insertSuperuser('Pengurus Cek Bebas Terbuka');
		const { unitId } = await insertUnit();
		await insertExemption(unitId, '2026-01-01', null, superuserId);

		expect(await isUnitExemptOn(testDb.db, unitId, '2030-01-01')).toBe(true);
	});

	it('answers true on both ends of a bounded exemption, inclusive', async () => {
		const superuserId = await insertSuperuser('Pengurus Cek Bebas Batas');
		const { unitId } = await insertUnit();
		await insertExemption(unitId, '2026-01-10', '2026-01-20', superuserId);

		expect(await isUnitExemptOn(testDb.db, unitId, '2026-01-10')).toBe(true);
		expect(await isUnitExemptOn(testDb.db, unitId, '2026-01-20')).toBe(true);
	});

	it('answers false the day before it starts and the day after it ends', async () => {
		const superuserId = await insertSuperuser('Pengurus Cek Bebas Luar');
		const { unitId } = await insertUnit();
		await insertExemption(unitId, '2026-01-10', '2026-01-20', superuserId);

		expect(await isUnitExemptOn(testDb.db, unitId, '2026-01-09')).toBe(false);
		expect(await isUnitExemptOn(testDb.db, unitId, '2026-01-21')).toBe(false);
	});

	it('answers false when the unit has never had an exemption', async () => {
		const { unitId } = await insertUnit();

		expect(await isUnitExemptOn(testDb.db, unitId, '2026-01-01')).toBe(false);
	});

	it('refuses a day that is not a real calendar day', async () => {
		const { unitId } = await insertUnit();

		await expect(isUnitExemptOn(testDb.db, unitId, '2026-02-30')).rejects.toThrow(TypeError);
	});
});
