import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rupiah, type Rupiah } from '$lib/money';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import type { Database } from '../../db';
import type { CashTransaction } from '../../db/schema/cash-transaction';
import { refunds, type Refund } from '../../db/schema/refund';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { recordDuesRefund } from '../cash/transaction';
import { currentDay } from '../occupancy/visibility';
import { lockUnallocatedVerifiedPayments } from './credit-balance';
import { UnitNotFoundError } from './queries';

/**
 * Pengembalian: returning part or all of a Unit's Saldo Titipan to its Warga as money out of the
 * kas — user story 23 of `docs/spec-iuran-v1.md` ("superuser mencatat pengembalian sebagai uang
 * keluar yang mengonsumsi saldo itu"), the third of #30's superuser corrections.
 *
 * `ACTION.correctDues` in `src/lib/server/authz.ts` is granted to `superuser` alone, so the one
 * guarded function below is, today, a superuser-only function; that is a fact about the permission
 * table, not something re-decided here.
 *
 * ## The invariant this module answers for
 *
 * Refunded money must be money nothing can spend again. Saldo titipan has exactly one spender —
 * `applyCreditToInvoice`, run by every month's issuance, which drains **per-payment remainders**
 * handed to it by `lockUnallocatedVerifiedPayments` — so a refund is stored per payment: one
 * `refunds` row and one cash expense row for each Pembayaran whose remainder it consumed, drained
 * oldest money first, the same order issuance itself spends. `./credit-balance.ts` subtracts
 * `refunds` beside `allocations` in both of its reads, which yields the two halves of the
 * invariant in one stroke:
 *
 * - **A Pembayaran is never spent past its amount** — allocations plus refunds never exceed it —
 *   because both spenders draw from the same remainder arithmetic under the same lock.
 * - **`verified = allocations + saldo titipan + refunds` holds for every Unit** — the equation
 *   `tests/unit/unit-money-invariant.test.ts` runs — because the refund is a term of the very
 *   subtraction that defines the balance, not a second ledger that could drift from it.
 *
 * ## The locks, and why a concurrent issuance cannot double-spend
 *
 * `lockUnallocatedVerifiedPayments` takes `for update` on every verified Pembayaran of the Unit
 * before this module reads a single remainder — the identical critical section issuance's credit
 * application enters. Two spenders of one Unit's balance therefore serialise on those rows:
 * whichever wins, the loser's locking read completes only after the winner commits, its
 * remainder sums are read in fresh statements that see the winner's rows (allocations or
 * refunds), and the money it offers to spend is only what is genuinely left. A refund racing an
 * issuance can end refused (`amountAboveBalance`) — never doubled.
 * `tests/unit/credit-refund.test.ts` proves the interleaving with a second connection holding an
 * uncommitted claim.
 *
 * The lock order is the fixed one — the payment rows first, the Periode second: every cash row is
 * written through `recordDuesRefund`, whose `requireOpenPeriodFor` takes the Periode share lock
 * only after the payment locks are already held. No writer anywhere takes these two in the other
 * order.
 *
 * ## One action, one audit row, N cash rows
 *
 * A refund that drains several Pembayaran writes one cash expense row per payment — the exact
 * mirror of verification, which writes one income row per payment verified, so the buku kas stays
 * reconcilable payment by payment in both directions. The action itself is still one decision, so
 * it records exactly one audit row, filed against the Unit, with every portion in `after` — the
 * same "one decision, one row" rule `verifyHeldPayment` follows.
 */

/** The audit log's `action` for a Saldo Titipan a superuser returned. */
export const CREDIT_REFUNDED_ACTION = 'credit_refunded';

/** The shape `occurredOn` has to arrive in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How many characters that shape has, which is also where an ISO instant's day part ends. */
const DAY_LENGTH = 10;

/** Milliseconds in a day, for working out the latest day money can already have been returned. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every rule this service refuses a request for, other than permission and other than the locked
 * Periode, which keeps its own named error (`PeriodLockedError`) for the reason `CASH_RULE`
 * records. Refusals of a request, never of the caller: `fail(400, …)` at the route.
 */
export const REFUND_RULE = {
	/** The amount is zero or negative. A refund is a movement of money. */
	amountNotPositive: 'amountNotPositive',
	/** The date is not a real calendar day written as `YYYY-MM-DD`. */
	notACalendarDay: 'notACalendarDay',
	/** The money is claimed to have been handed back on a day that has not arrived. */
	dayInTheFuture: 'dayInTheFuture',
	/** A refund records why — "beserta alasannya" — so an empty reason is refused. */
	reasonMissing: 'reasonMissing',
	/** More money was asked back than the Unit's saldo titipan holds. */
	amountAboveBalance: 'amountAboveBalance'
} as const;

/** One of the rules above. */
export type RefundRule = (typeof REFUND_RULE)[keyof typeof REFUND_RULE];

/**
 * Thrown when this service refuses a request by one of the rules in `REFUND_RULE`. Named and
 * `instanceof`-checkable for the reason `VerificationRuleError` is; it lives here because
 * `src/lib/errors.ts` is outside this ticket's surface.
 */
export class RefundRuleError extends Error {
	override readonly name = 'RefundRuleError';

	/** Which rule refused the request. */
	readonly rule: RefundRule;

	constructor(rule: RefundRule, detail: string) {
		super(`A refund request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** One Pembayaran's part of a refund: the attribution row and the cash row it points at, 1:1. */
export interface RefundedPortion {
	readonly refund: Refund;
	readonly cashTransaction: CashTransaction;
}

/** What one refund came to, all committed together. */
export interface RefundOutcome {
	readonly unitId: string;
	/** The total returned — the sum of the portions, which is the requested amount exactly. */
	readonly amount: Rupiah;
	/** One entry per Pembayaran drained, oldest money first. */
	readonly portions: readonly RefundedPortion[];
}

/** Who is refunding, which Unit, how much, when the money moved, and why. */
export interface RefundCreditRequest {
	/** The signed-in superuser. Checked against `ACTION.correctDues` before anything else. */
	readonly actorId: string;
	/** The house whose saldo titipan is being returned. */
	readonly unitId: string;
	/** How much to return, in whole rupiah. Strictly positive, at most the balance. */
	readonly amount: Rupiah;
	/** The day the money was handed back, as `YYYY-MM-DD`. Not the day this row is typed. */
	readonly occurredOn: string;
	/** Why the money is being returned. Required, and recorded in the audit log. */
	readonly reason: string;
}

/**
 * Returns `amount` of one Unit's Saldo Titipan: the Unit's verified Pembayaran are locked, their
 * remainders drained oldest first, and each drained payment gets one cash expense row in the
 * system category "Iuran warga" and one `refunds` row pointing at it — one transaction, all or
 * nothing, closed by a single audit row.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {UnitNotFoundError} when `unitId` names no house.
 * @throws {RefundRuleError} `amountNotPositive`, `notACalendarDay`, `dayInTheFuture`,
 *   `reasonMissing`, or `amountAboveBalance`.
 * @throws {PeriodLockedError} when `occurredOn` falls inside a Periode that is locked. Nothing is
 *   written; the month is reopened first, or the refund waits.
 */
export async function refundCredit(
	db: Database,
	clock: Clock,
	request: RefundCreditRequest
): Promise<RefundOutcome> {
	const reason = request.reason.trim();

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.correctDues);
		if (reason === '') {
			throw new RefundRuleError(
				REFUND_RULE.reasonMissing,
				'Returning money records why in the audit log, so an empty reason is refused.'
			);
		}
		assertPositiveAmount(request.amount);
		assertRefundDay(request.occurredOn, clock);
		const unit = await requireUnit(transaction, request.unitId);

		// The critical section. `for update` on every verified payment of this Unit — the same locks
		// every other spender of this balance takes — and the remainder sums are read in fresh
		// statements inside them, so they include everything any earlier winner committed.
		const remainders = await lockUnallocatedVerifiedPayments(transaction, request.unitId);
		const balance = remainders.reduce((total, payment) => total + payment.remainder, 0);
		if (request.amount > balance) {
			throw new RefundRuleError(
				REFUND_RULE.amountAboveBalance,
				`The unit's saldo titipan is ${balance}, so ${request.amount} cannot be returned.`
			);
		}

		const portions: RefundedPortion[] = [];
		let left: number = request.amount;
		for (const payment of remainders) {
			if (left <= 0 || payment.remainder <= 0) {
				continue;
			}
			const amount = rupiah(Math.min(left, payment.remainder));

			const cashTransaction = await recordDuesRefund(transaction, clock, {
				occurredOn: request.occurredOn,
				amount,
				// Data in the buku kas, read back by residents in a Laporan Bulanan, so Indonesian —
				// naming the house and the payment, the mirror of `cashDescriptionFor` in
				// `./verification.ts`.
				description: `Pengembalian saldo titipan Blok ${unit.block} No ${unit.number} (pembayaran ${payment.paymentId})`,
				recordedBy: request.actorId
			});
			const [refund] = await transaction
				.insert(refunds)
				.values({
					id: randomUUID(),
					paymentId: payment.paymentId,
					cashTransactionId: cashTransaction.id,
					amount,
					reason,
					refundedBy: request.actorId,
					createdAt: clock.now()
				})
				.returning();

			portions.push({ refund, cashTransaction });
			left -= amount;
		}

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: CREDIT_REFUNDED_ACTION,
			targetId: request.unitId,
			after: {
				// `unitId` repeats the target so `./corrections-history.ts` gathers all three
				// correction actions with one shape of audit query.
				unitId: request.unitId,
				amount: request.amount,
				occurredOn: request.occurredOn,
				reason,
				refunds: portions.map((portion) => ({
					paymentId: portion.refund.paymentId,
					cashTransactionId: portion.refund.cashTransactionId,
					amount: portion.refund.amount
				}))
			}
		});

		return { unitId: request.unitId, amount: request.amount, portions };
	});
}

/** The house named by `unitId`, for the cash rows' keterangan — or the named 404. */
async function requireUnit(
	transaction: Transaction,
	unitId: string
): Promise<{ readonly block: string; readonly number: string }> {
	const [row] = await transaction
		.select({ block: units.block, number: units.number })
		.from(units)
		.where(eq(units.id, unitId))
		.limit(1);
	if (!row) {
		throw new UnitNotFoundError(unitId);
	}
	return row;
}

/** Refuses an amount `refunds_amount_check` would refuse anyway, but by name. */
function assertPositiveAmount(amount: Rupiah): void {
	if (amount <= 0) {
		throw new RefundRuleError(
			REFUND_RULE.amountNotPositive,
			`A refund is a movement of money, so its amount is strictly positive, not ${amount}.`
		);
	}
}

/**
 * Refuses an `occurredOn` that is not a real calendar day, or one that has not arrived — the same
 * checks, with the same one-day slack past the UTC day, as `assertReceiptDay` in
 * `./verification.ts`, thrown as this module's own rule class. Money out draws the same line as
 * money in: a cash book line dated on a day that has not happened is a lie whichever direction
 * the money moved.
 */
function assertRefundDay(day: string, clock: Clock): void {
	const parsed = new Date(`${day}T00:00:00.000Z`);
	if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime())) {
		throw new RefundRuleError(
			REFUND_RULE.notACalendarDay,
			`"${day}" is not a calendar day written as YYYY-MM-DD.`
		);
	}
	if (parsed.toISOString().slice(0, DAY_LENGTH) !== day) {
		throw new RefundRuleError(
			REFUND_RULE.notACalendarDay,
			`"${day}" is not a day that exists on the calendar.`
		);
	}

	const latest = new Date(Date.parse(`${currentDay(clock)}T00:00:00.000Z`) + MILLISECONDS_PER_DAY)
		.toISOString()
		.slice(0, DAY_LENGTH);
	// ISO days compare correctly as plain strings, which is why no date arithmetic happens here.
	if (day > latest) {
		throw new RefundRuleError(
			REFUND_RULE.dayInTheFuture,
			`"${day}" has not arrived; the latest day money can already have been handed back is ${latest}.`
		);
	}
}
