import { asc, eq, ne } from 'drizzle-orm';
import type { Rupiah } from '#lib/money.ts';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import {
	cashCategories,
	SYSTEM_CATEGORY_KEY,
	type CashCategory
} from '../../db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import type { Clock } from '../../ports/clock';
import { SystemCategoryMissingError } from './category';
import { CASH_WRITE_KIND, writeCashTransaction } from './writer';

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
 * - **One in force at a time, and "one" is held by row locks rather than by a check.** The opening
 *   balance in force is an opening-balance row that no Koreksi has reversed (spec #308, decision 3;
 *   `inForceAmong` below says exactly what "reversed" means once a Koreksi is itself corrected).
 *   Recording is refused while one is in force. See `lockOpeningBalanceCategory` below for the
 *   whole argument. The short version: reading "there is
 *   none in force" and then inserting is not atomic under READ COMMITTED, so two concurrent requests
 *   would each read nothing and each insert, and a cash book with two opening balances in force has
 *   no correct total and no path back — there is no update and no delete for a Transaksi Kas.
 * - **No way to change it and no way to remove it, but a reversed one can be replaced.** This module
 *   exports one write, and the cash book is append-only, so a wrong opening balance is corrected
 *   the way every other wrong row is: with a Koreksi (#34). Once that Koreksi stands, the wrong row
 *   is no longer in force and the right one is recorded here. Until #322 a reversed row still
 *   counted as "already recorded", so a wrong opening balance could be reversed but never replaced.
 * - **Its day is not after the earliest Transaksi Kas outside its own category**, when there is
 *   one. A running balance that starts from zero and meets an opening balance partway through is
 *   wrong for every day before it. The same day is allowed: the opening balance is the cash at the
 *   start of that day. The rows of the opening-balance category itself (earlier opening balances
 *   and their Koreksi) are not that earliest transaction, or a reversed opening balance could never
 *   be replaced on its own day. This rule and the one above apply when recording only: rows already
 *   in the book are never checked again.
 * - **The day rule takes no lock shared with other writers.** A manual line dated earlier than the
 *   new opening balance, committed while it is being recorded, is not seen. Spec #308 asks only that
 *   two opening-balance requests serialise, and the other writers (`./transaction.ts`, Payment
 *   verification, the Pengembalian) would each have to take this category's lock for the day rule to
 *   hold under that race, which is a change to them rather than to this module.
 * - **The row is written by the cash book writer, and so answers to the Periode.** Until #315 this
 *   module inserted its own row and skipped the Periode, on the assumption that an opening balance
 *   is always dated before the application was in use. Nothing held that assumption: a superuser
 *   could record one inside a month whose Laporan Bulanan was already published, and the frozen
 *   report stopped matching the book. `writeCashTransaction` in `./writer.ts` now writes the row,
 *   as its `openingBalance` kind, and refuses a day inside a locked Periode like every other row.
 *   The "one in force" rule, the day rule and their locks stay here: the writer holds the rules
 *   true of every row, and this module holds the ones true of the opening balance alone. The lock
 *   order is the category first, then the Periode, which the writer takes last.
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
 * Thrown by `recordOpeningBalance` when this complex already has an opening balance in force. The
 * caller *was* allowed to record it — the guard let them through — so a route answers this as a
 * rejected form (`fail(400, …)`), not as a 403, exactly as `LastSuperuserError` is answered.
 * The class keeps the name it had before #322, when "recorded" and "in force" were the same thing.
 *
 * It is declared here rather than in `src/lib/errors.ts` because this ticket's `writes:` does not
 * include that file — the same surface note `UnitConflictError` carries.
 */
export class OpeningBalanceAlreadyRecordedError extends Error {
	override readonly name = 'OpeningBalanceAlreadyRecordedError';

	/** The transaction that holds the opening balance in force. */
	readonly existingTransactionId: string;

	constructor(existingTransactionId: string) {
		super(
			`This complex already has an opening balance in force, recorded as cash transaction "${existingTransactionId}". Only one is in force at a time: reverse it with a Koreksi first, then record the right one.`
		);
		this.existingTransactionId = existingTransactionId;
	}
}

/**
 * Thrown by `recordOpeningBalance` when the day asked for falls after the earliest Transaksi Kas
 * outside the opening-balance category. A rejected form, like the error above: the request is wrong,
 * not the caller. Declared here for the reason the error above is.
 */
export class OpeningBalanceAfterEarliestCashTransactionError extends Error {
	override readonly name = 'OpeningBalanceAfterEarliestCashTransactionError';

	/** The day the opening balance was asked for, as `YYYY-MM-DD`. */
	readonly occurredOn: string;
	/** The earliest Transaksi Kas outside the opening-balance category. */
	readonly earliestTransactionId: string;
	/** Its day, as `YYYY-MM-DD`: the latest day an opening balance may carry. */
	readonly earliestOccurredOn: string;

	constructor(occurredOn: string, earliestTransactionId: string, earliestOccurredOn: string) {
		super(
			`An opening balance dated ${occurredOn} would fall after the earliest cash transaction, "${earliestTransactionId}" on ${earliestOccurredOn}. It may be dated on ${earliestOccurredOn} or before.`
		);
		this.occurredOn = occurredOn;
		this.earliestTransactionId = earliestTransactionId;
		this.earliestOccurredOn = earliestOccurredOn;
	}
}

/**
 * The opening balance in force: the one no Koreksi has reversed, or `undefined` when there is none,
 * because none was ever recorded or because the one recorded has been reversed. Read without a
 * lock, for the screen; `recordOpeningBalance` decides under its own locks.
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
	return inForceAmong(await linesIn(db, category.id));
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
 * The checks run in this order: permission, amount, day, then, under the locks, the opening balance
 * in force, the earliest Transaksi Kas, and last the Periode, which the writer checks.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when the amount is not strictly positive, or the day is not a real calendar
 *   day written as `YYYY-MM-DD`.
 * @throws {SystemCategoryMissingError} when the migration's seed row is not there.
 * @throws {OpeningBalanceAlreadyRecordedError} when an opening balance is in force.
 * @throws {OpeningBalanceAfterEarliestCashTransactionError} when `occurredOn` falls after the
 *   earliest Transaksi Kas outside the opening-balance category.
 * @throws {PeriodLockedError} when `occurredOn` falls inside a Periode that is locked. Nothing is
 *   written; a superuser reopens the month first.
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
		const inForce = inForceAmong(await linesIn(transaction, category.id));
		if (inForce) {
			throw new OpeningBalanceAlreadyRecordedError(inForce.id);
		}

		const earliest = await earliestTransactionOutside(transaction, category.id);
		if (earliest && request.occurredOn > earliest.occurredOn) {
			throw new OpeningBalanceAfterEarliestCashTransactionError(
				request.occurredOn,
				earliest.id,
				earliest.occurredOn
			);
		}

		const row = await writeCashTransaction(transaction, clock, {
			kind: CASH_WRITE_KIND.openingBalance,
			recordedBy: request.actorId,
			occurredOn: request.occurredOn,
			amount: request.amount,
			description: OPENING_BALANCE_DESCRIPTION
		});

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: OPENING_BALANCE_RECORDED_ACTION,
			targetId: row.id,
			after: { amount: row.amount, occurredOn: row.occurredOn }
		});

		return row;
	});
}

/**
 * The opening balance in force among `lines`, every row of the opening-balance category: the
 * earliest-recorded original row whose chain of Koreksi has even length.
 *
 * "Not reversed" reads the whole chain, not only whether a Koreksi points at the row. Since #323
 * `./writer.ts` refuses an ordinary Koreksi of a Koreksi in this category, so a chain is at most one
 * link long: no Koreksi, in force; a Koreksi, reversed, until a new opening balance replaces it. The
 * even and odd counting stays for rows written before that rule, where a Koreksi of the Koreksi put
 * the opening balance's money back in the book, and counting it as reversed would let a second one
 * be recorded and count the cash twice: a Koreksi of that Koreksi, in force again; and so on.
 *
 * A Koreksi always lands in the category of the line it corrects, so every link of the chain is in
 * `lines`. More than one original can be in force: rows written before this rule, or a Koreksi of a
 * Koreksi written before the writer refused it, after a replacement was recorded. Then the
 * earliest-recorded one answers, so the screen is deterministic; recording is refused either way.
 */
function inForceAmong(lines: readonly CashTransaction[]): CashTransaction | undefined {
	const correctionOf = new Map<string, CashTransaction>();
	for (const line of lines) {
		if (line.correctionOf !== null && !correctionOf.has(line.correctionOf)) {
			correctionOf.set(line.correctionOf, line);
		}
	}

	return lines.find((line) => {
		if (line.correctionOf !== null) {
			return false;
		}
		let reversals = 0;
		for (let next = correctionOf.get(line.id); next; next = correctionOf.get(next.id)) {
			reversals += 1;
		}
		return reversals % 2 === 0;
	});
}

/**
 * Every row of the category, in the order it was recorded. Takes no lock of its own: inside
 * `recordOpeningBalance` it runs under the category lock, which is what keeps the answer current
 * (see `lockOpeningBalanceCategory`).
 */
async function linesIn(writer: DatabaseWriter, categoryId: string): Promise<CashTransaction[]> {
	return writer
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.categoryId, categoryId))
		.orderBy(asc(cashTransactions.createdAt), asc(cashTransactions.id));
}

/**
 * The earliest Transaksi Kas filed outside the category `categoryId`, any kind, a Koreksi included
 * (a Koreksi carries its line's day, so it never moves the answer). Read without a lock: see this
 * module's doc comment on the day rule.
 */
async function earliestTransactionOutside(
	writer: DatabaseWriter,
	categoryId: string
): Promise<Pick<CashTransaction, 'id' | 'occurredOn'> | undefined> {
	const [row] = await writer
		.select({ id: cashTransactions.id, occurredOn: cashTransactions.occurredOn })
		.from(cashTransactions)
		.where(ne(cashTransactions.categoryId, categoryId))
		.orderBy(
			asc(cashTransactions.occurredOn),
			asc(cashTransactions.createdAt),
			asc(cashTransactions.id)
		)
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
 * around it, is what makes "only one opening balance in force" true between two recordings.
 *
 * `db.transaction` runs at PostgreSQL's default READ COMMITTED, where a plain `SELECT` never blocks
 * on another transaction's uncommitted row lock; it just reads the latest *committed* row. So two
 * concurrent calls that each read "no opening balance in force" would each pass the check and each
 * insert, leaving a cash book with two opening balances — a total that is wrong with no way back,
 * because a Transaksi Kas is never updated and never deleted. Taking `.for('update')` on the one
 * category row every opening balance must be filed under gives both calls a single point to
 * contend on: the second blocks here until the first commits, then re-reads and sees the row the
 * first one inserted. It is the lesson `assertNotLastSuperuser` in
 * `src/lib/server/services/user/roles.ts` records, applied to a table that has no row to lock yet —
 * locking the category is what stands in for locking a row that does not exist.
 *
 * **The same lock also orders the recording against a Koreksi of any row in the category**, though
 * the Koreksi never asks for it. A Koreksi lands in its line's category, and inserting it checks
 * `cash_transactions.category_id`'s foreign key (`drizzle/0009_cash_report.sql`), which takes
 * `FOR KEY SHARE` on this row; `FOR UPDATE` conflicts with that. So a Koreksi inserted and not yet
 * committed makes the recording wait here, and the read that follows sees it. That matters for a
 * Koreksi of the Koreksi of an opening balance, which puts that opening balance back in force.
 *
 * #322 considered also locking the category's rows `for update`, to wait for a Koreksi that has
 * locked its line (`./writer.ts` does) but not yet inserted. It deadlocks: the recording holds this
 * row and waits for the line, and the Koreksi holds the line and waits here for its foreign-key
 * check. And it would buy nothing a lock could keep: that Koreksi commits after the recording, which
 * is the same book as one written a minute later, and refusing that one is the Koreksi's rule to
 * hold, not this module's.
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
