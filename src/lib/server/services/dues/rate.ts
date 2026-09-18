import { asc, desc, eq, lte } from 'drizzle-orm';
import type { Rupiah } from '$lib/money';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { duesRates, type DuesRate } from '../../db/schema/dues-rate';
import { invoices } from '../../db/schema/invoice';
import type { Clock } from '../../ports/clock';
import { currentDay } from '../occupancy/visibility';

/**
 * Tarif: the monthly iuran amount, as something with a history. A rate is a besaran plus the day it
 * starts applying; a rise agreed in a rapat warga is scheduled by writing a new rate with a later
 * start date, never by editing the number that is already billing.
 *
 * `ACTION.manageDuesRates` in `src/lib/server/authz.ts` is granted to `superuser` alone, so every
 * function below except `duesRateOn` is, today, a superuser-only function; that is a fact about the
 * permission table, not something re-decided here, exactly as
 * `src/lib/server/services/unit/index.ts` says about its own action.
 *
 * ## The two contracts this module publishes
 *
 * - **`duesRateOn(db, day)` — the rate in force on a calendar day.** This is the contract
 *   `docs/spec-iuran-v1.md` asks the issuance job (#26) to read at the moment it creates a fresh
 *   Tagihan, and it is the reason `dues_rates` has no "current rate" flag: the answer is the row
 *   with the greatest `effectiveFrom` not after `day`, computed on every read, so there is no stored
 *   value that could fall out of step with the rows it summarises. It takes **no caller and checks
 *   no permission** — it is read by a scheduled job that has no session, and by the screens that
 *   already guarded themselves.
 * - **"A rate that has already been used to bill can no longer be changed."** See below. Both
 *   `updateDuesRate` and `deleteDuesRate` refuse with `DuesRateInUseError`, which names the first
 *   Periode billed under that rate — "sejak kapan ia terpakai".
 *
 * ## What "already used to bill" means, and why it is a query across `invoices`
 *
 * `invoices` does not point at `dues_rates` and never will: `src/lib/server/db/schema/invoice.ts`
 * freezes `invoices.amount` at issue time precisely so that a later rate change cannot edit a bill
 * that has already gone out. The price of that decision is that "has this rate been used" is not a
 * fact either table holds — it can only be answered by asking whether any Tagihan's Periode falls
 * inside the stretch of time this rate was the one in force.
 *
 * That stretch is expressed in **months**, because `invoices.period` is a month (`YYYY-MM`) while
 * `dues_rates.effectiveFrom` is a day:
 *
 * - the window opens in the month of `effectiveFrom`;
 * - it closes in the month before the next rate's `effectiveFrom` when that next rate starts on the
 *   first of a month, and otherwise in that same month — a rate taking over on the 15th means both
 *   rates touched that month, and neither of them can be told apart as the one that priced it;
 * - the newest rate's window has no end at all.
 *
 * Where two rates touch one month, **both** are treated as used. That is the conservative direction
 * on purpose: the cost of refusing an edit that was in fact harmless is one new rate row, and the
 * cost of allowing one that was not is a history that no longer explains a bill somebody already
 * paid.
 *
 * A cancelled Tagihan (`voidedAt` set) still counts. It was issued at that rate and went out to a
 * resident; cancelling it afterwards does not un-bill it.
 *
 * ## Moving a rate is guarded on both sides of the move
 *
 * `updateDuesRate` checks the rate's window **as it stands** and the window it **would have** after
 * the change, and refuses either way. `docs/spec-iuran-v1.md` says a used rate is "hanya digantikan
 * oleh tarif baru dengan tanggal berlaku setelahnya", and a rate dragged backwards over months that
 * are already billed would claim them without changing a single frozen `invoices.amount` — the
 * numbers would stay right while the history explaining them went wrong.
 *
 * ## Inserting a rate is guarded too
 *
 * A window ends where the next one begins, so **inserting** a rate shortens its predecessor, and a
 * rate locked by a billed Periode can be unlocked by handing that Periode to somebody else. With one
 * rate running from January and February already billed, writing a second rate from 1 February moves
 * February out of the first rate's window: the first rate is suddenly editable and deletable, and it
 * is the rate that actually priced those bills. `createDuesRate` therefore refuses a new rate whose
 * window would contain an already-billed Periode, which is the same rule stated from the other side:
 * no billed Periode ever changes owner.
 *
 * ## A start date that has not arrived is never "used"
 *
 * Every one of these checks is skipped when the date being judged is later than today. A rate that
 * has not started cannot have priced anything: the only reader of a rate is `duesRateOn`, and
 * issuance asks it about a day that has arrived. Without this, the conservative shared-month rule
 * would lock a rise that is still only scheduled — a rate set to start on the 15th would be refused
 * as "used" because that month's Tagihan were issued on the 1st, by the rate that was already
 * running — and `docs/spec-iuran-v1.md`'s "mengubah tarif yang belum berlaku" would be impossible.
 *
 * ## What the issuance ticket has to do about locking
 *
 * `updateDuesRate` and `deleteDuesRate` take `for update` on the rate rows and then read `invoices`
 * without a lock, which is enough while nothing writes `invoices`. It stops being enough the moment
 * #26 exists: under `read committed` an issuance transaction that has read its rate and not yet
 * committed its Tagihan is invisible here, so a delete could pass the in-use test and commit between
 * the two. **#26 must read its rate with `for('share')` inside the same transaction that inserts the
 * Tagihan**, which makes this module's `for update` wait for it. That lock is not taken by
 * `duesRateOn` itself, because the history screen and every other reader would then queue behind a
 * writer for an answer they only display.
 *
 * ## Today
 *
 * "Which rate is in force now" reads the day from `currentDay(clock)` in
 * `src/lib/server/services/occupancy/visibility.ts` rather than defining a second idea of today.
 * That function reads the instant as a **UTC** day while the complex sits at UTC+7, which its own
 * comment records: the complex's time zone is a decision `docs/spec-iuran-v1.md` has to make when it
 * settles what "the first of the month" means for issuance (#26), and inventing one here would put
 * it in the wrong place. Until then this screen can name yesterday's rate as the one in force
 * between local midnight and 07:00 on the day a new rate starts.
 */

/** The audit log's `action` for a newly set rate. */
export const DUES_RATE_CREATED_ACTION = 'dues_rate_created';
/** The audit log's `action` for a rate whose amount or start date was changed. */
export const DUES_RATE_UPDATED_ACTION = 'dues_rate_updated';
/** The audit log's `action` for a rate that was removed before it was ever used. */
export const DUES_RATE_DELETED_ACTION = 'dues_rate_deleted';

/** The shape `effectiveFrom` is written and read in, the same `YYYY-MM-DD` every `date` column uses. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The PostgreSQL error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Thrown by `updateDuesRate` and `deleteDuesRate` when the rate has already priced a Tagihan.
 *
 * Carries the first Periode billed under it, so that the refusal a superuser reads says since when
 * the rate has been in use rather than only that it is. Declared here rather than in
 * `src/lib/errors.ts` for the reason `UnitConflictError` records: this ticket's `writes:` does not
 * include that file, and a named, `instanceof`-checkable class in the service module is what a route
 * catches either way.
 */
export class DuesRateInUseError extends Error {
	override readonly name = 'DuesRateInUseError';

	/** The rate that may no longer be changed. */
	readonly duesRateId: string;

	/** The earliest Periode, as `YYYY-MM`, that this rate has billed. */
	readonly usedSincePeriod: string;

	constructor(duesRateId: string, usedSincePeriod: string) {
		super(
			`Dues rate "${duesRateId}" has been used to bill since period ${usedSincePeriod} and can no longer be changed or removed.`
		);
		this.duesRateId = duesRateId;
		this.usedSincePeriod = usedSincePeriod;
	}
}

/**
 * Thrown by `updateDuesRate` and `deleteDuesRate` when `duesRateId` names no row.
 *
 * The id reaches these functions from a form on the history screen, so the ordinary way to see this
 * is a page left open while somebody else removed the rate — which is a rejected submission with a
 * readable line, not a 404 page.
 */
export class DuesRateNotFoundError extends Error {
	override readonly name = 'DuesRateNotFoundError';

	/** The id that named no rate. */
	readonly duesRateId: string;

	constructor(duesRateId: string) {
		super(`No dues rate exists with id "${duesRateId}".`);
		this.duesRateId = duesRateId;
	}
}

/**
 * Thrown when the requested start date already belongs to another rate — see
 * `dues_rates_effective_from_unique` in `src/lib/server/db/schema/dues-rate.ts`. Two rates starting
 * on one day would leave "the rate in force that day" without a single answer, which is why the
 * database refuses it rather than this module reading before it writes.
 */
export class DuesRateConflictError extends Error {
	override readonly name = 'DuesRateConflictError';

	/** The start date that is already taken. */
	readonly effectiveFrom: string;

	constructor(effectiveFrom: string) {
		super(`A dues rate already starts on "${effectiveFrom}".`);
		this.effectiveFrom = effectiveFrom;
	}
}

/**
 * The stretch of Periode one rate is the one in force for, both ends inclusive. See this module's
 * doc comment for why the ends are months rather than days.
 */
export interface DuesRateWindow {
	/** The rate this window belongs to. */
	readonly duesRateId: string;
	/** The first Periode this rate can have billed, as `YYYY-MM`. */
	readonly firstMonth: string;
	/** The last one, or `null` when no later rate has taken over yet. */
	readonly lastMonth: string | null;
}

/** Just enough of a rate to place it on the calendar. */
export interface DuesRatePlacement {
	readonly id: string;
	readonly effectiveFrom: string;
}

/**
 * The billing window of every rate in `rates`, in the order the rates start.
 *
 * Pure, so that the rule can be walked in a test without a database: hand it a list of start dates
 * and read the months back.
 */
export function duesRateWindows(rates: readonly DuesRatePlacement[]): readonly DuesRateWindow[] {
	const sorted = [...rates].sort((left, right) =>
		compareText(left.effectiveFrom, right.effectiveFrom)
	);

	return sorted.map((rate, index) => {
		const next = sorted[index + 1];
		return {
			duesRateId: rate.id,
			firstMonth: monthOf(rate.effectiveFrom),
			lastMonth: next ? lastMonthBefore(next.effectiveFrom) : null
		};
	});
}

/**
 * The earliest Periode in `billedPeriods` that falls inside `window`, or `undefined` when none does
 * — which is exactly "this rate has never been used to bill".
 *
 * `billedPeriods` is expected sorted ascending, as `billedPeriodsOf` returns it.
 */
export function usedSincePeriodOf(
	window: DuesRateWindow,
	billedPeriods: readonly string[]
): string | undefined {
	return billedPeriods.find((period) => isWithinWindow(period, window));
}

/** Whether `period`, as `YYYY-MM`, falls inside `window`. Fixed-width months compare as plain text. */
function isWithinWindow(period: string, window: DuesRateWindow): boolean {
	if (compareText(period, window.firstMonth) < 0) {
		return false;
	}
	return window.lastMonth === null || compareText(period, window.lastMonth) <= 0;
}

/**
 * The rate in force on `day`, or `undefined` when no rate had started yet — **the contract the
 * issuance ticket (#26) reads**, called with the day the Tagihan is being issued for.
 *
 * `undefined` rather than a throw: "no rate has ever been set" is a real state of a fresh
 * installation, and what issuance should do about it (refuse the run, report it, wait) is that
 * ticket's decision, not one this module can make for it.
 */
export async function duesRateOn(db: DatabaseWriter, day: string): Promise<DuesRate | undefined> {
	assertDay(day, 'day');

	const [row] = await db
		.select()
		.from(duesRates)
		.where(lte(duesRates.effectiveFrom, day))
		.orderBy(desc(duesRates.effectiveFrom))
		.limit(1);

	return row;
}

/** One row of the history screen: a rate, plus what this service knows about it. */
export interface DuesRateHistoryRow extends DuesRate {
	/** Whether this is the rate in force today. Exactly one row has it, unless every rate is future. */
	readonly isInForce: boolean;
	/** The first Periode this rate has billed, or `null` when it has billed none. */
	readonly usedSincePeriod: string | null;
	/** Whether this rate may still be changed or removed. The negation of "has billed something". */
	readonly isEditable: boolean;
}

/** The whole history, as the superuser screen shows it. */
export interface DuesRateHistory {
	/** Every rate, newest start date first. */
	readonly rates: readonly DuesRateHistoryRow[];
	/** The day `isInForce` was decided against, as `YYYY-MM-DD`. */
	readonly today: string;
}

/**
 * The whole Tarif history, newest start date first, each row saying whether it is the one in force
 * today and whether it may still be changed.
 *
 * Newest first because that is the end of the list a superuser opens this screen for — the rate
 * running now and the rise already scheduled after it; the older rows are the explanation of last
 * year's bill, and they are still all here.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listDuesRates(
	db: Database,
	clock: Clock,
	actorId: string
): Promise<DuesRateHistory> {
	await requirePermission(db, actorId, ACTION.manageDuesRates);

	const rows = await db.select().from(duesRates).orderBy(asc(duesRates.effectiveFrom));
	const periods = await billedPeriodsOf(db);
	const windows = new Map(
		duesRateWindows(rows).map((window) => [window.duesRateId, window] as const)
	);

	const today = currentDay(clock);
	const inForceId = rows.findLast((row) => compareText(row.effectiveFrom, today) <= 0)?.id;

	const rates = rows.map((row) => {
		const usedSince = usedSincePeriodFor(row, windows.get(row.id), periods, today);
		return {
			...row,
			isInForce: row.id === inForceId,
			usedSincePeriod: usedSince ?? null,
			isEditable: usedSince === undefined
		};
	});

	return { rates: rates.reverse(), today };
}

/**
 * What the history screen reports about one rate's billing — the same answer `assertNeverBilled` and
 * the arrival exemption give the writes, so that the screen never offers an edit the service refuses,
 * and never hides one it would accept.
 */
function usedSincePeriodFor(
	rate: DuesRatePlacement,
	window: DuesRateWindow | undefined,
	billedPeriods: readonly string[],
	today: string
): string | undefined {
	if (!window || !hasArrived(rate.effectiveFrom, today)) {
		return undefined;
	}
	return usedSincePeriodOf(window, billedPeriods);
}

/** Who is asking, and which rate they are setting. */
export interface CreateDuesRateRequest {
	/** The user making the change. Checked against `ACTION.manageDuesRates` before anything else. */
	readonly actorId: string;
	/** The monthly amount, in whole rupiah. */
	readonly amount: Rupiah;
	/** The first day it applies, as `YYYY-MM-DD`. */
	readonly effectiveFrom: string;
}

/**
 * Sets a new rate.
 *
 * A start date in the past is allowed on its own — backdating is how a rise agreed late is recorded
 * — but not when inserting the rate would take an already-billed Periode away from the rate that
 * priced it. See "Inserting a rate is guarded too" in this module's doc comment.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `amount` is negative or `effectiveFrom` is not a real `YYYY-MM-DD` day.
 * @throws {DuesRateInUseError} naming the rate that owns the billed Periode this one would claim.
 * @throws {DuesRateConflictError} when another rate already starts on that day.
 */
export async function createDuesRate(
	db: Database,
	clock: Clock,
	request: CreateDuesRateRequest
): Promise<DuesRate> {
	assertAmount(request.amount);
	assertDay(request.effectiveFrom, 'effectiveFrom');

	try {
		return await db.transaction(async (transaction) => {
			await requirePermission(transaction, request.actorId, ACTION.manageDuesRates);

			const today = currentDay(clock);
			if (hasArrived(request.effectiveFrom, today)) {
				const { rows, periods } = await loadCalendarForWrite(transaction);
				assertClaimsNothingBilled(rows, periods, request.effectiveFrom);
			}

			const [row] = await transaction
				.insert(duesRates)
				.values({
					amount: request.amount,
					effectiveFrom: request.effectiveFrom,
					createdAt: clock.now()
				})
				.returning();

			await recordAuditEntry(transaction, clock, {
				actorId: request.actorId,
				action: DUES_RATE_CREATED_ACTION,
				targetId: row.id,
				after: { amount: row.amount, effectiveFrom: row.effectiveFrom }
			});

			return row;
		});
	} catch (caught) {
		if (isUniqueViolation(caught)) {
			throw new DuesRateConflictError(request.effectiveFrom);
		}
		throw caught;
	}
}

/** Who is asking, which rate they are changing, and what they are changing it to. */
export interface UpdateDuesRateRequest {
	/** The user making the change. Checked against `ACTION.manageDuesRates` before anything else. */
	readonly actorId: string;
	/** The rate being changed. */
	readonly duesRateId: string;
	/** The new monthly amount, in whole rupiah. */
	readonly amount: Rupiah;
	/** The new first day it applies, as `YYYY-MM-DD`. */
	readonly effectiveFrom: string;
}

/**
 * Changes a rate that has not billed anything, and refuses one that has.
 *
 * Both the window the rate holds today and the window it would hold afterwards are checked — see
 * this module's doc comment for why moving a rate backwards over billed months is the same mistake
 * as editing a used one. Each check is skipped for a date that has not arrived, because a rate that
 * starts later than today has priced nothing.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when `amount` is negative or `effectiveFrom` is not a real `YYYY-MM-DD` day.
 * @throws {DuesRateNotFoundError} when `duesRateId` names no rate.
 * @throws {DuesRateInUseError} naming the first Periode billed, when the rate has been used.
 * @throws {DuesRateConflictError} when another rate already starts on the new day.
 */
export async function updateDuesRate(
	db: Database,
	clock: Clock,
	request: UpdateDuesRateRequest
): Promise<DuesRate> {
	assertAmount(request.amount);
	assertDay(request.effectiveFrom, 'effectiveFrom');

	try {
		return await db.transaction(async (transaction) => {
			await requirePermission(transaction, request.actorId, ACTION.manageDuesRates);

			const { existing, rows, periods } = await loadForWrite(transaction, request.duesRateId);
			assertDayIsFree(rows, request.duesRateId, request.effectiveFrom);

			const today = currentDay(clock);
			if (hasArrived(existing.effectiveFrom, today)) {
				assertNeverBilled(rows, periods, request.duesRateId);
			}
			if (hasArrived(request.effectiveFrom, today)) {
				assertNeverBilled(
					rows.map((row) =>
						row.id === request.duesRateId ? { ...row, effectiveFrom: request.effectiveFrom } : row
					),
					periods,
					request.duesRateId
				);
			}

			const [row] = await transaction
				.update(duesRates)
				.set({ amount: request.amount, effectiveFrom: request.effectiveFrom })
				.where(eq(duesRates.id, request.duesRateId))
				.returning();

			await recordAuditEntry(transaction, clock, {
				actorId: request.actorId,
				action: DUES_RATE_UPDATED_ACTION,
				targetId: row.id,
				before: { amount: existing.amount, effectiveFrom: existing.effectiveFrom },
				after: { amount: row.amount, effectiveFrom: row.effectiveFrom }
			});

			return row;
		});
	} catch (caught) {
		if (isUniqueViolation(caught)) {
			throw new DuesRateConflictError(request.effectiveFrom);
		}
		throw caught;
	}
}

/** Who is asking, and which rate they are removing. */
export interface DeleteDuesRateRequest {
	/** The user making the change. Checked against `ACTION.manageDuesRates` before anything else. */
	readonly actorId: string;
	/** The rate being removed. */
	readonly duesRateId: string;
}

/**
 * Removes a rate that has never billed anything, and refuses one that has.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {DuesRateNotFoundError} when `duesRateId` names no rate.
 * @throws {DuesRateInUseError} naming the first Periode billed, when the rate has been used.
 */
export async function deleteDuesRate(
	db: Database,
	clock: Clock,
	request: DeleteDuesRateRequest
): Promise<DuesRate> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageDuesRates);

		const { existing, rows, periods } = await loadForWrite(transaction, request.duesRateId);

		if (hasArrived(existing.effectiveFrom, currentDay(clock))) {
			assertNeverBilled(rows, periods, request.duesRateId);
		}

		await transaction.delete(duesRates).where(eq(duesRates.id, request.duesRateId));

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: DUES_RATE_DELETED_ACTION,
			targetId: existing.id,
			before: { amount: existing.amount, effectiveFrom: existing.effectiveFrom }
		});

		return existing;
	});
}

/** The whole calendar a write decides against: every rate, and every Periode ever billed. */
interface CalendarForWrite {
	readonly rows: readonly DuesRate[];
	readonly periods: readonly string[];
}

/** That calendar, plus the one row the write is about. */
interface WriteContext extends CalendarForWrite {
	readonly existing: DuesRate;
}

/**
 * Reads everything a write decides from, inside that write's transaction.
 *
 * The rate rows are taken `for update`: a window depends on its neighbours, so two superusers
 * writing to two different rates at the same time would otherwise each decide against a calendar the
 * other is in the middle of changing.
 */
async function loadCalendarForWrite(transaction: Transaction): Promise<CalendarForWrite> {
	const rows = await transaction
		.select()
		.from(duesRates)
		.orderBy(asc(duesRates.effectiveFrom))
		.for('update');

	return { rows, periods: await billedPeriodsOf(transaction) };
}

/**
 * `loadCalendarForWrite` together with the row `duesRateId` names.
 *
 * @throws {DuesRateNotFoundError} when `duesRateId` names no rate.
 */
async function loadForWrite(transaction: Transaction, duesRateId: string): Promise<WriteContext> {
	const calendar = await loadCalendarForWrite(transaction);

	const existing = calendar.rows.find((row) => row.id === duesRateId);
	if (!existing) {
		throw new DuesRateNotFoundError(duesRateId);
	}

	return { ...calendar, existing };
}

/**
 * Whether `day` is today or earlier.
 *
 * A rate starting later than today has priced nothing, whatever its window says: the only reader of
 * a rate is `duesRateOn`, and issuance asks it for a day that has arrived. This is what keeps the
 * conservative month window from locking a rise that is still only scheduled — a Tagihan issued for
 * the month a mid-month rise lands in was priced by the rate that was already running.
 */
function hasArrived(day: string, today: string): boolean {
	return compareText(day, today) <= 0;
}

/**
 * Throws when the rate `duesRateId` names has billed any Periode, given the calendar `rates`
 * describes.
 *
 * @throws {DuesRateInUseError} naming the first Periode billed.
 */
function assertNeverBilled(
	rates: readonly DuesRatePlacement[],
	billedPeriods: readonly string[],
	duesRateId: string
): void {
	const window = duesRateWindows(rates).find((candidate) => candidate.duesRateId === duesRateId);
	if (!window) {
		return;
	}

	const usedSince = usedSincePeriodOf(window, billedPeriods);
	if (usedSince !== undefined) {
		throw new DuesRateInUseError(duesRateId, usedSince);
	}
}

/** The placement a rate about to be inserted stands in while its window is worked out. */
const PROPOSED_RATE = '(proposed)';

/**
 * Throws when inserting a rate that starts on `effectiveFrom` would take an already-billed Periode
 * away from the rate that owns it today.
 *
 * Checking only the new rate's own window is enough to mean "no billed Periode changes owner": a new
 * rate shortens exactly one neighbour, its predecessor, and the months it takes off that
 * predecessor's end are precisely the months its own window gains.
 *
 * @throws {DuesRateInUseError} naming the rate that owns the Periode, and that Periode.
 */
function assertClaimsNothingBilled(
	rates: readonly DuesRatePlacement[],
	billedPeriods: readonly string[],
	effectiveFrom: string
): void {
	const proposed = duesRateWindows([...rates, { id: PROPOSED_RATE, effectiveFrom }]).find(
		(window) => window.duesRateId === PROPOSED_RATE
	);
	const claimed = proposed && usedSincePeriodOf(proposed, billedPeriods);
	if (claimed === undefined) {
		return;
	}

	const owner = duesRateWindows(rates).find((window) => isWithinWindow(claimed, window));
	throw new DuesRateInUseError(owner?.duesRateId ?? PROPOSED_RATE, claimed);
}

/**
 * Throws when a rate other than `duesRateId` already starts on `effectiveFrom`.
 *
 * `dues_rates_effective_from_unique` refuses this anyway, but only once the `update` statement runs —
 * by which point the window rule has already been asked about a calendar holding two rates on one
 * day, and would answer with an in-use refusal naming a Periode the superuser never touched. This
 * says the true reason first.
 *
 * @throws {DuesRateConflictError} naming the day that is taken.
 */
function assertDayIsFree(
	rates: readonly DuesRatePlacement[],
	duesRateId: string,
	effectiveFrom: string
): void {
	const taken = rates.some(
		(rate) => rate.id !== duesRateId && rate.effectiveFrom === effectiveFrom
	);
	if (taken) {
		throw new DuesRateConflictError(effectiveFrom);
	}
}

/**
 * Every Periode any Tagihan has ever been issued for, ascending and without repeats.
 *
 * One query rather than one per rate: the answer is at most one row per month the complex has ever
 * billed, and holding it as data lets the window rule stay a pure function.
 */
async function billedPeriodsOf(db: DatabaseWriter): Promise<readonly string[]> {
	const rows = await db
		.selectDistinct({ period: invoices.period })
		.from(invoices)
		.orderBy(asc(invoices.period));

	return rows.map((row) => row.period);
}

/** The month a `YYYY-MM-DD` day falls in, as `YYYY-MM`. */
function monthOf(day: string): string {
	return day.slice(0, 7);
}

/**
 * The last month a rate still holds when the next one starts on `day`.
 *
 * A successor starting on the first of a month takes that whole month; one starting later in it
 * shares the month, and both rates are then treated as having billed it.
 */
function lastMonthBefore(day: string): string {
	if (day.endsWith('-01')) {
		return previousMonth(monthOf(day));
	}
	return monthOf(day);
}

/** The month before `month`, both as `YYYY-MM`. */
function previousMonth(month: string): string {
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	if (monthNumber === 1) {
		return `${year - 1}-12`;
	}
	return `${year}-${String(monthNumber - 1).padStart(2, '0')}`;
}

/** `-1`, `0` or `1`. Fixed-width, zero-padded ISO days and months sort correctly as plain text. */
function compareText(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

/**
 * Refuses an amount the `dues_rates_amount_check` constraint would refuse anyway, so that the
 * service layer states the rule rather than letting a driver error reach a route as a 500.
 *
 * @throws {TypeError} when `amount` is negative.
 */
function assertAmount(amount: Rupiah): void {
	if (amount < 0) {
		throw new TypeError(`A dues rate amount is never negative, and ${amount} is.`);
	}
}

/**
 * Refuses anything that is not a real calendar day written as `YYYY-MM-DD`.
 *
 * The round-trip through `Date` is what rejects `2026-02-30`, which matches the pattern and is not a
 * day; PostgreSQL would refuse it too, but as a driver error a route could only report as a 500.
 *
 * @throws {TypeError} when `value` is not a real `YYYY-MM-DD` day.
 */
function assertDay(value: string, field: string): void {
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (!DAY_PATTERN.test(value) || Number.isNaN(parsed.getTime())) {
		throw new TypeError(`${field} must be a calendar day written as YYYY-MM-DD, not "${value}".`);
	}
	if (parsed.toISOString().slice(0, 10) !== value) {
		throw new TypeError(`${field} is not a real calendar day: "${value}".`);
	}
}

/**
 * Whether `error` is, or wraps, the PostgreSQL unique-constraint violation that
 * `dues_rates_effective_from_unique` raises.
 *
 * Drizzle wraps driver errors inside its own, so the code is on the `cause` chain rather than on the
 * outermost error — the same walk `isUniqueViolation` in `src/lib/server/services/unit/index.ts`
 * does, for the same reason.
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
