import { and, asc, eq, gte, isNull, lte, or, type SQL } from 'drizzle-orm';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { exemptions, type Exemption } from '../../db/schema/exemption';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { currentDay } from '../occupancy/visibility';
import { UnitNotFoundError } from '../unit';

/**
 * Pembebasan: a stretch of time during which one Unit is not issued a Tagihan — see the decisions
 * `src/lib/server/db/schema/exemption.ts` already settled about the table. This module is the
 * service layer on top of it: who may grant and end one, the audit trail, and the rule the schema
 * could not enforce itself.
 *
 * `ACTION.manageExemptions` in `src/lib/server/authz.ts` is granted to `superuser` alone, so every
 * write below is, today, a superuser-only write — a fact about the permission table, not something
 * re-decided here, exactly as `src/lib/server/services/dues/rate.ts` says about its own action.
 *
 * ## The overlap rule lives here, not in the database
 *
 * `src/lib/server/db/schema/exemption.ts`'s doc comment explains why `exemptions` carries no
 * exclusion constraint: it would need the `btree_gist` extension, which this repository refuses for
 * the same reason `occupancy.ts` already refuses it for `occupancies` — the extension is
 * database-wide while the test harness migrates one schema per file in parallel. `grantExemption`
 * therefore takes the unit's row lock before reading its exemptions and deciding whether the new one
 * overlaps, the same shape `src/lib/server/services/occupancy/index.ts`'s `lockUnit` and
 * `assertPrimarySlotFree` already establish for the same reason: the row that must be locked to
 * serialise two concurrent grants is the *unit's*, because a unit with no exemption yet has no
 * exemption row a lock could land on. `tests/unit/exemption-service.test.ts` proves this with a
 * second connection holding an open transaction, the same technique
 * `tests/unit/occupancy-service.test.ts` uses — two calls raced through `Promise.allSettled` would
 * prove nothing, because nothing would make one of them land inside the other's window.
 *
 * ## `createdBy` is a `residents.id`, not the caller's `actorId`
 *
 * Every permission check in this codebase takes the signed-in account's id — the same id
 * `user_roles.userId` and `audit_log.actorId` use. `exemptions.createdBy` is not that: it references
 * `residents.id`, the same choice `posts.authorId` makes and for the same reason recorded there —
 * `residentIdForUser` below is a second, private copy of `src/lib/server/services/post/index.ts`'s
 * helper of the same name, because neither module exports the other its own. An account holding
 * `superuser` with no `residents` row yet is the same edge case `createPost` refuses with
 * `PostRuleError`; here it is `ExemptionActorNotRegisteredError`.
 *
 * ## The two contracts this module publishes
 *
 * - **`isUnitExemptOn(db, unitId, day)` — whether a Unit is exempt on a calendar day.** This is the
 *   contract `docs/spec-iuran-v1.md` asks the issuance job (#26) to read before it creates a fresh
 *   Tagihan: "Penerbitan tagihan melewatkan Unit yang periodenya tertutup Pembebasan." It takes **no
 *   caller and checks no permission** — the same shape `duesRateOn` takes in
 *   `src/lib/server/services/dues/rate.ts`, for the same reason: a scheduled job has no session.
 * - **A backdated grant changes nothing that already exists.** `docs/spec-iuran-v1.md:124-129` and
 *   this table's own doc comment are explicit: `grantExemption` never touches `invoices`, whatever
 *   `startedOn` is asked for. `tests/unit/exemption-service.test.ts` proves this directly, for a
 *   grant whose `startedOn` is in the past and a Tagihan that already exists inside it.
 */

/** The audit log's `action` for a newly granted exemption. */
export const EXEMPTION_GRANTED_ACTION = 'exemption_granted';
/** The audit log's `action` for an exemption that was given, or given a new, end date. */
export const EXEMPTION_ENDED_ACTION = 'exemption_ended';

/** A calendar day as the schema's `date` columns store it. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Thrown when an exemption would end before it started. The database's
 * `exemptions_date_order_check` refuses the same thing; this exists so that the service answers a
 * broken form with a named refusal a route can turn into `fail(400, …)`, rather than letting a raw
 * `23514` out — the same reasoning `OccupancyDateOrderError` records in
 * `src/lib/server/services/occupancy/index.ts`.
 *
 * The same day is allowed: an exemption covering exactly one day is a real thing to want to record.
 * The rule is "earlier than", not "different from".
 */
export class ExemptionDateOrderError extends Error {
	override readonly name = 'ExemptionDateOrderError';

	/** The day the exemption started, or would start. */
	readonly startedOn: string;
	/** The day it was asked to end on, which is earlier than `startedOn`. */
	readonly endedOn: string;

	constructor(startedOn: string, endedOn: string) {
		super(`An exemption that started on ${startedOn} cannot end on ${endedOn}.`);
		this.startedOn = startedOn;
		this.endedOn = endedOn;
	}
}

/**
 * Thrown by `endExemption` when `exemptionId` names no row. A caller can only reach this with an id
 * the admin screen never rendered a link to, so a route answers it with a 404 rather than a rejected
 * form.
 */
export class ExemptionNotFoundError extends Error {
	override readonly name = 'ExemptionNotFoundError';

	/** The id that named no exemption. */
	readonly exemptionId: string;

	constructor(exemptionId: string) {
		super(`No exemption exists with id "${exemptionId}".`);
		this.exemptionId = exemptionId;
	}
}

/** The exemption `grantExemption` found already covering a day it was asked to grant a new one for. */
interface OverlappingExemption {
	readonly exemptionId: string;
	readonly startedOn: string;
	readonly endedOn: string | null;
	readonly reason: string;
}

/**
 * Thrown by `grantExemption` when the requested period overlaps an exemption the unit already has —
 * see this module's doc comment for why this is decided here rather than by the database.
 *
 * Names the exemption already covering the period, so the superuser reading the refusal knows since
 * when and why the house is already exempt, rather than only that the request was rejected.
 */
export class ExemptionOverlapError extends Error {
	override readonly name = 'ExemptionOverlapError';

	/** The unit both exemptions belong to. */
	readonly unitId: string;
	/** The exemption already covering the requested period. */
	readonly exemptionId: string;
	/** That exemption's start date. */
	readonly startedOn: string;
	/** That exemption's end date, or `null` while it has none yet. */
	readonly endedOn: string | null;
	/** That exemption's reason. */
	readonly reason: string;

	constructor(unitId: string, overlapping: OverlappingExemption) {
		super(
			`Unit "${unitId}" already has an exemption from ${overlapping.startedOn} to ${overlapping.endedOn ?? 'no end yet'}, which the requested period overlaps.`
		);
		this.unitId = unitId;
		this.exemptionId = overlapping.exemptionId;
		this.startedOn = overlapping.startedOn;
		this.endedOn = overlapping.endedOn;
		this.reason = overlapping.reason;
	}
}

/**
 * Thrown by `grantExemption` when the superuser granting it has no `residents` row to attribute the
 * grant to — see this module's doc comment for why `createdBy` needs one. The ordinary way to reach
 * this is a superuser account created directly, never imported or registered as a Warga.
 */
export class ExemptionActorNotRegisteredError extends Error {
	override readonly name = 'ExemptionActorNotRegisteredError';

	/** The signed-in account with no `residents` row. */
	readonly actorId: string;

	constructor(actorId: string) {
		super(`User "${actorId}" has no residents row to attribute an exemption to.`);
		this.actorId = actorId;
	}
}

/** Who is asking, which house, and what stretch of time and reason. */
export interface GrantExemptionRequest {
	/** The user making the change. Checked against `ACTION.manageExemptions` before anything else. */
	readonly actorId: string;
	readonly unitId: string;
	/** The first day the unit is exempt, as `YYYY-MM-DD`. */
	readonly startedOn: string;
	/** The last day, or `null`/missing for an exemption with no end yet. */
	readonly endedOn?: string | null;
	readonly reason: string;
}

/**
 * Grants a new exemption. Never touches `invoices`, whatever `startedOn` is — see this module's doc
 * comment.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `startedOn` or `endedOn` is not a real `YYYY-MM-DD` day, or `reason` is
 *   empty after trimming.
 * @throws {ExemptionDateOrderError} when `endedOn` is earlier than `startedOn`.
 * @throws {ExemptionActorNotRegisteredError} when `actorId` has no `residents` row.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 * @throws {ExemptionOverlapError} naming the exemption the requested period overlaps.
 */
export async function grantExemption(
	db: Database,
	clock: Clock,
	request: GrantExemptionRequest
): Promise<Exemption> {
	assertCalendarDay(request.startedOn, 'startedOn');
	const endedOn = request.endedOn ?? null;
	if (endedOn !== null) {
		assertCalendarDay(endedOn, 'endedOn');
	}
	if (endedOn !== null && endedOn < request.startedOn) {
		throw new ExemptionDateOrderError(request.startedOn, endedOn);
	}

	const reason = request.reason.trim();
	if (reason === '') {
		throw new TypeError('An exemption needs a non-empty reason.');
	}

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageExemptions);

		const createdBy = await residentIdForUser(transaction, request.actorId);
		if (!createdBy) {
			throw new ExemptionActorNotRegisteredError(request.actorId);
		}

		await lockUnit(transaction, request.unitId);
		await assertNoOverlap(transaction, request.unitId, { from: request.startedOn, to: endedOn });

		const [row] = await transaction
			.insert(exemptions)
			.values({
				unitId: request.unitId,
				startedOn: request.startedOn,
				endedOn,
				reason,
				createdBy,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: EXEMPTION_GRANTED_ACTION,
			targetId: row.id,
			after: {
				unitId: row.unitId,
				startedOn: row.startedOn,
				endedOn: row.endedOn,
				reason: row.reason
			}
		});

		return row;
	});
}

/** Who is asking, which exemption, and the day it ends on. */
export interface EndExemptionRequest {
	/** The user making the change. Checked against `ACTION.manageExemptions` before anything else. */
	readonly actorId: string;
	readonly exemptionId: string;
	/** The last day the unit is exempt, as `YYYY-MM-DD`. May be the day it started, but not earlier. */
	readonly endedOn: string;
}

/**
 * Ends a running exemption, or corrects the day an already-ended one ends on — the same idiom
 * `endOccupancy` follows in `src/lib/server/services/occupancy/index.ts`, for the same reason: a
 * superuser correcting a date they just set should not need a second kind of request.
 *
 * A request that asks for the end date the exemption already has changes nothing and writes no audit
 * row, the same idiom `deactivateUnit` and `endOccupancy` follow.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `endedOn` is not a real `YYYY-MM-DD` day.
 * @throws {ExemptionNotFoundError} when `exemptionId` names no exemption.
 * @throws {ExemptionDateOrderError} when `endedOn` is earlier than the day the exemption started.
 */
export async function endExemption(
	db: Database,
	clock: Clock,
	request: EndExemptionRequest
): Promise<Exemption> {
	assertCalendarDay(request.endedOn, 'endedOn');

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageExemptions);
		const existing = await lockExemption(transaction, request.exemptionId);

		if (request.endedOn < existing.startedOn) {
			throw new ExemptionDateOrderError(existing.startedOn, request.endedOn);
		}
		if (existing.endedOn === request.endedOn) {
			return existing;
		}

		const [row] = await transaction
			.update(exemptions)
			.set({ endedOn: request.endedOn })
			.where(eq(exemptions.id, existing.id))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: EXEMPTION_ENDED_ACTION,
			targetId: row.id,
			before: { endedOn: existing.endedOn },
			after: { endedOn: row.endedOn }
		});

		return row;
	});
}

/** One row of the admin screen: an exemption that covers today, with the house it belongs to. */
export interface ActiveExemptionRow {
	readonly exemptionId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly startedOn: string;
	readonly endedOn: string | null;
	readonly reason: string;
}

/**
 * Every unit that is exempt today, ordered by block then number — what the admin screen shows.
 *
 * Deliberately not the whole history: the acceptance criteria asks for "unit yang sedang
 * dibebaskan", present tense, and a grant scheduled to start later than today is not that yet.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listActiveExemptions(
	db: Database,
	clock: Clock,
	actorId: string
): Promise<readonly ActiveExemptionRow[]> {
	await requirePermission(db, actorId, ACTION.manageExemptions);

	const today = currentDay(clock);
	return db
		.select({
			exemptionId: exemptions.id,
			unitId: exemptions.unitId,
			block: units.block,
			number: units.number,
			startedOn: exemptions.startedOn,
			endedOn: exemptions.endedOn,
			reason: exemptions.reason
		})
		.from(exemptions)
		.innerJoin(units, eq(units.id, exemptions.unitId))
		.where(coversDay(today))
		.orderBy(asc(units.block), asc(units.number));
}

/**
 * Whether `unitId` is exempt on `day` — **the contract the issuance ticket (#26) reads**, called with
 * the day the Tagihan is being issued for.
 *
 * Takes no caller and checks no permission, the same shape `duesRateOn` takes in
 * `src/lib/server/services/dues/rate.ts`: it is read by a scheduled job that has no session, and by
 * a screen that has already guarded itself.
 *
 * @throws {TypeError} when `day` is not a real `YYYY-MM-DD` day.
 */
export async function isUnitExemptOn(
	db: DatabaseWriter,
	unitId: string,
	day: string
): Promise<boolean> {
	assertCalendarDay(day, 'day');

	const [row] = await db
		.select({ id: exemptions.id })
		.from(exemptions)
		.where(and(eq(exemptions.unitId, unitId), coversDay(day)))
		.limit(1);

	return row !== undefined;
}

/** The condition "an exemption row covers `day`", shared by every read that asks it. */
function coversDay(day: string): SQL | undefined {
	return and(
		lte(exemptions.startedOn, day),
		or(isNull(exemptions.endedOn), gte(exemptions.endedOn, day))
	);
}

/**
 * Locks the unit's row, so that two grants racing for the same unit are serialised on it — see this
 * module's doc comment for why the unit, and not an exemption row, is what has to be locked. Also
 * proves the unit exists.
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
 * Finds the exemption and takes its own row lock, so that two requests to end the same one cannot
 * both read it as still running.
 *
 * @throws {ExemptionNotFoundError} when `exemptionId` names no exemption.
 */
async function lockExemption(transaction: Transaction, exemptionId: string): Promise<Exemption> {
	const [row] = await transaction
		.select()
		.from(exemptions)
		.where(eq(exemptions.id, exemptionId))
		.limit(1)
		.for('update');
	if (!row) {
		throw new ExemptionNotFoundError(exemptionId);
	}
	return row;
}

/**
 * Throws unless no other exemption of `unitId` covers any day in `range` — only correct while the
 * unit's row lock is held, see this module's doc comment.
 *
 * @throws {ExemptionOverlapError} naming the exemption that already covers part of `range`.
 */
async function assertNoOverlap(
	transaction: Transaction,
	unitId: string,
	range: { from: string; to: string | null }
): Promise<void> {
	const [conflict] = await transaction
		.select({
			exemptionId: exemptions.id,
			startedOn: exemptions.startedOn,
			endedOn: exemptions.endedOn,
			reason: exemptions.reason
		})
		.from(exemptions)
		.where(
			and(
				eq(exemptions.unitId, unitId),
				// The existing exemption has not ended before this range starts …
				or(isNull(exemptions.endedOn), gte(exemptions.endedOn, range.from)),
				// … and it started before this range ends. An open-ended range has no such bound.
				range.to === null ? undefined : lte(exemptions.startedOn, range.to)
			)
		)
		.orderBy(asc(exemptions.startedOn))
		.limit(1);

	if (conflict) {
		throw new ExemptionOverlapError(unitId, conflict);
	}
}

/**
 * The `residents` row belonging to a signed-in account, or `undefined` when it has none. A private
 * copy of the helper of the same name in `src/lib/server/services/post/index.ts` — neither module is
 * in the other's `writes:`, so neither can import the other's.
 */
async function residentIdForUser(
	writer: DatabaseWriter,
	userId: string
): Promise<string | undefined> {
	const [row] = await writer
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId))
		.limit(1);
	return row?.id;
}

/**
 * Throws unless `value` is a real calendar day written as `YYYY-MM-DD`.
 *
 * The round-trip through `Date` is what rejects `2026-02-30`, which matches the pattern and is not a
 * day — `JSON`-free `Date.parse` alone would silently roll it over to March. The same check
 * `assertDay` makes in `src/lib/server/services/dues/rate.ts`.
 *
 * @throws {TypeError} when `value` is not a real `YYYY-MM-DD` day.
 */
function assertCalendarDay(value: string, field: string): void {
	if (!CALENDAR_DAY.test(value)) {
		throw new TypeError(`${field} must be a calendar day written as YYYY-MM-DD, not "${value}".`);
	}
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
		throw new TypeError(`${field} is not a real calendar day: "${value}".`);
	}
}
