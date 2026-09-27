import { asc, eq } from 'drizzle-orm';
import { recordAuditEntry } from '../../audit';
import type { Transaction } from '../../authz';
import type { Database } from '../../db';
import { occupancies, type Occupancy, type OccupancyRole } from '../../db/schema/occupancy';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { PRIMARY_OCCUPANT_MARKED_ACTION } from './index';
import { currentDay } from './visibility';

/**
 * The one-off clean-up of duplicate Masa Huni: the same resident recorded more than once in the same
 * unit over days that overlap, both ends counted inclusively. `docs/spec-penghuni-v1.md` decision 8
 * (#238) asks for it, and ticket #242 settles the rules below. Production carried two such pairs on
 * 2026-09-27. Decision 6 of the same spec makes every path that records a Masa Huni refuse a new
 * one, so this runs once, at the end of run `huni-v1`, and only with the owner's explicit permission.
 *
 * `fixDuplicateOccupancies` is the only export that does anything, the same shape as
 * `bootstrapSuperuser` in `../user/bootstrap.ts`: every decision lives here, where `bun run check`
 * type-checks it and `tests/unit/occupancy-duplicate-fix.test.ts` runs it against PostgreSQL, and
 * `scripts/fix-duplicate-occupancies.ts` only reads `--yes` and prints. Like that function it takes
 * no actor and checks no permission, so **it must never be called from a route, a form action or an
 * endpoint**. Deleting a Masa Huni is an exception the owner approved once, for this data, and no
 * path in the application gains it.
 *
 * ## The rules
 *
 * 1. The occupancies of each pair of resident and unit are visited in the order they were recorded,
 *    `created_at` and then `id`.
 * 2. A row is kept when it overlaps no row already kept. Every other row is deleted.
 * 3. A deleted row carrying the Penanggung Jawab marker whose last day is today, later, or not set
 *    hands the marker to a kept row it overlaps, chosen as `markerTarget` describes.
 * 4. If the result would leave a unit the plan changes with more than one marked row whose last day
 *    has not passed, the whole plan is refused and nothing is written.
 * 5. Every deleted row leaves one audit entry, `OCCUPANCY_DUPLICATE_DELETED_ACTION`, with the whole
 *    row in `before`.
 * 6. Every marker move leaves one `PRIMARY_OCCUPANT_MARKED_ACTION` entry.
 *
 * Both entries are written by `DATA_FIX_ACTOR_ID`.
 *
 * ## Why the result is well defined, and safe to run twice
 *
 * **The kept set is a function of the rows alone.** `id` is the primary key, so `created_at, id` is
 * a strict total order: no two rows tie. Rule 2 is a single pass in that order, and each decision
 * depends only on the decisions before it, so one set of rows gives exactly one kept set and one
 * deleted set, whatever day it is. The order is PostgreSQL's own `order by created_at, id`, because
 * a JavaScript `Date` keeps milliseconds and `timestamptz` keeps microseconds; two rows written in
 * the same millisecond by hand would otherwise tie here and be ordered by `id` instead.
 *
 * **Kept rows never overlap each other**, since each one was checked against every row kept before
 * it and overlapping is symmetric. **Every deleted row overlaps at least one kept row**: the row that
 * made it a duplicate was kept at that moment, and nothing is ever un-kept. The first row of a pair
 * is always kept, so nobody loses every stay in a house, only the redundant ones.
 *
 * **A marker never moves onto a row that is itself deleted.** `markerTarget` chooses only among the
 * kept rows, and no row is both kept and deleted. The target is also the same resident's row in the
 * same unit, because rule 1 groups by that pair.
 *
 * **The plan never adds a marked row whose last day has not passed.** Counting those rows in one
 * unit: deleting a marked row that has not passed takes one away, and each such row gives at most
 * one marker to at most one kept row. Nothing else changes a marker. So the count after the plan is
 * never above the count before it. Rule 4 therefore fires exactly when a unit the plan changes
 * *already* holds two or more such markers and the plan does not bring them down to one: the markers
 * left sit on different residents' rows, or on rows of one resident that do not overlap and so are
 * both kept. That unit needs a person to pick its Penanggung Jawab on the Penghuni page first. A unit
 * the plan does not change is not judged, because the plan does nothing there.
 *
 * **A second run finds nothing.** After the first, every resident's rows in every unit are the kept
 * rows, which overlap nothing. Rule 2 then keeps every row, so there is nothing to delete, no marker
 * to move and no unit to judge, and the day it runs on changes none of that: which rows overlap is a
 * question about their own days, never about today's.
 *
 * ## Carrying it out
 *
 * Without `apply`, the plan is computed inside a `read only` transaction, so PostgreSQL itself would
 * refuse a write. With it, everything happens in one transaction:
 *
 * - **Every unit is locked first**, `for update` in `id` order: the unit lock ADR 0001 asks of every
 *   path that sets the marker. The service's writers take the same lock on their one unit first, so
 *   none of them can change a row between the read and the writes here, and the read, a statement
 *   issued after the locks were granted, sees everything they committed while it waited. An import
 *   inserting into several units at the same moment could meet these locks in another order;
 *   PostgreSQL then breaks the deadlock by rolling one side back whole, and a rolled-back run wrote
 *   nothing.
 * - **Every deletion comes before every marker.** `occupancies_primary_occupant_unique` allows one
 *   marked row with no end date per unit and is checked statement by statement. After the deletions
 *   the marked rows are a subset of the final marked rows, and each move only adds one of the final
 *   ones, so every state in between is a subset of the end state, which rule 4 has already limited to
 *   one marker that has not passed per changed unit. A row with no end date has not passed, so the
 *   index never fires.
 * - Rule 4 is decided before the first write, so a refusal has nothing to undo.
 */

/**
 * The `audit_log.actor_id` of every row this clean-up writes.
 *
 * The same `system:` namespace `MACHINE_OPERATOR_ACTOR_ID` in `../user/bootstrap.ts` opened, and for
 * the same reason: no person signed in to make these changes, and better-auth never writes a colon
 * into a `user.id`, so a reader filtering the audit log by account can never match these rows.
 */
export const DATA_FIX_ACTOR_ID = 'system:data-fix';

/** The audit log's `action` for a duplicate occupancy this clean-up deleted. */
export const OCCUPANCY_DUPLICATE_DELETED_ACTION = 'occupancy_duplicate_deleted';

/** Whether the plan is only computed and reported, or carried out. */
export type DuplicateFixMode = 'dryRun' | 'apply';

/**
 * One occupancy as the plan shows it. There is nothing here about the person beyond the fact that
 * the rows of one `DuplicateGroup` are theirs: no name, no email, and no resident id either.
 */
export interface PlannedOccupancy {
	readonly occupancyId: string;
	readonly role: OccupancyRole;
	readonly startedOn: string;
	/** The last day, or `null` when none is set. */
	readonly endedOn: string | null;
	/** Whether the row carries the Penanggung Jawab marker before the plan runs. */
	readonly isPrimaryOccupant: boolean;
}

/** One resident's occupancies of one unit, where at least one of them is a duplicate. */
export interface DuplicateGroup {
	/** The rows that stay, in the order rule 1 visited them. Never empty. */
	readonly kept: readonly PlannedOccupancy[];
	/** The rows that are deleted, in the same order. Never empty. */
	readonly deleted: readonly PlannedOccupancy[];
}

/** The Penanggung Jawab marker leaving a deleted row for a kept row of the same resident. */
export interface PrimaryOccupantMove {
	readonly fromOccupancyId: string;
	readonly toOccupancyId: string;
}

/** What the plan does in one unit. */
export interface UnitDuplicateFix {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly groups: readonly DuplicateGroup[];
	readonly moves: readonly PrimaryOccupantMove[];
}

/** The whole plan, one entry per unit it changes, sorted by block and then number. */
export interface DuplicateFixPlan {
	/** The day, `YYYY-MM-DD` in the complex's zone, that "has not passed" was judged against. */
	readonly day: string;
	readonly units: readonly UnitDuplicateFix[];
}

/** A unit the plan would leave with more than one marked row whose last day has not passed. */
export interface PrimaryOccupantConflict {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/** Those marked rows, in the order rule 1 visits rows. Always two or more. */
	readonly occupancyIds: readonly string[];
}

/** What happened, in the four shapes the command reports differently. */
export type DuplicateFixOutcome =
	/** No duplicate anywhere. Nothing was written. */
	| { readonly kind: 'clean'; readonly day: string }
	/** A dry run found duplicates and the plan passes rule 4. Nothing was written. */
	| { readonly kind: 'planned'; readonly plan: DuplicateFixPlan }
	/** Rule 4 refused the plan, in either mode. Nothing was written. */
	| {
			readonly kind: 'refused';
			readonly plan: DuplicateFixPlan;
			readonly conflicts: readonly PrimaryOccupantConflict[];
	  }
	/** The plan was carried out in one committed transaction. */
	| { readonly kind: 'applied'; readonly plan: DuplicateFixPlan };

/**
 * Thrown inside the applying transaction when a row the plan was computed from is gone by the time
 * it is written, which rolls the whole run back. Nothing in the application deletes an occupancy,
 * and the unit locks hold off every writer that changes one; this is here for a row removed by hand
 * while the command runs.
 */
class OccupancyChangedDuringFixError extends Error {
	override readonly name = 'OccupancyChangedDuringFixError';

	constructor(occupancyId: string) {
		super(`Occupancy "${occupancyId}" changed while the duplicate clean-up was running.`);
	}
}

/**
 * Finds duplicate occupancies and, in `apply` mode, deletes them in one transaction together with
 * their audit entries and the marker moves they cause. See this module's doc comment for the rules
 * and why they hold.
 *
 * @param clock gives the day rules 3 and 4 judge against, and stamps every audit entry.
 * @param mode `dryRun` computes and returns the plan in a read-only transaction; `apply` also
 *   carries it out, unless rule 4 refuses it.
 */
export async function fixDuplicateOccupancies(
	db: Database,
	clock: Clock,
	mode: DuplicateFixMode
): Promise<DuplicateFixOutcome> {
	const day = currentDay(clock);

	if (mode === 'dryRun') {
		return db.transaction(async (transaction) => planFix(await readOccupancies(transaction), day), {
			accessMode: 'read only'
		});
	}

	return db.transaction(async (transaction): Promise<DuplicateFixOutcome> => {
		await transaction.select({ id: units.id }).from(units).orderBy(asc(units.id)).for('update');
		const outcome = planFix(await readOccupancies(transaction), day);
		if (outcome.kind !== 'planned') {
			return outcome;
		}
		await carryOut(transaction, clock, outcome.plan);
		return { kind: 'applied', plan: outcome.plan };
	});
}

/** One stored occupancy together with the house it is in, as `readOccupancies` returns it. */
interface StoredOccupancy {
	readonly occupancy: Occupancy;
	readonly block: string;
	readonly number: string;
}

/** Every occupancy, in rule 1's order. See this module's doc comment for why SQL sorts them. */
async function readOccupancies(transaction: Transaction): Promise<readonly StoredOccupancy[]> {
	return transaction
		.select({ occupancy: occupancies, block: units.block, number: units.number })
		.from(occupancies)
		.innerJoin(units, eq(units.id, occupancies.unitId))
		.orderBy(asc(occupancies.createdAt), asc(occupancies.id));
}

/** A `UnitDuplicateFix` while `planFix` is still filling it in. */
interface UnitDuplicateFixDraft extends UnitDuplicateFix {
	readonly groups: DuplicateGroup[];
	readonly moves: PrimaryOccupantMove[];
}

/** Rules 1 to 4 over `rows`, which must arrive in rule 1's order. Reads nothing and writes nothing. */
function planFix(rows: readonly StoredOccupancy[], day: string): DuplicateFixOutcome {
	const groups = new Map<string, StoredOccupancy[]>();
	const rowsByUnit = new Map<string, StoredOccupancy[]>();
	for (const row of rows) {
		appendTo(groups, `${row.occupancy.unitId}/${row.occupancy.residentId}`, row);
		appendTo(rowsByUnit, row.occupancy.unitId, row);
	}

	const planned = new Map<string, UnitDuplicateFixDraft>();
	const deletedIds = new Set<string>();
	const targetIds = new Set<string>();

	for (const group of groups.values()) {
		const kept: Occupancy[] = [];
		const deleted: Occupancy[] = [];
		for (const { occupancy } of group) {
			if (kept.some((keeper) => overlaps(keeper, occupancy))) {
				deleted.push(occupancy);
			} else {
				kept.push(occupancy);
			}
		}
		if (deleted.length === 0) {
			continue;
		}

		const { occupancy: first, block, number } = group[0];
		const unit = planned.get(first.unitId) ?? {
			unitId: first.unitId,
			block,
			number,
			groups: [],
			moves: []
		};
		planned.set(first.unitId, unit);
		unit.groups.push({ kept: kept.map(toPlanned), deleted: deleted.map(toPlanned) });

		for (const row of deleted) {
			deletedIds.add(row.id);
			if (!row.isPrimaryOccupant || !hasNotPassed(row, day)) {
				continue;
			}
			const target = markerTarget(row, kept, day);
			targetIds.add(target.id);
			if (!target.isPrimaryOccupant) {
				unit.moves.push({ fromOccupancyId: row.id, toOccupancyId: target.id });
			}
		}
	}

	if (planned.size === 0) {
		return { kind: 'clean', day };
	}

	const conflicts: PrimaryOccupantConflict[] = [];
	for (const { unitId, block, number } of planned.values()) {
		const markedAfter = (rowsByUnit.get(unitId) ?? [])
			.map(({ occupancy }) => occupancy)
			.filter(
				(row) =>
					!deletedIds.has(row.id) &&
					(row.isPrimaryOccupant || targetIds.has(row.id)) &&
					hasNotPassed(row, day)
			);
		if (markedAfter.length > 1) {
			conflicts.push({ unitId, block, number, occupancyIds: markedAfter.map((row) => row.id) });
		}
	}

	const plan: DuplicateFixPlan = { day, units: [...planned.values()].sort(byHouse) };
	if (conflicts.length > 0) {
		return { kind: 'refused', plan, conflicts: conflicts.sort(byHouse) };
	}
	return { kind: 'planned', plan };
}

/**
 * The kept row a deleted row's marker moves to (rule 3): of the kept rows it overlaps, taken by the
 * day they start, the first whose last day has not passed, or failing that the last of them.
 *
 * With a plain pair there is one candidate and no choice. With more, a deleted row can bridge two
 * kept rows, one long over and one running today, and the marker means "who gets this house's
 * invoice emails now" (ADR 0001): leaving it on the finished stay would take the house's recipient
 * away while the same person still lives there. Kept rows never overlap, so their start days are
 * all different and every finished one comes before every one that has not finished; the first one
 * that has not passed is therefore the stay covering today when there is one, and otherwise the next
 * to begin.
 */
function markerTarget(deleted: Occupancy, kept: readonly Occupancy[], day: string): Occupancy {
	const candidates = kept
		.filter((row) => overlaps(row, deleted))
		.sort((left, right) => compareText(left.startedOn, right.startedOn));
	const target = candidates.find((row) => hasNotPassed(row, day)) ?? candidates.at(-1);
	if (!target) {
		// Unreachable: see "every deleted row overlaps at least one kept row" in the module comment.
		throw new Error(`Occupancy "${deleted.id}" was deleted without overlapping a kept row.`);
	}
	return target;
}

/** Deletes, then marks, then records, all inside the caller's transaction. */
async function carryOut(
	transaction: Transaction,
	clock: Clock,
	plan: DuplicateFixPlan
): Promise<void> {
	const removed = new Map<string, Occupancy>();
	for (const unit of plan.units) {
		for (const group of unit.groups) {
			for (const { occupancyId } of group.deleted) {
				const [row] = await transaction
					.delete(occupancies)
					.where(eq(occupancies.id, occupancyId))
					.returning();
				if (!row) {
					throw new OccupancyChangedDuringFixError(occupancyId);
				}
				removed.set(row.id, row);
				await recordAuditEntry(transaction, clock, {
					actorId: DATA_FIX_ACTOR_ID,
					action: OCCUPANCY_DUPLICATE_DELETED_ACTION,
					targetId: row.id,
					before: { ...row, createdAt: row.createdAt.toISOString() }
				});
			}
		}
	}

	for (const unit of plan.units) {
		for (const move of unit.moves) {
			// Always found: every move starts from a deleted row, and every deleted row was removed above.
			const source = removed.get(move.fromOccupancyId);
			if (!source) {
				throw new OccupancyChangedDuringFixError(move.fromOccupancyId);
			}
			const [row] = await transaction
				.update(occupancies)
				.set({ isPrimaryOccupant: true })
				.where(eq(occupancies.id, move.toOccupancyId))
				.returning();
			if (!row) {
				throw new OccupancyChangedDuringFixError(move.toOccupancyId);
			}
			await recordAuditEntry(transaction, clock, {
				actorId: DATA_FIX_ACTOR_ID,
				action: PRIMARY_OCCUPANT_MARKED_ACTION,
				targetId: row.id,
				before: { occupancyId: source.id, residentId: source.residentId },
				after: { occupancyId: row.id, residentId: row.residentId, unitId: row.unitId }
			});
		}
	}
}

/**
 * Whether two stays share at least one day. Both ends count, so a stay ending on the 31st and one
 * starting on the 31st overlap, and a missing last day reaches every later day. `YYYY-MM-DD` days
 * compare correctly as plain strings.
 */
function overlaps(left: Occupancy, right: Occupancy): boolean {
	return (
		(right.endedOn === null || left.startedOn <= right.endedOn) &&
		(left.endedOn === null || right.startedOn <= left.endedOn)
	);
}

/**
 * Whether the stay's last day is `day` or later, or not set: rules 3 and 4's "belum lewat". It reads
 * the last day alone on purpose. ADR 0001's invariant counts every marked row that has not passed,
 * one still to begin included, so this is not the "living here now" predicate in `./visibility.ts`
 * and must not become it.
 */
function hasNotPassed(row: Occupancy, day: string): boolean {
	return row.endedOn === null || row.endedOn >= day;
}

/** What the plan shows of a row. */
function toPlanned(row: Occupancy): PlannedOccupancy {
	return {
		occupancyId: row.id,
		role: row.role,
		startedOn: row.startedOn,
		endedOn: row.endedOn,
		isPrimaryOccupant: row.isPrimaryOccupant
	};
}

/** Appends `value` to the list under `key`, starting the list when there is none yet. */
function appendTo<T>(lists: Map<string, T[]>, key: string, value: T): void {
	const list = lists.get(key);
	if (list) {
		list.push(value);
		return;
	}
	lists.set(key, [value]);
}

/** Orders two houses by block and then number, for a plan that reads the same on every run. */
function byHouse(
	left: { readonly block: string; readonly number: string },
	right: { readonly block: string; readonly number: string }
): number {
	return compareText(left.block, right.block) || compareText(left.number, right.number);
}

/** `-1`, `0` or `1` by code unit, so the order does not depend on the machine's locale. */
function compareText(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}
