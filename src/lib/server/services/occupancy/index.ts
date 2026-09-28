import { and, asc, desc, eq, gte, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { occupancies, type Occupancy, type OccupancyRole } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { UnitNotFoundError } from '../unit';
import { currentDay, isStillRunningOn, stillRunningOn, type OccupancyDays } from './visibility';

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
 * ## The Penanggung Jawab moves
 *
 * `docs/adr/0001-penanggung-jawab-berpindah.md` settles what the `isPrimaryOccupant` flag means: the
 * Masa Huni the house's invoice emails go to **now**. It is not an attribute of a stay's whole
 * stretch of days, and nothing here compares two stays' dates to decide who may hold it. Marking a
 * stay *moves* the flag onto it, effective at once; whoever held it before keeps living in the house
 * for as long as their own stay runs. Who held it when is the audit log's to answer — every move
 * writes one `PRIMARY_OCCUPANT_MARKED_ACTION` entry naming the previous holder and the new one — and
 * a flag left on a stay whose last day has passed is not history: nothing reads it.
 *
 * The flag only lands on a stay that is running today, `isStillRunningOn` in `./visibility.ts`. A
 * stay that has not begun would leave the house with nobody to send its invoices to until that day
 * came, so it is refused with `PrimaryOccupantNotStartedError`, and a stay that is over with
 * `PrimaryOccupantAlreadyEndedError`.
 *
 * ## The invariant, and the lock that keeps it
 *
 * **Per unit, at most one flagged row among the Masa Huni whose last day has not passed or has not
 * been written.** Call that set *S*, for one unit and one day.
 *
 * `occupancies_primary_occupant_unique` does not keep it. That index covers the flagged rows whose
 * `ended_on` is null, and a flagged row whose last day has been written but has not arrived is
 * outside it while it is still very much in *S*. The exclusion constraint that would cover every
 * flagged row is refused by the schema for `btree_gist` reasons, and would state the rule this ADR
 * rejected besides: "no two flagged stays overlap" is the old date-clash model, not "one flag among
 * the stays that have not passed". So this module keeps the invariant, and the index stays as the
 * last line of defence for the one case it can see.
 *
 * Every way a row can enter *S* is accounted for:
 *
 * 1. **The flag is set.** Only `movePrimaryOccupantMarker` below does that in this module, and it is
 *    reached from `setPrimaryOccupant` and from `recordOccupancy` asked to mark the new stay. Both
 *    take the unit's row lock — `select … from units where id = … for update`, in `lockUnit` — before
 *    they read anything the move depends on. The move then takes the flag off every row of the unit
 *    in *S* and puts it on the target, in the same transaction. The one other writer of the flag,
 *    `fixDuplicateOccupancies` in `./duplicate-fix.ts`, locks every unit first, in `id` order.
 * 2. **A flagged row is inserted.** Nothing does that: `recordOccupancy` inserts unflagged and then
 *    moves, and every other path that creates a Masa Huni — the resident import, invitations,
 *    registrations — writes `isPrimaryOccupant: false`.
 * 3. **A flagged row's last day moves from passed to not passed.** `endOccupancy` can correct the
 *    last day of a stay that is already over. It takes the stale flag off in the same statement,
 *    so a correction never brings a row back into *S* with its flag on — see that function.
 * 4. **The day changes.** Only ever forward, and a later day only takes rows out of *S*.
 *
 * **Why the lock makes the move safe.** The lock is held until the transaction ends, so two moves on
 * one unit never overlap: the second waits in `lockUnit` until the first has committed or rolled
 * back. PostgreSQL's default isolation, `read committed`, gives every statement a snapshot taken when
 * that statement starts, and the statement that takes the flag off *S* starts only after the lock was
 * granted — so its snapshot includes the first move's committed flag, and it takes that off too.
 * Without the lock the second move's update could start while the first was still open: it would
 * find the first holder's row, wait for it, re-check it after the commit and skip it, and never see
 * the row the first move had just flagged, because that row did not match when its snapshot was
 * taken. Two flags. `tests/unit/occupancy-service.test.ts` holds a second connection's transaction
 * open across the call and waits until PostgreSQL reports the call blocked on it before committing,
 * because two calls raced through `Promise.allSettled` would prove nothing: nothing makes one of them
 * land inside the other's window.
 *
 * The same argument covers the index: the move takes the flag off every row whose `ended_on` is null
 * before it sets one, so it can never trip `occupancies_primary_occupant_unique` itself.
 */

/** The audit log's `action` for a newly recorded occupancy. */
export const OCCUPANCY_RECORDED_ACTION = 'occupancy_recorded';
/** The audit log's `action` for an occupancy that was given an end date. */
export const OCCUPANCY_ENDED_ACTION = 'occupancy_ended';
/**
 * The audit log's `action` for the Penanggung Jawab flag moving onto an occupancy. The name is older
 * than the move and is kept, because rows carrying it are already stored. `before` names the stay and
 * resident that held the flag, `{ occupancyId, residentId }`, and is empty when nobody did; `after`
 * names the new holder and the unit, `{ occupancyId, residentId, unitId }`.
 */
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
 * Thrown when the Penanggung Jawab flag is asked to land on a Masa Huni that has not started yet —
 * marking one with "Jadikan penanggung jawab", or recording one with the box ticked. Both are the same
 * refusal, because both would leave the house with nobody to send its invoices to until that day
 * came: ADR 0001 lets the flag land only on a stay that is running.
 *
 * It carries the day the stay starts, because that is what the superuser reading the refusal has to
 * act on: the flag can be moved on that day.
 */
export class PrimaryOccupantNotStartedError extends Error {
	override readonly name = 'PrimaryOccupantNotStartedError';

	/** The first day of the stay, as `YYYY-MM-DD` — later than today. */
	readonly startedOn: string;

	constructor(startedOn: string) {
		super(`An occupancy starting on ${startedOn} cannot be the primary occupant before that day.`);
		this.startedOn = startedOn;
	}
}

/**
 * Thrown when the Penanggung Jawab flag is asked to land on a Masa Huni whose last day has passed.
 * The screen never offers it; a request that gets here anyway is refused rather than handing the
 * house's invoices to someone who no longer lives there.
 */
export class PrimaryOccupantAlreadyEndedError extends Error {
	override readonly name = 'PrimaryOccupantAlreadyEndedError';

	/** The last day of the stay, as `YYYY-MM-DD` — earlier than today. */
	readonly endedOn: string;

	constructor(endedOn: string) {
		super(`An occupancy whose last day was ${endedOn} cannot be the primary occupant any more.`);
		this.endedOn = endedOn;
	}
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
	 * Whether this person is living in the house today — `isStillRunningOn` in `./visibility.ts`, which
	 * reads both ends, not `ended_on is null`. A stay with an end date that has not arrived yet is still
	 * a stay, and the screen's controls for ending it or making it the primary occupant have to stay
	 * reachable. A stay whose start date is still ahead has not begun, and is not running yet.
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
	/**
	 * `true` also moves the Penanggung Jawab flag onto this stay, taking it off whoever holds it now.
	 * Only allowed when `startedOn` is today or earlier. Defaults to `false`.
	 */
	readonly isPrimaryOccupant?: boolean;
}

/**
 * Records a new occupancy with no end date. There is no end date here on purpose: a stay that is over
 * is recorded and then ended, so that the end always goes through `endOccupancy`'s rules.
 *
 * With `isPrimaryOccupant`, this records the stay and then moves the Penanggung Jawab flag onto it,
 * in the same transaction and under the same unit lock — see this module's doc comment. Whoever held
 * the flag keeps living in the house. The `OCCUPANCY_RECORDED_ACTION` entry describes the row as it
 * was inserted, unflagged, and the move writes its own `PRIMARY_OCCUPANT_MARKED_ACTION` entry after
 * it, so the audit log reads "recorded, then marked", which is what happened.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `startedOn` is not a `YYYY-MM-DD` day.
 * @throws {PrimaryOccupantNotStartedError} when `isPrimaryOccupant` is asked for and `startedOn` is
 *   later than today. Nothing is recorded.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 * @throws {ResidentNotFoundError} when `residentId` names no resident.
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
		const today = currentDay(clock);
		if (isPrimaryOccupant) {
			assertMayHoldPrimaryOccupant({ startedOn: request.startedOn, endedOn: null }, today);
		}

		await lockUnit(transaction, request.unitId);
		await assertResidentExists(transaction, request.residentId);

		const [row] = await transaction
			.insert(occupancies)
			.values({
				unitId: request.unitId,
				residentId: request.residentId,
				role: request.role,
				startedOn: request.startedOn,
				endedOn: null,
				isPrimaryOccupant: false,
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

		if (!isPrimaryOccupant) {
			return row;
		}
		return movePrimaryOccupantMarker(transaction, clock, request.actorId, row, today);
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
 * **Ending never moves the Penanggung Jawab flag.** Ending the Penanggung Jawab's stay leaves the
 * flag on it, and they stay the house's Penanggung Jawab until their last day has passed; the admin
 * screens warn about exactly that stretch, so that someone moves the flag in time. Nothing here
 * compares the stay's days with anyone else's: ADR 0001 took the date-clash check out.
 *
 * **One correction takes a flag off, and never puts one on.** A flag left on a stay whose last day
 * has passed is dead — ADR 0001: nothing reads it. Correcting that last day to today or later would
 * bring the stay back among the ones that have not passed with the old flag still on it, making its
 * resident the house's invoice recipient again without a move, without the audit entry every move
 * writes, and possibly beside the Penanggung Jawab the house has now. So that one correction takes
 * the stale flag off in the same statement, and records it in the audit entry as a change like any
 * other. It is the third case in this module's list of ways a row could enter the invariant's set.
 * If that resident is meant to hold the flag again, "Jadikan penanggung jawab" moves it to them.
 *
 * A request that asks for the end date the occupancy already has changes nothing and writes no audit
 * row, the same idiom `deactivateUnit` follows.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `endedOn` is not a `YYYY-MM-DD` day.
 * @throws {OccupancyNotFoundError} when `occupancyId` names no occupancy.
 * @throws {OccupancyDateOrderError} when `endedOn` is earlier than the day the stay started.
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

		const today = currentDay(clock);
		const dropsStaleFlag =
			existing.isPrimaryOccupant &&
			hasPassedOn(existing.endedOn, today) &&
			!hasPassedOn(request.endedOn, today);

		const [row] = await transaction
			.update(occupancies)
			.set(
				dropsStaleFlag
					? { endedOn: request.endedOn, isPrimaryOccupant: false }
					: { endedOn: request.endedOn }
			)
			.where(eq(occupancies.id, existing.id))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: OCCUPANCY_ENDED_ACTION,
			targetId: row.id,
			before: dropsStaleFlag
				? { endedOn: existing.endedOn, isPrimaryOccupant: existing.isPrimaryOccupant }
				: { endedOn: existing.endedOn },
			after: dropsStaleFlag
				? { endedOn: row.endedOn, isPrimaryOccupant: row.isPrimaryOccupant }
				: { endedOn: row.endedOn }
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
 * Makes an occupancy the house's Penanggung Jawab: moves the flag onto it from whoever holds it,
 * effective at once. The previous holder keeps living in the house for as long as their own stay
 * runs — this changes who the invoices go to, never who lives there. A housemate who has lived there
 * all along can be marked; so can someone who moved in today, on the same day the previous holder's
 * last day falls.
 *
 * An occupancy that already carries the flag is left alone, with no audit row.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {OccupancyNotFoundError} when `occupancyId` names no occupancy.
 * @throws {PrimaryOccupantNotStartedError} when the stay starts after today.
 * @throws {PrimaryOccupantAlreadyEndedError} when the stay's last day was before today.
 */
export async function setPrimaryOccupant(
	db: Database,
	clock: Clock,
	request: SetPrimaryOccupantRequest
): Promise<Occupancy> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageOccupancies);
		const target = await lockUnitOfOccupancy(transaction, request.occupancyId);

		const today = currentDay(clock);
		assertMayHoldPrimaryOccupant(target, today);
		return movePrimaryOccupantMarker(transaction, clock, request.actorId, target, today);
	});
}

/**
 * The three groups `docs/spec-penghuni-v1.md` decision 3 splits a Masa Huni list into, so that the
 * unit's own history screen and "Rumah saya" both render what the service already classified rather
 * than each reimplementing the split from `startedOn`/`endedOn` on its own — which is how the label
 * bug the spec describes came about in the first place.
 *
 * `history`'s `endedOn` is narrowed to `string`: a row only lands there once `groupByPeriod` has
 * already shown its last day is not null (see that function's doc comment), so nothing that reads
 * `history` needs an `endedOn === null` check of its own.
 */
export interface OccupancyGroups<T extends OccupancyDays> {
	/** Sedang menghuni hari ini. Penanggung Jawab first, then by start date. */
	readonly current: readonly T[];
	/** Start date after today, by start date. */
	readonly upcoming: readonly T[];
	/** Last day before today, most recent last day first. */
	readonly history: readonly (T & { readonly endedOn: string })[];
}

/**
 * Splits any list of Masa Huni-shaped rows into `current`, `upcoming` and `history` —
 * `docs/spec-penghuni-v1.md` decision 3. Shared by `listUnitOccupanciesGrouped` and
 * `occupiedUnitsForUserGrouped` so the two screens can never disagree about where one stay belongs.
 *
 * A row is `current` when `isRunning` is `true` — the same `isStillRunningOn` every other reader of
 * this module goes through. Otherwise it is `upcoming` when its start date is still ahead of `today`,
 * or else `history`: not running and not upcoming only happens when the stay has started and its
 * last day is before `today`, so `endedOn` is never null there.
 */
function groupByPeriod<
	T extends OccupancyDays & { readonly isRunning: boolean; readonly isPrimaryOccupant: boolean }
>(rows: readonly T[], today: string): OccupancyGroups<T> {
	const current: T[] = [];
	const upcoming: T[] = [];
	const history: (T & { endedOn: string })[] = [];

	for (const row of rows) {
		if (row.isRunning) {
			current.push(row);
		} else if (row.startedOn > today) {
			upcoming.push(row);
		} else {
			history.push(row as T & { endedOn: string });
		}
	}

	current.sort(
		(left, right) =>
			Number(right.isPrimaryOccupant) - Number(left.isPrimaryOccupant) ||
			compareAscending(left.startedOn, right.startedOn)
	);
	upcoming.sort((left, right) => compareAscending(left.startedOn, right.startedOn));
	history.sort((left, right) => compareDescending(left.endedOn, right.endedOn));

	return { current, upcoming, history };
}

/** `-1`, `0` or `1`, so that sorting by it puts the smaller of two strings first. */
function compareAscending(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

/**
 * Every occupancy of one unit, newest stay first.
 *
 * **Kept as a flat list on purpose.** `scripts/seed-dev.ts` reads this shape to find the first
 * Warga recorded in a house and does not care about `current`/`upcoming`/`history`. The "Penghuni"
 * screen wants that split, so it reads `listUnitOccupanciesGrouped` below instead of reclassifying
 * this list itself.
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

	return rows.map((row) => ({ ...row, isRunning: isStillRunningOn(row, today) }));
}

/**
 * `listUnitOccupancies`, split into `current`, `upcoming` and `history` —
 * `docs/spec-penghuni-v1.md` decision 3, the "Penghuni" screen's whole load. Nothing here decides how
 * each group is rendered; that is left to the page.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listUnitOccupanciesGrouped(
	db: DatabaseWriter,
	clock: Clock,
	actorId: string,
	unitId: string
): Promise<OccupancyGroups<OccupancyRecord>> {
	const rows = await listUnitOccupancies(db, clock, actorId, unitId);
	return groupByPeriod(rows, currentDay(clock));
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
	 * Whether this resident is living in that house today — `isStillRunningOn`. An end date that has
	 * been written but has not arrived leaves this `true`: they still live there until that day comes,
	 * and a screen reading `endedOn === null` instead would tell them their stay was over while they
	 * were standing in the house. A start date still ahead leaves it `false`: they have not moved in.
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
 * Every house `userId` is recorded as living, or having lived, in, newest stay first.
 *
 * Guarded by row ownership rather than by a `PERMISSIONS` action, the pattern
 * `src/lib/server/services/resident/profile.ts` settled: the caller's own account is the only key
 * this function takes, so there is no id a caller could swap for someone else's. An account with no
 * `residents` row gets an empty list — an expected state until #20 and #21 land, not an error.
 *
 * **Kept as a flat list on purpose.** `src/lib/server/services/dues/payment.ts` and
 * `src/routes/(app)/payments/+page.server.ts` both read this shape to match a payment to a resident's
 * house, and neither cares about `current`/`upcoming`/`history`. "Rumah saya" wants that split, so it
 * reads `occupiedUnitsForUserGrouped` below instead of reclassifying this list itself.
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

	const running = stays.filter((stay) => isStillRunningOn(stay, today));
	const occupantsByUnit = await currentOccupantsOf(
		db,
		today,
		running.map((stay) => stay.unitId)
	);

	return stays.map((stay) => {
		const isRunning = isStillRunningOn(stay, today);
		return {
			...stay,
			isRunning,
			occupants: isRunning ? (occupantsByUnit.get(stay.unitId) ?? []) : []
		};
	});
}

/** `occupiedUnitsForUser`, split into the same three groups a unit's own history is. */
export type OwnOccupancyGroups = OccupancyGroups<OwnOccupancy>;

/**
 * `occupiedUnitsForUser`, split into `current`, `upcoming` and `history` —
 * `docs/spec-penghuni-v1.md` decision 3's "Rumah saya" half. The occupant list on a house in
 * `upcoming` or `history` is already empty (`occupiedUnitsForUser` only fills it in for a running
 * stay), so grouping needs nothing more to keep that half of the decision too.
 */
export async function occupiedUnitsForUserGrouped(
	db: DatabaseWriter,
	clock: Clock,
	userId: string
): Promise<OwnOccupancyGroups> {
	const stays = await occupiedUnitsForUser(db, clock, userId);
	return groupByPeriod(stays, currentDay(clock));
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
		.where(and(inArray(occupancies.unitId, unitIds), stillRunningOn(occupancies, today)))
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
 * Takes the unit's row lock, held until the transaction ends, so that every Penanggung Jawab
 * decision about one house happens one at a time — see this module's doc comment for why the
 * invariant rests on it. Also proves the unit exists, which is why nothing else looks it up first.
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
 * Throws unless a stay with these days may carry the Penanggung Jawab flag on `today`: it must be
 * running, `isStillRunningOn` in `./visibility.ts`. Checked on the target as read behind the unit
 * lock, or on the days of a stay about to be recorded, so that a refusal records nothing.
 *
 * @throws {PrimaryOccupantNotStartedError} when the stay starts after `today`.
 * @throws {PrimaryOccupantAlreadyEndedError} when its last day was before `today`.
 */
function assertMayHoldPrimaryOccupant(stay: OccupancyDays, today: string): void {
	if (isStillRunningOn(stay, today)) {
		return;
	}
	if (stay.startedOn > today) {
		throw new PrimaryOccupantNotStartedError(stay.startedOn);
	}
	// Not running and already started: only a last day before today leaves that.
	throw new PrimaryOccupantAlreadyEndedError(stay.endedOn ?? stay.startedOn);
}

/**
 * Moves the Penanggung Jawab flag onto `target`: takes it off every row of the unit whose last day
 * has not passed on `today` or has not been written, puts it on `target`, and writes one
 * `PRIMARY_OCCUPANT_MARKED_ACTION` entry naming the previous holder and the new one. A `target` that
 * already carries the flag is returned as it is, with no write and no audit entry.
 *
 * Only correct while the unit's row lock is held and `target` was read behind it — this module's doc
 * comment is the argument. The caller has already checked that `target` is running on `today`.
 *
 * Rows whose last day has passed keep whatever flag they carry: nothing reads it, and
 * `docs/spec-penghuni-v1.md` leaves those flags stored rather than migrating them away.
 */
async function movePrimaryOccupantMarker(
	transaction: Transaction,
	clock: Clock,
	actorId: string,
	target: Occupancy,
	today: string
): Promise<Occupancy> {
	if (target.isPrimaryOccupant) {
		return target;
	}

	const cleared = await transaction
		.update(occupancies)
		.set({ isPrimaryOccupant: false })
		.where(
			and(
				eq(occupancies.unitId, target.unitId),
				eq(occupancies.isPrimaryOccupant, true),
				notPassedOn(today)
			)
		)
		.returning();

	const [row] = await transaction
		.update(occupancies)
		.set({ isPrimaryOccupant: true })
		.where(eq(occupancies.id, target.id))
		.returning();

	const previous = previousHolder(cleared, today);
	await recordAuditEntry(transaction, clock, {
		actorId,
		action: PRIMARY_OCCUPANT_MARKED_ACTION,
		targetId: row.id,
		before: previous ? { occupancyId: previous.id, residentId: previous.residentId } : undefined,
		after: { occupancyId: row.id, residentId: row.residentId, unitId: row.unitId }
	});

	return row;
}

/**
 * Which of the rows a move took the flag off is the holder its audit entry names.
 *
 * While the invariant holds there is at most one. Rows written under the date-clash model can leave
 * two in one unit — a holder whose last day has been written and, after it, a stay flagged ahead of
 * time — and every one of them loses the flag; the entry then names the one the invoices were going
 * to, picked the way `notifyInvoiceIssued` picks its recipient: running today, then the latest start
 * day, then the latest recorded.
 */
function previousHolder(cleared: readonly Occupancy[], today: string): Occupancy | undefined {
	return [...cleared].sort(
		(left, right) =>
			Number(isStillRunningOn(right, today)) - Number(isStillRunningOn(left, today)) ||
			compareDescending(left.startedOn, right.startedOn) ||
			right.createdAt.getTime() - left.createdAt.getTime() ||
			compareDescending(left.id, right.id)
	)[0];
}

/** `1`, `0` or `-1`, so that sorting by it puts the larger of two strings first. */
function compareDescending(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? 1 : -1;
}

/**
 * The rows whose last day has not passed on `today`, or has not been written: the set ADR 0001's
 * invariant counts flags in. It reads the last day alone on purpose — a stay that has not begun is
 * in the set — so it is not `stillRunningOn`, and must not become it.
 */
function notPassedOn(today: string): SQL {
	// `or()` only widens to `undefined` when every argument is, and neither of these is.
	return or(isNull(occupancies.endedOn), gte(occupancies.endedOn, today)) as SQL;
}

/** Whether a stay with this last day is over on `today`. A stay with no last day never is. */
function hasPassedOn(endedOn: string | null, today: string): boolean {
	return endedOn !== null && endedOn < today;
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
