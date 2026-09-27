import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditEntriesFor } from '$lib/server/audit';
import { auditLog } from '$lib/server/db/schema/audit';
import { user } from '$lib/server/db/schema/auth';
import { occupancies, OCCUPANCY_ROLE, type OccupancyRole } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { PRIMARY_OCCUPANT_MARKED_ACTION } from '$lib/server/services/occupancy';
import {
	DATA_FIX_ACTOR_ID,
	fixDuplicateOccupancies,
	OCCUPANCY_DUPLICATE_DELETED_ACTION,
	type DuplicateFixOutcome
} from '$lib/server/services/occupancy/duplicate-fix';

/**
 * The one-off clean-up of duplicate Masa Huni (#242), against a real PostgreSQL, the way
 * `tests/unit/bootstrap-superuser.test.ts` tests the command that grants the first superuser.
 * `scripts/fix-duplicate-occupancies.ts` only picks the mode and prints, so every rule it carries
 * out is proven here, through the one function the script calls.
 */

const testDb = testDatabase();

/** When the accounts and houses in this file were created. Nothing reads it. */
const START = '2026-01-01T00:00:00.000Z';

/** Noon on 28 September 2026 in the complex's zone: the moment every run in this file happens at. */
const NOW = '2026-09-28T05:00:00.000Z';
/** The complex's calendar day at `NOW`. A last day on it has not passed. */
const TODAY = '2026-09-28';
/** The day before `TODAY`. A last day on it has passed. */
const YESTERDAY = '2026-09-27';
/** A last day that is written but still months away. */
const LATER_THIS_YEAR = '2026-12-31';

/**
 * The clean-up reads every occupancy in the schema, so a row an earlier test left behind would join
 * a later test's plan. This deletes only inside this file's own PostgreSQL schema, see
 * `src/lib/server/db/test-helpers.ts`, the same reset `tests/unit/invoice-issuance.test.ts` makes.
 * Nothing points at `occupancies`, and the audit rows stay, which is why every assertion on them
 * names its target or counts a difference.
 */
beforeEach(async () => {
	await testDb.db.delete(occupancies);
});

/** Makes every name, address and block this file writes different from every other one. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** A person with a name and an address distinct enough to search a plan for. */
interface Person {
	readonly residentId: string;
	readonly name: string;
	readonly email: string;
}

/** An account together with the `residents` row that points at it. */
async function insertResident(): Promise<Person> {
	const userId = randomUUID();
	const name = unique('Warga Tercatat Ganda');
	const email = `${unique('warga.ganda')}@komplek.local`;
	const now = new Date(START);
	await testDb.db
		.insert(user)
		.values({ id: userId, name, email, emailVerified: true, createdAt: now, updatedAt: now });
	const [row] = await testDb.db.insert(residents).values({ userId, createdAt: now }).returning();
	return { residentId: row.id, name, email };
}

/** A house, with a block no other test uses. */
async function insertUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('GANDA'), number: '7', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One occupancy row, written directly: the rows this file cleans up are the ones no form accepts. */
interface OccupancyFixture {
	readonly startedOn: string;
	/** Defaults to `null`, a stay with no last day set. */
	readonly endedOn?: string | null;
	/** Defaults to `false`. */
	readonly isPrimaryOccupant?: boolean;
	/**
	 * When it was recorded, as minutes after `START`: rule 1 visits a resident's rows in this order,
	 * which is deliberately not always the order of their start days.
	 */
	readonly recorded: number;
	/** A fixed id, for the test that breaks a tie on the recording instant. */
	readonly id?: string;
	/** Defaults to `owner`. */
	readonly role?: OccupancyRole;
}

async function insertOccupancy(
	unitId: string,
	person: Person,
	fixture: OccupancyFixture
): Promise<string> {
	const [row] = await testDb.db
		.insert(occupancies)
		.values({
			...(fixture.id ? { id: fixture.id } : {}),
			unitId,
			residentId: person.residentId,
			role: fixture.role ?? OCCUPANCY_ROLE.owner,
			startedOn: fixture.startedOn,
			endedOn: fixture.endedOn ?? null,
			isPrimaryOccupant: fixture.isPrimaryOccupant ?? false,
			createdAt: new Date(Date.parse(START) + fixture.recorded * 60_000)
		})
		.returning();
	return row.id;
}

/** How many rows the two tables the clean-up writes hold, for the tests that assert on a change. */
async function tableSizes(): Promise<{ occupancies: number; auditLog: number }> {
	const occupancyRows = await testDb.db.select({ id: occupancies.id }).from(occupancies);
	const auditRows = await testDb.db.select({ id: auditLog.id }).from(auditLog);
	return { occupancies: occupancyRows.length, auditLog: auditRows.length };
}

/** Which of `ids` still name a row, sorted. */
async function surviving(ids: readonly string[]): Promise<string[]> {
	const rows = await testDb.db
		.select({ id: occupancies.id })
		.from(occupancies)
		.where(inArray(occupancies.id, [...ids]));
	return rows.map((row) => row.id).sort();
}

/** Whether the row named by `occupancyId` carries the Penanggung Jawab marker now. */
async function isMarked(occupancyId: string): Promise<boolean> {
	const [row] = await testDb.db
		.select({ isPrimaryOccupant: occupancies.isPrimaryOccupant })
		.from(occupancies)
		.where(eq(occupancies.id, occupancyId));
	return row.isPrimaryOccupant;
}

/** Every occupancy id the outcome's plan deletes, sorted. Empty when there is no plan. */
function plannedDeletions(outcome: DuplicateFixOutcome): string[] {
	if (outcome.kind === 'clean') {
		return [];
	}
	return outcome.plan.units
		.flatMap((unit) => unit.groups.flatMap((group) => group.deleted))
		.map((row) => row.occupancyId)
		.sort();
}

/** Every marker move the outcome's plan makes, as `from -> to`. */
function plannedMoves(outcome: DuplicateFixOutcome): string[] {
	if (outcome.kind === 'clean') {
		return [];
	}
	return outcome.plan.units.flatMap((unit) =>
		unit.moves.map((move) => `${move.fromOccupancyId} -> ${move.toOccupancyId}`)
	);
}

function run(mode: 'dryRun' | 'apply', instant = NOW): Promise<DuplicateFixOutcome> {
	return fixDuplicateOccupancies(testDb.db, new FakeClock(instant), mode);
}

describe('fixDuplicateOccupancies', () => {
	it('writes nothing on a dry run, and plans without a name or an email', async () => {
		const unitId = await insertUnit();
		const person = await insertResident();
		const kept = await insertOccupancy(unitId, person, { startedOn: '2026-01-01', recorded: 1 });
		const duplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-02-01',
			role: OCCUPANCY_ROLE.tenant,
			recorded: 2
		});
		const before = await tableSizes();

		const outcome = await run('dryRun');

		expect(await tableSizes()).toEqual(before);
		expect(await surviving([kept, duplicate])).toEqual([kept, duplicate].sort());
		expect(outcome).toEqual({
			kind: 'planned',
			plan: {
				day: TODAY,
				units: [
					{
						unitId,
						block: expect.stringMatching(/^GANDA-/),
						number: '7',
						groups: [
							{
								kept: [
									{
										occupancyId: kept,
										role: OCCUPANCY_ROLE.owner,
										startedOn: '2026-01-01',
										endedOn: null,
										isPrimaryOccupant: false
									}
								],
								deleted: [
									{
										occupancyId: duplicate,
										role: OCCUPANCY_ROLE.tenant,
										startedOn: '2026-02-01',
										endedOn: null,
										isPrimaryOccupant: false
									}
								]
							}
						],
						moves: []
					}
				]
			}
		});
		// Everything the script prints comes out of this object.
		const printable = JSON.stringify(outcome);
		expect(printable).not.toContain(person.name);
		expect(printable).not.toContain(person.email);
		expect(printable).not.toContain(person.residentId);
	});

	it('deletes exactly the planned rows: a pair, a three-row chain, a pair sharing its boundary day, and no consecutive pair', async () => {
		// A pair: the row recorded first is kept even though the other one starts earlier.
		const pairUnit = await insertUnit();
		const pairPerson = await insertResident();
		const pairFirst = await insertOccupancy(pairUnit, pairPerson, {
			startedOn: '2026-02-01',
			recorded: 1
		});
		const pairSecond = await insertOccupancy(pairUnit, pairPerson, {
			startedOn: '2026-01-01',
			recorded: 2
		});

		// A chain: the middle row overlaps both ends, and the ends do not overlap each other. Rule 2
		// compares with the rows kept, not with the row before, so the third row survives.
		const chainUnit = await insertUnit();
		const chainPerson = await insertResident();
		const chainFirst = await insertOccupancy(chainUnit, chainPerson, {
			startedOn: '2026-01-01',
			endedOn: '2026-03-31',
			recorded: 3
		});
		const chainMiddle = await insertOccupancy(chainUnit, chainPerson, {
			startedOn: '2026-03-15',
			endedOn: '2026-06-30',
			recorded: 4
		});
		const chainLast = await insertOccupancy(chainUnit, chainPerson, {
			startedOn: '2026-06-15',
			recorded: 5
		});

		// Sharing only the boundary day still overlaps: the last day is a day lived there.
		const boundaryUnit = await insertUnit();
		const boundaryPerson = await insertResident();
		const boundaryFirst = await insertOccupancy(boundaryUnit, boundaryPerson, {
			startedOn: '2026-01-01',
			endedOn: '2026-03-31',
			recorded: 6
		});
		const boundarySecond = await insertOccupancy(boundaryUnit, boundaryPerson, {
			startedOn: '2026-03-31',
			recorded: 7
		});

		// One stay ending the day before the next begins is two stays, not a duplicate.
		const consecutiveUnit = await insertUnit();
		const consecutivePerson = await insertResident();
		const consecutiveFirst = await insertOccupancy(consecutiveUnit, consecutivePerson, {
			startedOn: '2026-01-01',
			endedOn: '2026-03-31',
			recorded: 8
		});
		const consecutiveSecond = await insertOccupancy(consecutiveUnit, consecutivePerson, {
			startedOn: '2026-04-01',
			recorded: 9
		});

		const every = [
			pairFirst,
			pairSecond,
			chainFirst,
			chainMiddle,
			chainLast,
			boundaryFirst,
			boundarySecond,
			consecutiveFirst,
			consecutiveSecond
		];
		const deleted = [pairSecond, chainMiddle, boundarySecond].sort();
		const before = await tableSizes();

		const outcome = await run('apply');

		expect(outcome.kind).toBe('applied');
		expect(plannedDeletions(outcome)).toEqual(deleted);
		expect(await surviving(every)).toEqual(every.filter((id) => !deleted.includes(id)).sort());
		expect((await tableSizes()).occupancies).toBe(before.occupancies - deleted.length);
		if (outcome.kind !== 'applied') {
			throw new Error(`Expected the plan to be applied, not ${outcome.kind}.`);
		}
		expect(outcome.plan.units.map((unit) => unit.unitId).sort()).toEqual(
			[pairUnit, chainUnit, boundaryUnit].sort()
		);
		const chain = outcome.plan.units.find((unit) => unit.unitId === chainUnit);
		expect(chain?.groups.map((group) => group.kept.map((row) => row.occupancyId))).toEqual([
			[chainFirst, chainLast]
		]);
	});

	it('breaks a tie on the recording instant by id, whatever order the rows were inserted in', async () => {
		const unitId = await insertUnit();
		const person = await insertResident();
		const [lower, higher] = [randomUUID(), randomUUID()].sort();
		await insertOccupancy(unitId, person, { id: higher, startedOn: '2026-01-01', recorded: 1 });
		await insertOccupancy(unitId, person, { id: lower, startedOn: '2026-01-01', recorded: 1 });

		const outcome = await run('apply');

		expect(plannedDeletions(outcome)).toEqual([higher]);
		expect(await surviving([lower, higher])).toEqual([lower]);
	});

	it('leaves the same person in another unit alone, and other people in the same unit', async () => {
		const unitId = await insertUnit();
		const otherUnitId = await insertUnit();
		const person = await insertResident();
		const housemate = await insertResident();
		const kept = await insertOccupancy(unitId, person, { startedOn: '2026-01-01', recorded: 1 });
		const duplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			recorded: 2
		});
		// The same days as both rows above, in a different house: an owner of two houses.
		const elsewhere = await insertOccupancy(otherUnitId, person, {
			startedOn: '2026-01-01',
			recorded: 3
		});
		// The same days in the same house, by somebody else: a household, not a duplicate.
		const household = await insertOccupancy(unitId, housemate, {
			startedOn: '2026-01-01',
			recorded: 4
		});

		const outcome = await run('apply');

		expect(plannedDeletions(outcome)).toEqual([duplicate]);
		expect(await surviving([kept, duplicate, elsewhere, household])).toEqual(
			[kept, elsewhere, household].sort()
		);
		if (outcome.kind !== 'applied') {
			throw new Error(`Expected the plan to be applied, not ${outcome.kind}.`);
		}
		expect(outcome.plan.units.map((unit) => unit.unitId)).toEqual([unitId]);
		expect(outcome.plan.units[0].groups).toHaveLength(1);
	});

	it('moves the marker from a deleted duplicate whose last day is today or not set, and not from one already past', async () => {
		const person = await insertResident();

		const endsTodayUnit = await insertUnit();
		const endsTodayKept = await insertOccupancy(endsTodayUnit, person, {
			startedOn: '2026-01-01',
			recorded: 1
		});
		const endsToday = await insertOccupancy(endsTodayUnit, person, {
			startedOn: '2026-01-01',
			endedOn: TODAY,
			isPrimaryOccupant: true,
			recorded: 2
		});

		const openUnit = await insertUnit();
		const openKept = await insertOccupancy(openUnit, person, {
			startedOn: '2026-01-01',
			recorded: 3
		});
		const open = await insertOccupancy(openUnit, person, {
			startedOn: '2026-02-01',
			isPrimaryOccupant: true,
			recorded: 4
		});

		const pastUnit = await insertUnit();
		const pastKept = await insertOccupancy(pastUnit, person, {
			startedOn: '2026-01-01',
			recorded: 5
		});
		const past = await insertOccupancy(pastUnit, person, {
			startedOn: '2026-01-01',
			endedOn: YESTERDAY,
			isPrimaryOccupant: true,
			recorded: 6
		});

		const outcome = await run('apply');

		expect(outcome.kind).toBe('applied');
		expect(plannedMoves(outcome).sort()).toEqual(
			[`${endsToday} -> ${endsTodayKept}`, `${open} -> ${openKept}`].sort()
		);
		expect(await surviving([endsToday, open, past])).toEqual([]);
		expect(await isMarked(endsTodayKept)).toBe(true);
		expect(await isMarked(openKept)).toBe(true);
		expect(await isMarked(pastKept)).toBe(false);

		const [marked] = await auditEntriesFor(testDb.db, endsTodayKept);
		expect(marked).toMatchObject({
			actorId: DATA_FIX_ACTOR_ID,
			action: PRIMARY_OCCUPANT_MARKED_ACTION,
			targetId: endsTodayKept,
			before: { occupancyId: endsToday, residentId: person.residentId },
			after: { occupancyId: endsTodayKept, residentId: person.residentId, unitId: endsTodayUnit }
		});
		expect(await auditEntriesFor(testDb.db, pastKept)).toHaveLength(0);
	});

	it('hands the marker to the kept stay still running when a duplicate bridges it and a finished one', async () => {
		const unitId = await insertUnit();
		const person = await insertResident();
		const finished = await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			endedOn: '2026-03-31',
			recorded: 1
		});
		const bridge = await insertOccupancy(unitId, person, {
			startedOn: '2026-03-15',
			isPrimaryOccupant: true,
			recorded: 2
		});
		const running = await insertOccupancy(unitId, person, {
			startedOn: '2026-06-15',
			recorded: 3
		});

		const outcome = await run('apply');

		expect(plannedDeletions(outcome)).toEqual([bridge]);
		expect(plannedMoves(outcome)).toEqual([`${bridge} -> ${running}`]);
		expect(await isMarked(running)).toBe(true);
		expect(await isMarked(finished)).toBe(false);
	});

	it('leaves a marker already on the kept row where it is, and writes no marking entry for it', async () => {
		// Two markers that have not passed in one unit, on one person's duplicate rows: the partial
		// index only sees the one with no last day. Deleting the duplicate is what repairs it.
		const unitId = await insertUnit();
		const person = await insertResident();
		const kept = await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			isPrimaryOccupant: true,
			recorded: 1
		});
		const duplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			endedOn: LATER_THIS_YEAR,
			isPrimaryOccupant: true,
			recorded: 2
		});

		const outcome = await run('apply');

		expect(outcome.kind).toBe('applied');
		expect(plannedMoves(outcome)).toEqual([]);
		expect(await surviving([kept, duplicate])).toEqual([kept]);
		expect(await isMarked(kept)).toBe(true);
		expect(await auditEntriesFor(testDb.db, kept)).toHaveLength(0);
		expect(await auditEntriesFor(testDb.db, duplicate)).toHaveLength(1);
	});

	it('refuses the whole plan, writing nothing, when a unit would keep two markers that have not passed', async () => {
		const unitId = await insertUnit();
		const person = await insertResident();
		const housemate = await insertResident();
		const kept = await insertOccupancy(unitId, person, { startedOn: '2026-01-01', recorded: 1 });
		const duplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			endedOn: LATER_THIS_YEAR,
			isPrimaryOccupant: true,
			recorded: 2
		});
		const housemateMarked = await insertOccupancy(unitId, housemate, {
			startedOn: '2026-01-01',
			isPrimaryOccupant: true,
			recorded: 3
		});
		// A plain duplicate in another house, which nothing would stop on its own: all or nothing.
		const otherUnitId = await insertUnit();
		const other = await insertResident();
		const otherKept = await insertOccupancy(otherUnitId, other, {
			startedOn: '2026-01-01',
			recorded: 4
		});
		const otherDuplicate = await insertOccupancy(otherUnitId, other, {
			startedOn: '2026-01-01',
			recorded: 5
		});
		const before = await tableSizes();
		const expectedConflicts = [
			{
				unitId,
				block: expect.stringMatching(/^GANDA-/),
				number: '7',
				occupancyIds: [kept, housemateMarked]
			}
		];

		const dryRun = await run('dryRun');
		const applied = await run('apply');

		for (const outcome of [dryRun, applied]) {
			expect(outcome.kind).toBe('refused');
			if (outcome.kind === 'refused') {
				expect(outcome.conflicts).toEqual(expectedConflicts);
				expect(plannedDeletions(outcome)).toEqual([duplicate, otherDuplicate].sort());
			}
		}
		expect(await tableSizes()).toEqual(before);
		expect(await surviving([kept, duplicate, housemateMarked, otherKept, otherDuplicate])).toEqual(
			[kept, duplicate, housemateMarked, otherKept, otherDuplicate].sort()
		);
		expect(await isMarked(kept)).toBe(false);
	});

	it('judges only the units it changes: a unit without a duplicate keeps whatever markers it has', async () => {
		const untouchedUnit = await insertUnit();
		const first = await insertResident();
		const second = await insertResident();
		const markedOpen = await insertOccupancy(untouchedUnit, first, {
			startedOn: '2026-01-01',
			isPrimaryOccupant: true,
			recorded: 1
		});
		const markedEnding = await insertOccupancy(untouchedUnit, second, {
			startedOn: '2026-01-01',
			endedOn: LATER_THIS_YEAR,
			isPrimaryOccupant: true,
			recorded: 2
		});
		const unitId = await insertUnit();
		const person = await insertResident();
		await insertOccupancy(unitId, person, { startedOn: '2026-01-01', recorded: 3 });
		const duplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			recorded: 4
		});

		const outcome = await run('apply');

		expect(outcome.kind).toBe('applied');
		expect(plannedDeletions(outcome)).toEqual([duplicate]);
		expect(await isMarked(markedOpen)).toBe(true);
		expect(await isMarked(markedEnding)).toBe(true);
	});

	it('records every deletion, with the whole row, and every marker move, all under system:data-fix', async () => {
		const unitId = await insertUnit();
		const person = await insertResident();
		const kept = await insertOccupancy(unitId, person, { startedOn: '2026-01-01', recorded: 1 });
		const markedDuplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-02-01',
			endedOn: LATER_THIS_YEAR,
			isPrimaryOccupant: true,
			role: OCCUPANCY_ROLE.tenant,
			recorded: 2
		});
		const plainDuplicate = await insertOccupancy(unitId, person, {
			startedOn: '2026-03-01',
			recorded: 3
		});
		const rowsBefore = await testDb.db
			.select()
			.from(occupancies)
			.where(inArray(occupancies.id, [markedDuplicate, plainDuplicate]));
		const before = await tableSizes();

		await run('apply');

		// Two deletions and one move: three entries, and nothing else.
		expect((await tableSizes()).auditLog).toBe(before.auditLog + 3);
		const written = await testDb.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.actorId, DATA_FIX_ACTOR_ID),
					inArray(auditLog.targetId, [kept, markedDuplicate, plainDuplicate])
				)
			);
		expect(written).toHaveLength(3);

		for (const row of rowsBefore) {
			const entries = await auditEntriesFor(testDb.db, row.id);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				actorId: DATA_FIX_ACTOR_ID,
				action: OCCUPANCY_DUPLICATE_DELETED_ACTION,
				targetId: row.id,
				after: null
			});
			expect(entries[0].before).toEqual({ ...row, createdAt: row.createdAt.toISOString() });
			expect(entries[0].occurredAt.getTime()).toBe(Date.parse(NOW));
		}

		const moves = await auditEntriesFor(testDb.db, kept);
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({
			actorId: DATA_FIX_ACTOR_ID,
			action: PRIMARY_OCCUPANT_MARKED_ACTION,
			before: { occupancyId: markedDuplicate, residentId: person.residentId },
			after: { occupancyId: kept, residentId: person.residentId, unitId }
		});
	});

	it('finds nothing and writes nothing on a second run, on the same day or a later one', async () => {
		const unitId = await insertUnit();
		const person = await insertResident();
		await insertOccupancy(unitId, person, { startedOn: '2026-01-01', recorded: 1 });
		await insertOccupancy(unitId, person, {
			startedOn: '2026-01-01',
			endedOn: TODAY,
			isPrimaryOccupant: true,
			recorded: 2
		});
		const chainUnit = await insertUnit();
		await insertOccupancy(chainUnit, person, {
			startedOn: '2026-01-01',
			endedOn: '2026-03-31',
			recorded: 3
		});
		await insertOccupancy(chainUnit, person, { startedOn: '2026-03-15', recorded: 4 });
		await insertOccupancy(chainUnit, person, { startedOn: '2026-06-15', recorded: 5 });
		expect((await run('apply')).kind).toBe('applied');
		const afterFirst = await tableSizes();

		const secondDryRun = await run('dryRun');
		const secondApply = await run('apply');
		const nextYear = await run('apply', '2027-09-28T05:00:00.000Z');

		expect(secondDryRun).toEqual({ kind: 'clean', day: TODAY });
		expect(secondApply).toEqual({ kind: 'clean', day: TODAY });
		expect(nextYear).toEqual({ kind: 'clean', day: '2027-09-28' });
		expect(await tableSizes()).toEqual(afterFirst);
	});
});
