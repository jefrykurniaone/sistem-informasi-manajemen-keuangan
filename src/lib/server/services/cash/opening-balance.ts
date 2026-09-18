import { eq } from 'drizzle-orm';
import type { Rupiah } from '$lib/money';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY,
	type CashCategory
} from '../../db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import { SystemCategoryMissingError } from './category';

/**
 * The Saldo awal: how much cash existed on the day the complex started using this application.
 * `docs/spec-kas-laporan-v1.md` settles what it is — "satu Transaksi Kas masuk berkategori sistem
 * tersendiri pada tanggal mulai pemakaian, hanya boleh ada satu, dan hanya bisa dibuat superuser" —
 * and user story 11 says why: without it the running balance never matches the money that is
 * really there.
 *
 * `ACTION.recordOpeningBalance` in `src/lib/server/authz.ts` is granted to `superuser` alone, so
 * both functions below are, today, superuser-only; that is a fact about the permission table, not
 * something re-decided here.
 *
 * Decisions settled here:
 *
 * - **Once, ever, and the "once" is held by a row lock rather than by a check.** See
 *   `lockOpeningBalanceCategory` below for the whole argument. The short version: reading "there is
 *   none yet" and then inserting is not atomic under READ COMMITTED, so two concurrent requests
 *   would each read nothing and each insert, and a cash book with two opening balances has no
 *   correct total and no path back — there is no update and no delete for a Transaksi Kas.
 * - **No way to change it and no way to remove it.** This module exports one write, and the cash
 *   book is append-only, so a wrong opening balance is corrected the way every other wrong row is:
 *   with a Koreksi (#34). Offering an edit here would be the one hole in an append-only book.
 * - **The Periode is not consulted.** Whether a period exists for the date, and whether it is
 *   locked, is #34's and #35's rule; this module never reads or writes `periods`. The opening
 *   balance is by definition dated before the application was in use, so there is no report it
 *   could contradict.
 * - **The description is a constant, not a form field.** The acceptance criteria gives the
 *   superuser two things to fill in, a nominal and a tanggal, while `cash_transactions.description`
 *   is `not null` because a cash book line with no story is unauditable. The text is Indonesian and
 *   stays Indonesian for the same reason the seeded category names "Iuran warga" and "Saldo awal"
 *   do: it is data in the cash book, read by residents in the report, not an interface string a
 *   locale switch should touch.
 */

/** The audit log's `action` for the one opening balance a complex records. */
export const OPENING_BALANCE_RECORDED_ACTION = 'opening_balance_recorded';

/**
 * The `description` every opening-balance row carries. Data, and therefore Indonesian — see this
 * module's doc comment.
 */
export const OPENING_BALANCE_DESCRIPTION = 'Saldo awal kas pada tanggal mulai pemakaian aplikasi.';

/** The shape `occurredOn` has to arrive in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How many characters that shape has, which is also where an ISO instant's day part ends. */
const DAY_LENGTH = 10;

/**
 * Thrown by `recordOpeningBalance` when this complex already has one. The caller *was* allowed to
 * record it — the guard let them through — so a route answers this as a rejected form
 * (`fail(400, …)`), not as a 403, exactly as `LastSuperuserError` is answered.
 *
 * It is declared here rather than in `src/lib/errors.ts` because this ticket's `writes:` does not
 * include that file — the same surface note `UnitConflictError` carries.
 */
export class OpeningBalanceAlreadyRecordedError extends Error {
	override readonly name = 'OpeningBalanceAlreadyRecordedError';

	/** The transaction that already holds this complex's opening balance. */
	readonly existingTransactionId: string;

	constructor(existingTransactionId: string) {
		super(
			`This complex already has an opening balance, recorded as cash transaction "${existingTransactionId}". There is only ever one, and it is corrected with a reversing transaction, never replaced.`
		);
		this.existingTransactionId = existingTransactionId;
	}
}

/**
 * The opening balance this complex recorded, or `undefined` when it has not recorded one yet.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 */
export async function getOpeningBalance(
	db: Database,
	actorId: string
): Promise<CashTransaction | undefined> {
	await requirePermission(db, actorId, ACTION.recordOpeningBalance);

	const category = await openingBalanceCategory(db);
	return findOpeningBalanceIn(db, category.id);
}

/** Who is asking, how much was there, and on which day. */
export interface RecordOpeningBalanceRequest {
	/** The user recording it. Checked against `ACTION.recordOpeningBalance` before anything else. */
	readonly actorId: string;
	/** How much cash existed on `occurredOn`. Strictly positive. */
	readonly amount: Rupiah;
	/** The day the complex started using the application, as `YYYY-MM-DD`. */
	readonly occurredOn: string;
}

/**
 * Records the opening balance: one income Transaksi Kas in the system category `opening-balance`,
 * dated on the day the superuser gives, recorded by them, correcting nothing.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when the amount is not strictly positive, or the day is not a real calendar
 *   day written as `YYYY-MM-DD`.
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 * @throws {OpeningBalanceAlreadyRecordedError} when one has already been recorded.
 */
export async function recordOpeningBalance(
	db: Database,
	clock: Clock,
	request: RecordOpeningBalanceRequest
): Promise<CashTransaction> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.recordOpeningBalance);
		assertPositiveAmount(request.amount);
		assertCalendarDay(request.occurredOn);

		const category = await lockOpeningBalanceCategory(transaction);
		const existing = await findOpeningBalanceIn(transaction, category.id);
		if (existing) {
			throw new OpeningBalanceAlreadyRecordedError(existing.id);
		}

		const [row] = await transaction
			.insert(cashTransactions)
			.values({
				occurredOn: request.occurredOn,
				type: CASH_CATEGORY_TYPE.income,
				categoryId: category.id,
				amount: request.amount,
				description: OPENING_BALANCE_DESCRIPTION,
				recordedBy: request.actorId,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: OPENING_BALANCE_RECORDED_ACTION,
			targetId: row.id,
			after: { amount: row.amount, occurredOn: row.occurredOn }
		});

		return row;
	});
}

/** The opening-balance transaction filed under `categoryId`, when there is one. */
async function findOpeningBalanceIn(
	writer: DatabaseWriter,
	categoryId: string
): Promise<CashTransaction | undefined> {
	const [row] = await writer
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.categoryId, categoryId))
		.limit(1);
	return row;
}

/** The system category `opening-balance`, read without taking any lock. */
async function openingBalanceCategory(writer: DatabaseWriter): Promise<CashCategory> {
	const [row] = await writer
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.openingBalance));
	if (!row) {
		throw new SystemCategoryMissingError(SYSTEM_CATEGORY_KEY.openingBalance);
	}
	return row;
}

/**
 * The same row, locked until the caller's transaction ends — and this lock, not the transaction
 * around it, is what makes "only one opening balance" true.
 *
 * `db.transaction` runs at PostgreSQL's default READ COMMITTED, where a plain `SELECT` never blocks
 * on another transaction's uncommitted row lock; it just reads the latest *committed* row. So two
 * concurrent calls that each read "no opening balance yet" would each pass the check and each
 * insert, leaving a cash book with two opening balances — a total that is wrong with no way back,
 * because a Transaksi Kas is never updated and never deleted. Taking `.for('update')` on the one
 * category row every opening balance must be filed under gives both calls a single point to
 * contend on: the second blocks here until the first commits, then re-reads and sees the row the
 * first one inserted. It is the lesson `assertNotLastSuperuser` in
 * `src/lib/server/services/user/roles.ts` records, applied to a table that has no row to lock yet —
 * locking the category is what stands in for locking a row that does not exist.
 */
async function lockOpeningBalanceCategory(transaction: Transaction): Promise<CashCategory> {
	const [row] = await transaction
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.openingBalance))
		.for('update');
	if (!row) {
		throw new SystemCategoryMissingError(SYSTEM_CATEGORY_KEY.openingBalance);
	}
	return row;
}

/** Refuses an amount the cash book's `amount > 0` check would refuse anyway, but by name. */
function assertPositiveAmount(amount: Rupiah): void {
	if (amount <= 0) {
		throw new TypeError(
			`An opening balance is a positive amount of money, not ${amount}. A complex with no cash on its starting day records none at all.`
		);
	}
}

/**
 * Refuses anything that is not a real calendar day written as `YYYY-MM-DD`.
 *
 * The round trip through `Date` is what makes "real" true, and matching the pattern is not enough
 * on its own: `new Date('2026-02-31')` does not fail, it rolls over to 3 March, so a day that does
 * not exist would otherwise reach PostgreSQL and come back as a driver error nobody named.
 */
function assertCalendarDay(day: string): void {
	const parsed = new Date(`${day}T00:00:00.000Z`);
	if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime())) {
		throw new TypeError(`"${day}" is not a calendar day written as YYYY-MM-DD.`);
	}
	if (parsed.toISOString().slice(0, DAY_LENGTH) !== day) {
		throw new TypeError(`"${day}" is not a day that exists on the calendar.`);
	}
}
