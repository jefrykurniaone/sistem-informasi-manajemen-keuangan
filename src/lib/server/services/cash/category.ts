import { asc, eq } from 'drizzle-orm';
import { ACTION, requirePermission, type DatabaseWriter } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import {
	CASH_CATEGORY_TYPES,
	cashCategories,
	SYSTEM_CATEGORY_KEY,
	type CashCategory,
	type CashCategoryType,
	type SystemCategoryKey
} from '../../db/schema/cash-category';
import type { Clock } from '../../ports/clock';

/**
 * Managing the Kategori Kas — the classification every Transaksi Kas carries. Master data, because
 * `docs/spec-kas-laporan-v1.md` user story 1 asks that a new expense category like "perbaikan
 * gerbang" not need a deploy, with the one exception the schema already records: the two system
 * categories the migration seeds, found by `systemKey` and never by their display name.
 *
 * `ACTION.manageCashCategories` in `src/lib/server/authz.ts` is granted to `superuser` alone, so
 * every guarded function below is, today, a superuser-only function; that is a fact about the
 * permission table, not something re-decided here, exactly as
 * `src/lib/server/services/user/roles.ts` says about its own action.
 *
 * Decisions settled here:
 *
 * - **There is no delete, and there must never be one.** A category is retired with
 *   `deactivateCashCategory`, so the transactions already pointing at it keep their classification —
 *   user story 2. `tests/unit/cash-category.test.ts` asserts this module's export list for exactly
 *   that reason, the way `tests/unit/audit.test.ts` does for the audit log: adding a
 *   `deleteCashCategory` later is a failing test rather than something a reviewer has to notice.
 *   The database backs it up independently — `cash_transactions.categoryId` carries no `onDelete`.
 * - **`reactivateCashCategory` exists although no acceptance criterion asks for it.** Without it a
 *   mis-click is permanent: there is no delete, and `cash_categories_name_unique` means the same
 *   name cannot be added a second time, so a category deactivated by accident could never be brought
 *   back or replaced. It is the same pair `deactivateUnit`/`reactivateUnit` already forms in
 *   `src/lib/server/services/unit/index.ts`, and it takes nothing away: deactivation still is the
 *   only way a category leaves the recording form.
 * - **The two reads that take no caller.** `listActiveCashCategories` and `findCashCategoryById`
 *   are the contract #34 records a Transaksi Kas against: the first fills the recording form, which
 *   is why a deactivated category disappears from new entries, and the second still answers for a
 *   category that has been retired, which is why an old transaction keeps showing the one it was
 *   filed under. Neither takes an `actorId`, because the admin who records a transaction does not
 *   hold `manageCashCategories`; the screen around them is guarded by its own action. Neither
 *   writes anything, so `spec-fondasi-v1.md`'s rule — every *mutating* service function starts with
 *   `requirePermission` — is not bent by them.
 * - **`listActiveCashCategories` still returns the system categories.** That "Iuran warga" accepts
 *   no manual entry is a rule about the recording operation, not about the category being listed,
 *   and it belongs to the ticket that builds that operation (#34). Filtering it out here would hide
 *   the rule in a read and leave #34 with nothing to refuse.
 */

/** The audit log's `action` for a newly created category. */
export const CASH_CATEGORY_CREATED_ACTION = 'cash_category_created';
/** The audit log's `action` for a category whose name or type changed. */
export const CASH_CATEGORY_UPDATED_ACTION = 'cash_category_updated';
/** The audit log's `action` for a category that was deactivated. */
export const CASH_CATEGORY_DEACTIVATED_ACTION = 'cash_category_deactivated';
/** The audit log's `action` for a category that was brought back. */
export const CASH_CATEGORY_REACTIVATED_ACTION = 'cash_category_reactivated';

/** The PostgreSQL error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * The two ways a system category refuses to be changed. `update` covers both halves of
 * `updateCashCategory` — renaming and changing the type — because one function refuses both, and a
 * caller that wants to tell them apart compares the request with the row it already has.
 */
export const SYSTEM_CATEGORY_ATTEMPT = {
	update: 'update',
	deactivate: 'deactivate'
} as const;

/** One of the refused attempts above. */
export type SystemCategoryAttempt =
	(typeof SYSTEM_CATEGORY_ATTEMPT)[keyof typeof SYSTEM_CATEGORY_ATTEMPT];

/** What each refused attempt says about why the system category would not budge. */
const SYSTEM_CATEGORY_REFUSAL: Readonly<Record<SystemCategoryAttempt, string>> = {
	[SYSTEM_CATEGORY_ATTEMPT.update]: 'its name and its type are fixed',
	[SYSTEM_CATEGORY_ATTEMPT.deactivate]: 'it cannot be deactivated'
};

/**
 * Thrown when a change is asked of one of the two categories the migration seeds — renaming it,
 * changing its type, or deactivating it. All three are refused, because the code that finds these
 * rows depends on them existing, being income, and being available: #29's payment verification
 * writes into "Iuran warga", and #33's opening balance into "Saldo awal".
 *
 * Named and `instanceof`-checkable for the reason `PermissionDeniedError` is: a route tells this
 * apart from "something broke" by catching the class, never by matching a message. It lives here
 * rather than in `src/lib/errors.ts` because this ticket's `writes:` does not include that file —
 * the same surface note `UnitConflictError` carries.
 *
 * The caller *was* allowed to manage categories, so a route answers this as a rejected form
 * (`fail(400, …)`), not as a 403.
 */
export class SystemCashCategoryError extends Error {
	override readonly name = 'SystemCashCategoryError';

	/** The category that refused. */
	readonly categoryId: string;
	/**
	 * Which system category it is, as the row carries it. Typed `string` rather than
	 * `SystemCategoryKey` because that is what the column is — a key the database does not constrain,
	 * by the decision recorded in `src/lib/server/db/schema/cash-category.ts` — and narrowing it here
	 * would mean asserting a value read straight out of a text column.
	 */
	readonly systemKey: string;
	/** What was attempted on it. */
	readonly attempted: SystemCategoryAttempt;

	constructor(categoryId: string, systemKey: string, attempted: SystemCategoryAttempt) {
		super(
			`Cash category "${categoryId}" is the system category "${systemKey}": ${SYSTEM_CATEGORY_REFUSAL[attempted]}.`
		);
		this.categoryId = categoryId;
		this.systemKey = systemKey;
		this.attempted = attempted;
	}
}

/**
 * Thrown by `createCashCategory` and `updateCashCategory` when another category already carries the
 * requested name — see `cash_categories_name_unique` in
 * `src/lib/server/db/schema/cash-category.ts`, which holds across both types on purpose.
 */
export class CashCategoryNameTakenError extends Error {
	override readonly name = 'CashCategoryNameTakenError';

	/** The name that is already in use. Not `name`, which every `Error` already owns. */
	readonly categoryName: string;

	constructor(categoryName: string) {
		super(`A cash category named "${categoryName}" already exists.`);
		this.categoryName = categoryName;
	}
}

/** Thrown when `categoryId` names no row — an id no screen ever rendered. */
export class CashCategoryNotFoundError extends Error {
	override readonly name = 'CashCategoryNotFoundError';

	/** The id that named no category. */
	readonly categoryId: string;

	constructor(categoryId: string) {
		super(`No cash category exists with id "${categoryId}".`);
		this.categoryId = categoryId;
	}
}

/**
 * Thrown when a system category the code depends on is not in the database at all. It is seeded by
 * `drizzle/0009_cash_report.sql`, so reaching this means the migrations did not run to the end —
 * a broken deployment, not a state any screen should try to recover from, exactly as `rolesOf`
 * refuses to paper over a missing role trigger.
 */
export class SystemCategoryMissingError extends Error {
	override readonly name = 'SystemCategoryMissingError';

	/** The key that matched no row. */
	readonly systemKey: SystemCategoryKey;

	constructor(systemKey: SystemCategoryKey) {
		super(
			`The system cash category "${systemKey}" is missing. It is seeded by drizzle/0009_cash_report.sql; the migrations have not all run.`
		);
		this.systemKey = systemKey;
	}
}

/**
 * Every Kategori Kas there is, active or not, ordered by name — the whole admin screen, with no
 * pagination, because a komplek classifies its cash book with a dozen categories and every one of
 * them is something the superuser may want to act on.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listCashCategories(
	db: Database,
	actorId: string
): Promise<readonly CashCategory[]> {
	await requirePermission(db, actorId, ACTION.manageCashCategories);
	return db.select().from(cashCategories).orderBy(asc(cashCategories.name));
}

/**
 * The categories a new Transaksi Kas may be filed under: the active ones, ordered by name. The
 * contract #34's recording form reads — a category that has been deactivated is absent here, while
 * `findCashCategoryById` still answers for it, which is how an old transaction keeps showing a
 * category that new ones can no longer choose.
 *
 * Takes no caller on purpose; see this module's doc comment.
 */
export async function listActiveCashCategories(
	db: DatabaseWriter
): Promise<readonly CashCategory[]> {
	return db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.isActive, true))
		.orderBy(asc(cashCategories.name));
}

/** The one category named by `categoryId`, active or not, or `undefined` when there is none. */
export async function findCashCategoryById(
	db: DatabaseWriter,
	categoryId: string
): Promise<CashCategory | undefined> {
	const [row] = await db.select().from(cashCategories).where(eq(cashCategories.id, categoryId));
	return row;
}

/**
 * The system category "Iuran warga", found by its stable key rather than by the display name a
 * superuser may rename.
 *
 * **This is the exported contract #29's payment verification builds on**: verifying a Pembayaran
 * records cash into this category and nothing else may, so #29 asks this module which row that is
 * instead of carrying its own copy of the question.
 *
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 */
export async function duesCategory(db: DatabaseWriter): Promise<CashCategory> {
	const [row] = await db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	if (!row) {
		throw new SystemCategoryMissingError(SYSTEM_CATEGORY_KEY.dues);
	}
	return row;
}

/** Who is asking, and which category they are asking to add. */
export interface CreateCashCategoryRequest {
	/** The user making the change. Checked against `ACTION.manageCashCategories` first. */
	readonly actorId: string;
	readonly name: string;
	/** `income` or `expense`. Typed `string` so a route hands over its form value unchanged. */
	readonly type: string;
}

/**
 * Adds a category. Ordinary from birth: nothing here ever writes `systemKey`, which is what keeps
 * the two seeded rows the only system categories there will ever be.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when the name is empty after trimming, or the type is not `income` or
 *   `expense`.
 * @throws {CashCategoryNameTakenError} when another category already carries that name.
 */
export async function createCashCategory(
	db: Database,
	clock: Clock,
	request: CreateCashCategoryRequest
): Promise<CashCategory> {
	const name = request.name.trim();

	try {
		return await db.transaction(async (transaction) => {
			await requirePermission(transaction, request.actorId, ACTION.manageCashCategories);
			assertUsableName(name);
			const type = knownType(request.type);

			const [row] = await transaction
				.insert(cashCategories)
				.values({ name, type, createdAt: clock.now() })
				.returning();

			await recordAuditEntry(transaction, clock, {
				actorId: request.actorId,
				action: CASH_CATEGORY_CREATED_ACTION,
				targetId: row.id,
				after: { name: row.name, type: row.type }
			});

			return row;
		});
	} catch (caught) {
		throw asNameConflict(caught, name);
	}
}

/** Who is asking, which category, and what it should say afterwards. */
export interface UpdateCashCategoryRequest {
	/** The user making the change. Checked against `ACTION.manageCashCategories` first. */
	readonly actorId: string;
	readonly categoryId: string;
	readonly name: string;
	/** `income` or `expense`. Typed `string` so a route hands over its form value unchanged. */
	readonly type: string;
}

/**
 * Renames a category and sets its type. A no-op, with no audit row, when both already say that —
 * the idiom `grantRole` and `deactivateUnit` use for a change that is already true.
 *
 * Name and type move together in one function, and therefore in one transaction and one audit row,
 * because they are one edit on one screen. A system category refuses both halves, which is what
 * `docs/spec-kas-laporan-v1.md`'s user story 3 asks for.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when the name is empty after trimming, or the type is unknown.
 * @throws {CashCategoryNotFoundError} when `categoryId` names no category.
 * @throws {SystemCashCategoryError} when it names a system category.
 * @throws {CashCategoryNameTakenError} when another category already carries that name.
 */
export async function updateCashCategory(
	db: Database,
	clock: Clock,
	request: UpdateCashCategoryRequest
): Promise<CashCategory> {
	const name = request.name.trim();

	try {
		return await db.transaction(async (transaction) => {
			await requirePermission(transaction, request.actorId, ACTION.manageCashCategories);
			assertUsableName(name);
			const type = knownType(request.type);

			const existing = await requireCategory(transaction, request.categoryId);
			assertNotSystem(existing, SYSTEM_CATEGORY_ATTEMPT.update);
			if (existing.name === name && existing.type === type) {
				return existing;
			}

			const [row] = await transaction
				.update(cashCategories)
				.set({ name, type })
				.where(eq(cashCategories.id, existing.id))
				.returning();

			await recordAuditEntry(transaction, clock, {
				actorId: request.actorId,
				action: CASH_CATEGORY_UPDATED_ACTION,
				targetId: row.id,
				before: { name: existing.name, type: existing.type },
				after: { name: row.name, type: row.type }
			});

			return row;
		});
	} catch (caught) {
		throw asNameConflict(caught, name);
	}
}

/** Who is asking, and which category they are asking to switch off or on. */
export interface CashCategoryStatusChangeRequest {
	/** The user making the change. Checked against `ACTION.manageCashCategories` first. */
	readonly actorId: string;
	readonly categoryId: string;
}

/**
 * Retires a category: new transactions can no longer be filed under it, while every transaction
 * already filed under it keeps it. A no-op, with no audit row, when it is already inactive.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {CashCategoryNotFoundError} when `categoryId` names no category.
 * @throws {SystemCashCategoryError} when it names a system category.
 */
export async function deactivateCashCategory(
	db: Database,
	clock: Clock,
	request: CashCategoryStatusChangeRequest
): Promise<CashCategory> {
	return setCashCategoryActive(db, clock, request, false, CASH_CATEGORY_DEACTIVATED_ACTION);
}

/**
 * Brings a retired category back. A no-op, with no audit row, when it is already active — which is
 * every system category, so this one never has to refuse them.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {CashCategoryNotFoundError} when `categoryId` names no category.
 */
export async function reactivateCashCategory(
	db: Database,
	clock: Clock,
	request: CashCategoryStatusChangeRequest
): Promise<CashCategory> {
	return setCashCategoryActive(db, clock, request, true, CASH_CATEGORY_REACTIVATED_ACTION);
}

/**
 * Shared body of `deactivateCashCategory` and `reactivateCashCategory`: they differ in direction,
 * in the audit action they write, and in that only switching one off is refused for a system
 * category — switching one on is always the no-op below, since they are never off.
 */
async function setCashCategoryActive(
	db: Database,
	clock: Clock,
	request: CashCategoryStatusChangeRequest,
	isActive: boolean,
	action: string
): Promise<CashCategory> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageCashCategories);

		const existing = await requireCategory(transaction, request.categoryId);
		if (!isActive) {
			assertNotSystem(existing, SYSTEM_CATEGORY_ATTEMPT.deactivate);
		}
		if (existing.isActive === isActive) {
			return existing;
		}

		const [row] = await transaction
			.update(cashCategories)
			.set({ isActive })
			.where(eq(cashCategories.id, existing.id))
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

/** The category named by `categoryId`, or the named 404 for it. */
async function requireCategory(writer: DatabaseWriter, categoryId: string): Promise<CashCategory> {
	const existing = await findCashCategoryById(writer, categoryId);
	if (!existing) {
		throw new CashCategoryNotFoundError(categoryId);
	}
	return existing;
}

/** Refuses `attempted` when `category` is one of the two rows the migration seeded. */
function assertNotSystem(category: CashCategory, attempted: SystemCategoryAttempt): void {
	if (category.systemKey !== null) {
		throw new SystemCashCategoryError(category.id, category.systemKey, attempted);
	}
}

/** Refuses a name that says nothing. */
function assertUsableName(name: string): void {
	if (name === '') {
		throw new TypeError('A cash category needs a non-empty name.');
	}
}

/**
 * `value` as one of the two directions money moves, refusing anything else. The narrowing happens
 * here, once, so that a route hands its raw form value over and never casts.
 */
function knownType(value: string): CashCategoryType {
	const type = CASH_CATEGORY_TYPES.find((known) => known === value);
	if (!type) {
		throw new TypeError(
			`A cash category is "${CASH_CATEGORY_TYPES.join('" or "')}", not "${value}".`
		);
	}
	return type;
}

/**
 * The error to throw on: the named name conflict when PostgreSQL refused the unique index, and
 * otherwise whatever was really caught. Returning it rather than throwing keeps the `throw` visible
 * at the call site, so neither caller looks like it might continue past its `catch`.
 */
function asNameConflict(caught: unknown, name: string): unknown {
	if (isUniqueViolation(caught)) {
		return new CashCategoryNameTakenError(name);
	}
	return caught;
}

/**
 * Whether `error` is, or wraps, a PostgreSQL unique-constraint violation — Drizzle wraps driver
 * errors inside its own, so the code is on the `cause` chain rather than on the outermost error.
 * A copy of the helper in `src/lib/server/services/unit/index.ts`, which says why it is copied
 * rather than imported from `src/lib/server/db/test-helpers.ts`: that file is test-only tooling.
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
