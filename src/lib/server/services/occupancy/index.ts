import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { occupancies, type Occupancy, type OccupancyRole } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { UnitNotFoundError } from '../unit';
import { currentDay, isStillRunningOn, stillRunningOn, type DateRange } from './visibility';

/**
 * Masa Huni: who lives in which house, for which stretch of time, and which one of them the house's
 * invoices are addressed to. `src/lib/server/db/schema/occupancy.ts` holds the table's own
 * decisions; this module holds the ones that need more than a constraint.
 *
 * `ACTION.manageOccupancies` in `src/lib/server/authz.ts` is granted to `superuser` alone, so every
 * write below is, today, a superuser-only write — a fact about the permission table, not something
 * re-decided here. `occupiedUnitsForUser` is the exception and is guarded the other way, by row
 * ownership, exactly as `src/lib/server/services/resident/profile.ts` settled: a resident reading
 * their own house is not a right some residents have and others do not.
 *
 * ## The future-dated `ended_on` gap, and how it is closed here
 *
 * `occupancies_primary_occupant_unique` reads "still running" as `ended_on is null`. Writing an end
 * date that has not arrived yet therefore frees the primary-occupant slot early, and the database
 * would accept a second primary occupant for days the first one still covers. The schema records
 * why the exclusion constraint that would close it is refused — it needs `btree_gist`, which is
 * database-wide while the test harness migrates one schema per file in parallel — and says the
 * service layer owns the case. This is that service layer.
 *
 * It is closed with **a row lock, not a read**. Every write that can change who holds the slot takes
 * `select … from units where id = … for update` on the unit first, and only then looks for an
 * overlapping primary occupancy. The lock is what makes the look-then-write safe: two requests
 * arriving together are serialised on the unit row, so the second one reads the first one's
 * committed row instead of the empty result it would have read a moment earlier.
 * `tests/unit/occupancy-service.test.ts` proves exactly that, with a second connection holding an
 * open transaction — a pair of overlapping calls through `Promise.allSettled` would prove nothing,
 * because nothing makes one of them land inside the other's window.
 *
 * The database index stays the rule for the ordinary `ended_on is null` case, and nothing here
 * replaces it; this only covers what it cannot see.
 *
 * ## Two questions that look like one
 *
 * "Is the primary-occupant slot filled?" and "is this person living here now?" are different
 * questions and take different predicates. The first is `ended_on is null`, because that is what
 * `occupancies_primary_occupant_unique` means; the second is `isStillRunningOn` in `./visibility.ts`,
 * `ended_on is null or ended_on >= today`. Answering the second with the first is what made a
 * resident with a future end date read as having moved out already — see
 * `summarizeActiveOccupancies` for the same split on the admin side. Everything in this module that
 * says "now" uses the second one and takes a `Clock` to get the day; `assertPrimarySlotFree` uses
 * neither, because an overlap between two stays is a question about their own days and never about
 * today's.
 */

/** The audit log's `action` for a newly recorded occupancy. */
export const OCCUPANCY_RECORDED_ACTION = 'occupancy_recorded';
/** The audit log's `action` for an occupancy that was given an end date. */
export const OCCUPANCY_ENDED_ACTION = 'occupancy_ended';
/** The audit log's `action` for an occupancy that became the unit's primary occupant. */
export const PRIMARY_OCCUPANT_MARKED_ACTION = 'occupancy_primary_occupant_marked';

/** A calendar day as the schema stores it. Anchored at both ends, so nothing longer can slip past. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Thrown when an occupancy id names no row. Like `UnitNotFoundError`, a caller can only reach this
 * with an id no screen ever rendered, so a route answers it with a 404 rather than a rejected form.
 */
export class OccupancyNotFoundError extends Error {
	override readonly name = 'OccupancyNotFoundError';

	/** The id that named no occupancy. */
	readonly occupancyId: string;

	constructor(occupancyId: string) {
		super(`No occupancy exists with id "${occupancyId}".`);
		this.occupancyId = occupancyId;
	}
}

/** Thrown when a resident id names no `residents` row. */
export class ResidentNotFoundError extends Error {
	override readonly name = 'ResidentNotFoundError';

	/** The id that named no resident. */
	readonly residentId: string;

	constructor(residentId: string) {
		super(`No resident exists with id "${residentId}".`);
		this.residentId = residentId;
	}
}

/**
 * Thrown when an occupancy would end before it started. The database's
 * `occupancies_date_order_check` refuses the same thing; this exists so that the service answers a
 * broken form with a named refusal a route can turn into `fail(400, …)`, rather than letting a raw
 * `23514` out — `spec-warga-unit-v1.md`'s testing decisions ask for exactly that.
 *
 * The same day is allowed: someone can move in and out on the 3rd. The rule is "earlier than", not
 * "different from".
 */
export class OccupancyDateOrderError extends Error {
	override readonly name = 'OccupancyDateOrderError';

	/** The day the occupancy started. */
	readonly startedOn: string;
	/** The day it was asked to end on, which is earlier than `startedOn`. */
	readonly endedOn: string;

	constructor(startedOn: string, endedOn: string) {
		super(`An occupancy that started on ${startedOn} cannot end on ${endedOn}.`);
		this.startedOn = startedOn;
		this.endedOn = endedOn;
	}
}

/**
 * Thrown when marking a primary occupant would give a unit two of them over days they both cover.
 *
 * It names who holds the slot today, because that is what the superuser reading the refusal has to
 * act on — `spec-warga-unit-v1.md` asks for "galat bernama yang menyebut siapa penanggung jawab yang
 * sekarang", and an error saying only "already taken" sends them back to the history screen to find
 * out by whom.
 */
export class PrimaryOccupantConflictError extends Error {
	override readonly name = 'PrimaryOccupantConflictError';

	/** The house that already has a primary occupant over these days. */
	readonly unitId: string;
	/** The occupancy currently holding the slot. */
	readonly occupancyId: string;
	/** The resident holding it. */
	readonly residentId: string;
	/** That resident's name, for the message a superuser reads. */
	readonly residentName: string;
	/** The day their occupancy started. */
	readonly startedOn: string;
	/** The day it ends, or `null` while it is still running. */
	readonly endedOn: string | null;

	constructor(unitId: string, holder: PrimaryOccupantHolder) {
		super(
			`Unit "${unitId}" already has a primary occupant over those days: "${holder.residentName}", from ${holder.startedOn} to ${holder.endedOn ?? 'further notice'}.`
		);
		this.unitId = unitId;
		this.occupancyId = holder.occupancyId;
		this.residentId = holder.residentId;
		this.residentName = holder.residentName;
		this.startedOn = holder.startedOn;
		this.endedOn = holder.endedOn;
	}
}

/** Whoever currently holds a unit's primary-occupant slot, as the refusal above reports them. */
export interface PrimaryOccupantHolder {
	readonly occupancyId: string;
	readonly residentId: string;
	readonly residentName: string;
	readonly startedOn: string;
	readonly endedOn: string | null;
}

/** One line of a unit's occupancy history, with the occupant named rather than only identified. */
export interface OccupancyRecord {
	readonly occupancyId: string;
	readonly unitId: string;
	readonly residentId: string;
	/** The occupant's name, read off `user` — `residents` deliberately does not copy it. */
	readonly residentName: string;
	readonly role: OccupancyRole;
	readonly startedOn: string;
	readonly endedOn: string | null;
	/**
	 * Whether this person is living in the house today — `ended_on is null or ended_on >= today`, not
	 * `ended_on is null`. A stay with an end date that has not arrived yet is still a stay, and the
	 * screen's controls for ending it or making it the primary occupant have to stay reachable.
	 */
	readonly isRunning: boolean;
	readonly isPrimaryOccupant: boolean;
}

/** Who is asking, and which stay they are asking to record. */
export interface RecordOccupancyRequest {
	/** The user making the change. Checked against `ACTION.manageOccupancies` before anything else. */
	readonly actorId: string;
	readonly unitId: string;
	readonly residentId: string;
	readonly role: OccupancyRole;
	/** The first day of the stay, as `YYYY-MM-DD`. */
	readonly startedOn: string;
	/** `true` also marks this stay as the unit's primary occupant. Defaults to `false`. */
	readonly isPrimaryOccupant?: boolean;
}

/**
 * Records a new, still-running occupancy. There is no end date here on purpose: a stay that is over
 * is recorded and then ended, so that the end always goes through `endOccupancy`'s rules.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `startedOn` is not a `YYYY-MM-DD` day.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 * @throws {ResidentNotFoundError} when `residentId` names no resident.
 * @throws {PrimaryOccupantConflictError} when `isPrimaryOccupant` is asked for and someone else
 *   already holds the slot over overlapping days.
 */
export async function recordOccupancy(
	db: Database,
	clock: Clock,
	request: RecordOccupancyRequest
): Promise<Occupancy> {
	assertCalendarDay(request.startedOn, 'startedOn');
	const isPrimaryOccupant = request.isPrimaryOccupant ?? false;

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageOccupancies);
		await lockUnit(transaction, request.unitId);
		await assertResidentExists(transaction, request.residentId);

		if (isPrimaryOccupant) {
			await assertPrimarySlotFree(transaction, request.unitId, {
				from: request.startedOn,
				to: null
			});
		}

		const [row] = await transaction
			.insert(occupancies)
			.values({
				unitId: request.unitId,
				residentId: request.residentId,
				role: request.role,
				startedOn: request.startedOn,
				endedOn: null,
				isPrimaryOccupant,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: OCCUPANCY_RECORDED_ACTION,
			targetId: row.id,
			after: {
				unitId: row.unitId,
				residentId: row.residentId,
				role: row.role,
				startedOn: row.startedOn,
				isPrimaryOccupant: row.isPrimaryOccupant
			}
		});

		return row;
	});
}

/** Who is asking, which stay they are ending, and on which day. */
export interface EndOccupancyRequest {
	/** The user making the change. Checked against `ACTION.manageOccupancies` before anything else. */
	readonly actorId: string;
	readonly occupancyId: string;
	/** The last day of the stay, as `YYYY-MM-DD`. May be the day it started, but not earlier. */
	readonly endedOn: string;
}

/**
 * Ends an occupancy, or corrects the day an already-ended one ended on.
 *
 * Ending the primary occupant's stay deliberately leaves the flag where it is — the schema keeps it
 * as history so that "who was the primary occupant in March" still has an answer — and leaves the
 * unit with no *running* primary occupant, which is what makes it show up on the admin list as
 * something to sort out.
 *
 * A request that asks for the end date the occupancy already has changes nothing and writes no audit
 * row, the same idiom `deactivateUnit` follows.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `endedOn` is not a `YYYY-MM-DD` day.
 * @throws {OccupancyNotFoundError} when `occupancyId` names no occupancy.
 * @throws {OccupancyDateOrderError} when `endedOn` is earlier than the day the stay started.
 * @throws {PrimaryOccupantConflictError} when moving a primary occupant's end date later would make
 *   the unit's days overlap another primary occupant's.
 */
export async function endOccupancy(
	db: Database,
	clock: Clock,
	request: EndOccupancyRequest
): Promise<Occupancy> {
	assertCalendarDay(request.endedOn, 'endedOn');

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageOccupancies);
		const existing = await lockUnitOfOccupancy(transaction, request.occupancyId);

		if (request.endedOn < existing.startedOn) {
			throw new OccupancyDateOrderError(existing.startedOn, request.endedOn);
		}
		if (existing.endedOn === request.endedOn) {
			return existing;
		}
		if (existing.isPrimaryOccupant) {
			await assertPrimarySlotFree(
				transaction,
				existing.unitId,
				{ from: existing.startedOn, to: request.endedOn },
				existing.id
			);
		}

		const [row] = await transaction
			.update(occupancies)
			.set({ endedOn: request.endedOn })
			.where(eq(occupancies.id, existing.id))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: OCCUPANCY_ENDED_ACTION,
			targetId: row.id,
			before: { endedOn: existing.endedOn },
			after: { endedOn: row.endedOn }
		});

		return row;
	});
}

/** Who is asking, and which stay they are marking as the house's primary occupant. */
export interface SetPrimaryOccupantRequest {
	/** The user making the change. Checked against `ACTION.manageOccupancies` before anything else. */
	readonly actorId: string;
	readonly occupancyId: string;
}

/**
 * Marks an occupancy as the one the house's invoices are addressed to.
 *
 * An occupancy that already carries the flag is left alone, with no audit row.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {OccupancyNotFoundError} when `occupancyId` names no occupancy.
 * @throws {PrimaryOccupantConflictError} when another occupancy of the same unit already holds the
 *   slot over days this one covers — including one whose end date has been written but has not
 *   arrived yet, which is the case the database index cannot see.
 */
export async function setPrimaryOccupant(
	db: Database,
	clock: Clock,
	request: SetPrimaryOccupantRequest
): Promise<Occupancy> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageOccupancies);
		const existing = await lockUnitOfOccupancy(transaction, request.occupancyId);

		if (existing.isPrimaryOccupant) {
			return existing;
		}

		await assertPrimarySlotFree(
			transaction,
			existing.unitId,
			{ from: existing.startedOn, to: existing.endedOn },
			existing.id
		);

		const [row] = await transaction
			.update(occupancies)
			.set({ isPrimaryOccupant: true })
			.where(eq(occupancies.id, existing.id))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: PRIMARY_OCCUPANT_MARKED_ACTION,
			targetId: row.id,
			before: { isPrimaryOccupant: existing.isPrimaryOccupant },
			after: { isPrimaryOccupant: row.isPrimaryOccupant, unitId: row.unitId }
		});

		return row;
	});
}

/**
 * Every occupancy of one unit, newest stay first — the history the admin screen shows.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listUnitOccupancies(
	db: DatabaseWriter,
	clock: Clock,
	actorId: string,
	unitId: string
): Promise<readonly OccupancyRecord[]> {
	await requirePermission(db, actorId, ACTION.manageOccupancies);

	const today = currentDay(clock);
	const rows = await db
		.select(OCCUPANCY_RECORD_COLUMNS)
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(occupancies.unitId, unitId))
		.orderBy(desc(occupancies.startedOn), desc(occupancies.createdAt));

	return rows.map((row) => ({ ...row, isRunning: isStillRunningOn(row.endedOn, today) }));
}

/** One person who can be attached to a house, for the picker on the admin form. */
export interface AssignableResident {
	readonly residentId: string;
	readonly name: string;
	readonly email: string;
}

/**
 * Every resident the complex has a record of, by name — what the "record a stay" form offers.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listAssignableResidents(
	db: DatabaseWriter,
	actorId: string
): Promise<readonly AssignableResident[]> {
	await requirePermission(db, actorId, ACTION.manageOccupancies);

	return db
		.select({ residentId: residents.id, name: user.name, email: user.email })
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.orderBy(asc(user.name));
}

/** One other person recorded as living in the same house right now. */
export interface FellowOccupant {
	readonly residentId: string;
	readonly name: string;
	readonly role: OccupancyRole;
	readonly isPrimaryOccupant: boolean;
}

/** One stay of the signed-in resident's own, with the house it is in. */
export interface OwnOccupancy {
	readonly occupancyId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly role: OccupancyRole;
	readonly startedOn: string;
	readonly endedOn: string | null;
	/**
	 * Whether this resident is living in that house today. An end date that has been written but has
	 * not arrived leaves this `true`: they still live there until that day comes, and a screen reading
	 * `endedOn === null` instead would tell them their stay was over while they were standing in the
	 * house.
	 */
	readonly isRunning: boolean;
	readonly isPrimaryOccupant: boolean;
	/**
	 * Everyone recorded as living in that house today, this resident included — empty once their own
	 * stay is over. Who lives there *now* is not part of what someone who has moved out may see; their
	 * own stay is their own data and stays visible, the current household is not. That is
	 * `./visibility.ts`'s rule applied to a screen rather than to a query.
	 */
	readonly occupants: readonly FellowOccupant[];
}

/**
 * Every house `userId` is recorded as living, or having lived, in — the `/my-unit` screen's whole
 * load.
 *
 * Guarded by row ownership rather than by a `PERMISSIONS` action, the pattern
 * `src/lib/server/services/resident/profile.ts` settled: the caller's own account is the only key
 * this function takes, so there is no id a caller could swap for someone else's. An account with no
 * `residents` row gets an empty list — an expected state until #20 and #21 land, not an error.
 */
export async function occupiedUnitsForUser(
	db: DatabaseWriter,
	clock: Clock,
	userId: string
): Promise<readonly OwnOccupancy[]> {
	const today = currentDay(clock);
	const stays = await db
		.select({
			occupancyId: occupancies.id,
			unitId: occupancies.unitId,
			block: units.block,
			number: units.number,
			role: occupancies.role,
			startedOn: occupancies.startedOn,
			endedOn: occupancies.endedOn,
			isPrimaryOccupant: occupancies.isPrimaryOccupant
		})
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.innerJoin(units, eq(units.id, occupancies.unitId))
		.where(eq(residents.userId, userId))
		.orderBy(desc(occupancies.startedOn), desc(occupancies.createdAt));

	const running = stays.filter((stay) => isStillRunningOn(stay.endedOn, today));
	const occupantsByUnit = await currentOccupantsOf(
		db,
		today,
		running.map((stay) => stay.unitId)
	);

	return stays.map((stay) => {
		const isRunning = isStillRunningOn(stay.endedOn, today);
		return {
			...stay,
			isRunning,
			occupants: isRunning ? (occupantsByUnit.get(stay.unitId) ?? []) : []
		};
	});
}

/** Everyone living in each unit in `unitIds` on `today`, in one query. */
async function currentOccupantsOf(
	db: DatabaseWriter,
	today: string,
	unitIds: readonly string[]
): Promise<ReadonlyMap<string, readonly FellowOccupant[]>> {
	const byUnit = new Map<string, FellowOccupant[]>();
	if (unitIds.length === 0) {
		return byUnit;
	}

	const rows = await db
		.select({
			unitId: occupancies.unitId,
			residentId: residents.id,
			name: user.name,
			role: occupancies.role,
			isPrimaryOccupant: occupancies.isPrimaryOccupant
		})
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(and(inArray(occupancies.unitId, unitIds), stillRunningOn(occupancies.endedOn, today)))
		.orderBy(asc(user.name));

	for (const { unitId, ...occupant } of rows) {
		const existing = byUnit.get(unitId);
		if (existing) {
			existing.push(occupant);
			continue;
		}
		byUnit.set(unitId, [occupant]);
	}
	return byUnit;
}

/** The columns every occupancy-history read selects, written once so two reads cannot drift. */
const OCCUPANCY_RECORD_COLUMNS = {
	occupancyId: occupancies.id,
	unitId: occupancies.unitId,
	residentId: residents.id,
	residentName: user.name,
	role: occupancies.role,
	startedOn: occupancies.startedOn,
	endedOn: occupancies.endedOn,
	isPrimaryOccupant: occupancies.isPrimaryOccupant
};

/**
 * Takes the unit's row lock, so that every primary-occupant decision about one house happens one at
 * a time. Also proves the unit exists, which is why nothing else looks it up first.
 *
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 */
async function lockUnit(transaction: Transaction, unitId: string): Promise<void> {
	const [row] = await transaction
		.select({ id: units.id })
		.from(units)
		.where(eq(units.id, unitId))
		.limit(1)
		.for('update');
	if (!row) {
		throw new UnitNotFoundError(unitId);
	}
}

/**
 * Finds the occupancy, takes its unit's row lock, and reads the occupancy again behind that lock.
 *
 * The second read is the point. The first one only says which unit to lock; by the time the lock is
 * granted another request may have committed a change to the very row this one is about, and acting
 * on the values read before waiting is how the check this lock exists for gets skipped.
 *
 * @throws {OccupancyNotFoundError} when `occupancyId` names no occupancy.
 */
async function lockUnitOfOccupancy(
	transaction: Transaction,
	occupancyId: string
): Promise<Occupancy> {
	const [before] = await transaction
		.select({ unitId: occupancies.unitId })
		.from(occupancies)
		.where(eq(occupancies.id, occupancyId))
		.limit(1);
	if (!before) {
		throw new OccupancyNotFoundError(occupancyId);
	}

	await lockUnit(transaction, before.unitId);

	const [current] = await transaction
		.select()
		.from(occupancies)
		.where(eq(occupancies.id, occupancyId))
		.limit(1);
	if (!current) {
		throw new OccupancyNotFoundError(occupancyId);
	}
	return current;
}

/**
 * Throws unless nobody else is the unit's primary occupant over any of `range`'s days.
 *
 * Only correct while the unit's row lock is held — see this module's doc comment. `exceptId` leaves
 * the occupancy being changed out of its own comparison.
 *
 * @throws {PrimaryOccupantConflictError} naming whoever holds the slot.
 */
async function assertPrimarySlotFree(
	transaction: Transaction,
	unitId: string,
	range: DateRange,
	exceptId?: string
): Promise<void> {
	const [holder] = await transaction
		.select({
			occupancyId: occupancies.id,
			residentId: residents.id,
			residentName: user.name,
			startedOn: occupancies.startedOn,
			endedOn: occupancies.endedOn
		})
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(
			and(
				eq(occupancies.unitId, unitId),
				eq(occupancies.isPrimaryOccupant, true),
				exceptId ? ne(occupancies.id, exceptId) : undefined,
				// The existing stay has not ended before this range starts …
				or(isNull(occupancies.endedOn), gte(occupancies.endedOn, range.from)),
				// … and it started before this range ends. An open-ended range has no such bound.
				range.to === null ? undefined : lte(occupancies.startedOn, range.to)
			)
		)
		.orderBy(asc(occupancies.startedOn))
		.limit(1);

	if (holder) {
		throw new PrimaryOccupantConflictError(unitId, holder);
	}
}

/**
 * Throws unless `residentId` names a row in `residents`.
 *
 * @throws {ResidentNotFoundError}
 */
async function assertResidentExists(transaction: Transaction, residentId: string): Promise<void> {
	const [row] = await transaction
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.id, residentId))
		.limit(1);
	if (!row) {
		throw new ResidentNotFoundError(residentId);
	}
}

/**
 * Throws unless `value` is a calendar day the schema's `date` columns accept.
 *
 * @throws {TypeError} naming the field, because a malformed day is a broken caller rather than a
 *   rule the complex refuses — a route reads it as a rejected form before the service is reached.
 */
function assertCalendarDay(value: string, field: string): void {
	if (!CALENDAR_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
		throw new TypeError(`${field} must be a calendar day in YYYY-MM-DD form, not "${value}".`);
	}
}
