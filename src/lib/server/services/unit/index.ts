import { eq } from 'drizzle-orm';
import { ACTION, requirePermission } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { units, type Unit } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import {
	findUnitById,
	queryUnitsPage,
	summarizeActiveOccupancies,
	type OccupancySummary
} from './queries';

/**
 * Managing the house register — Unit — the list `spec-warga-unit-v1.md` calls the one source of
 * truth for which houses exist. `ACTION.manageUnits` in `src/lib/server/authz.ts` is granted to
 * `superuser` alone, so every function below is, today, a superuser-only function; that is a fact
 * about the permission table, not something re-decided here, exactly as
 * `src/lib/server/services/user/roles.ts` says about its own action.
 *
 * A house is never deleted, only deactivated and reactivated — see the decisions recorded in
 * `src/lib/server/db/schema/unit.ts`. There is no `deleteUnit` here, and there must never be one.
 */

/** The default page size for the admin unit list. */
export const DEFAULT_UNIT_PAGE_SIZE = 20;

/** The audit log's `action` for a newly created unit. */
export const UNIT_CREATED_ACTION = 'unit_created';
/** The audit log's `action` for a unit that was deactivated. */
export const UNIT_DEACTIVATED_ACTION = 'unit_deactivated';
/** The audit log's `action` for a unit that was reactivated. */
export const UNIT_REACTIVATED_ACTION = 'unit_reactivated';

/**
 * Thrown by `createUnit` when the requested block and number already name a unit — see
 * `units_block_number_unique` in `src/lib/server/db/schema/unit.ts`. Named and `instanceof`-checkable
 * for the same reason `PermissionDeniedError` and `LastSuperuserError` are in `src/lib/errors.ts`: a
 * route tells this apart from "something broke" by catching the class, not by matching a message.
 *
 * It is declared here rather than in `src/lib/errors.ts` because this ticket's `writes:` does not
 * include that file — see the surface note in the ticket that added this action.
 */
export class UnitConflictError extends Error {
	override readonly name = 'UnitConflictError';

	/** The block of the unit that already exists. */
	readonly block: string;
	/** The number of the unit that already exists. */
	readonly number: string;

	constructor(block: string, number: string) {
		super(`A unit at block "${block}" number "${number}" already exists.`);
		this.block = block;
		this.number = number;
	}
}

/**
 * Thrown by `getUnit`, `deactivateUnit` and `reactivateUnit` when `unitId` names no row. A caller
 * can only reach this by requesting an id the admin screen never rendered a link to — the id is
 * read straight from the URL — so it is a 404, not a rejected form.
 */
export class UnitNotFoundError extends Error {
	override readonly name = 'UnitNotFoundError';

	/** The id that named no unit. */
	readonly unitId: string;

	constructor(unitId: string) {
		super(`No unit exists with id "${unitId}".`);
		this.unitId = unitId;
	}
}

/** The PostgreSQL error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * A unit together with what its running occupancies add up to — how many people live there right
 * now, and whether one of them is the Penanggung Jawab. Shared by the list screen's rows and the
 * detail screen's single unit, so the two never drift into two slightly different shapes of the
 * same fact.
 */
export interface UnitWithOccupancySummary extends Unit, OccupancySummary {}

/**
 * Whether this unit is one the admin list flags as needing attention: it is still in service, yet
 * nobody running is its primary occupant, so an invoice issued for it would have no addressee —
 * `spec-warga-unit-v1.md` asks for exactly this to be "terlihat di daftar admin sebagai hal yang
 * perlu dibereskan".
 *
 * It is decided here rather than on the screen so that the list and any later screen asking the same
 * question cannot answer it two different ways.
 */
export function needsPrimaryOccupant(unit: UnitWithOccupancySummary): boolean {
	return unit.isActive && !unit.hasPrimaryOccupant;
}

/** What the admin unit list screen asks for. */
export interface ListUnitsRequest {
	/** The user asking. Checked against `ACTION.manageUnits` before anything else. */
	readonly actorId: string;
	/** 1-based. Defaults to `1`. */
	readonly page?: number;
	/** Defaults to `DEFAULT_UNIT_PAGE_SIZE`. */
	readonly pageSize?: number;
	/** Matched against block and number. Empty or missing means no search filter. */
	readonly search?: string;
	/** `true` also lists deactivated units. Defaults to `false`. */
	readonly includeInactive?: boolean;
}

/** One page of the admin unit list. */
export interface UnitListResult {
	readonly units: readonly UnitWithOccupancySummary[];
	readonly page: number;
	readonly pageSize: number;
	readonly totalCount: number;
}

/**
 * One page of the house register, ordered by block then number, each row carrying how many
 * occupancies of it are running right now.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listUnits(db: Database, request: ListUnitsRequest): Promise<UnitListResult> {
	await requirePermission(db, request.actorId, ACTION.manageUnits);

	const page = normalizePage(request.page);
	const pageSize = normalizePageSize(request.pageSize);

	const { rows, totalCount } = await queryUnitsPage(db, {
		page,
		pageSize,
		search: request.search,
		includeInactive: request.includeInactive ?? false
	});

	return {
		units: await withOccupancySummaries(db, rows),
		page,
		pageSize,
		totalCount
	};
}

/**
 * The one unit named by `unitId`, for the detail screen.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 */
export async function getUnit(
	db: Database,
	actorId: string,
	unitId: string
): Promise<UnitWithOccupancySummary> {
	await requirePermission(db, actorId, ACTION.manageUnits);

	const unit = await findUnitById(db, unitId);
	if (!unit) {
		throw new UnitNotFoundError(unitId);
	}

	const [withSummary] = await withOccupancySummaries(db, [unit]);
	return withSummary;
}

/** What a unit with no running occupancy at all adds up to. */
const NO_RUNNING_OCCUPANCY: OccupancySummary = Object.freeze({
	activeOccupantCount: 0,
	hasPrimaryOccupant: false
});

/** Attaches each unit's occupancy summary, in one query regardless of how many units there are. */
async function withOccupancySummaries(
	db: Database,
	rows: readonly Unit[]
): Promise<readonly UnitWithOccupancySummary[]> {
	const summaries = await summarizeActiveOccupancies(
		db,
		rows.map((row) => row.id)
	);
	return rows.map((row) => ({ ...row, ...(summaries.get(row.id) ?? NO_RUNNING_OCCUPANCY) }));
}

/** Who is asking, and which house they are asking to register. */
export interface CreateUnitRequest {
	/** The user making the change. Checked against `ACTION.manageUnits` before anything else. */
	readonly actorId: string;
	readonly block: string;
	readonly number: string;
}

/**
 * Registers a new unit.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `block` or `number` is empty after trimming.
 * @throws {UnitConflictError} when a unit at that block and number already exists.
 */
export async function createUnit(
	db: Database,
	clock: Clock,
	request: CreateUnitRequest
): Promise<Unit> {
	const block = request.block.trim();
	const number = request.number.trim();

	try {
		return await db.transaction(async (transaction) => {
			await requirePermission(transaction, request.actorId, ACTION.manageUnits);

			if (block === '' || number === '') {
				throw new TypeError('A unit needs a non-empty block and number.');
			}

			const [row] = await transaction
				.insert(units)
				.values({ block, number, createdAt: clock.now() })
				.returning();

			await recordAuditEntry(transaction, clock, {
				actorId: request.actorId,
				action: UNIT_CREATED_ACTION,
				targetId: row.id,
				after: { block: row.block, number: row.number }
			});

			return row;
		});
	} catch (caught) {
		if (isUniqueViolation(caught)) {
			throw new UnitConflictError(block, number);
		}
		throw caught;
	}
}

/** Who is asking, and which unit they are asking to switch off or on. */
export interface UnitStatusChangeRequest {
	/** The user making the change. Checked against `ACTION.manageUnits` before anything else. */
	readonly actorId: string;
	readonly unitId: string;
}

/**
 * Deactivates a unit. A no-op, with no audit row, when it is already inactive — same idiom
 * `grantRole` and `revokeRole` use for a change that is already true.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 */
export async function deactivateUnit(
	db: Database,
	clock: Clock,
	request: UnitStatusChangeRequest
): Promise<Unit> {
	return setUnitActive(db, clock, request, false, UNIT_DEACTIVATED_ACTION);
}

/**
 * Reactivates a unit. A no-op, with no audit row, when it is already active.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 */
export async function reactivateUnit(
	db: Database,
	clock: Clock,
	request: UnitStatusChangeRequest
): Promise<Unit> {
	return setUnitActive(db, clock, request, true, UNIT_REACTIVATED_ACTION);
}

/** Shared body of `deactivateUnit` and `reactivateUnit`: they differ only in direction and action name. */
async function setUnitActive(
	db: Database,
	clock: Clock,
	request: UnitStatusChangeRequest,
	isActive: boolean,
	action: string
): Promise<Unit> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageUnits);

		const [existing] = await transaction.select().from(units).where(eq(units.id, request.unitId));
		if (!existing) {
			throw new UnitNotFoundError(request.unitId);
		}
		if (existing.isActive === isActive) {
			return existing;
		}

		const [row] = await transaction
			.update(units)
			.set({ isActive })
			.where(eq(units.id, request.unitId))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action,
			targetId: row.id,
			before: { isActive: existing.isActive },
			after: { isActive: row.isActive }
		});

		return row;
	});
}

/** `page`, defaulted to `1` and floored at `1`. */
function normalizePage(page: number | undefined): number {
	if (!page || !Number.isFinite(page) || page < 1) {
		return 1;
	}
	return Math.floor(page);
}

/** `pageSize`, defaulted to `DEFAULT_UNIT_PAGE_SIZE` and floored at `1`. */
function normalizePageSize(pageSize: number | undefined): number {
	if (!pageSize || !Number.isFinite(pageSize) || pageSize < 1) {
		return DEFAULT_UNIT_PAGE_SIZE;
	}
	return Math.floor(pageSize);
}

/**
 * Whether `error` is, or wraps, a PostgreSQL unique-constraint violation — Drizzle wraps driver
 * errors inside its own, so the code is on the `cause` chain rather than on the outermost error.
 * Mirrors the `errorCode` helper in `src/lib/server/db/test-helpers.ts`, which this module may not
 * import: that file is test-only tooling, not part of this ticket's `writes:` or `reads:`.
 */
function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	while (current instanceof Error) {
		if (
			'code' in current &&
			typeof current.code === 'string' &&
			current.code === UNIQUE_VIOLATION
		) {
			return true;
		}
		current = current.cause;
	}
	return false;
}
