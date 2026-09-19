import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Rupiah } from '$lib/money';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import type { Database } from '../../db';
import type { Allocation } from '../../db/schema/allocation';
import { user } from '../../db/schema/auth';
import type { CashTransaction } from '../../db/schema/cash-transaction';
import {
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	type Payment,
	type PaymentMethod
} from '../../db/schema/payment';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { recordDuesIncome } from '../cash/transaction';
import { currentDay } from '../occupancy/visibility';
import {
	allocatePaymentToInvoices,
	lockOpenInvoicesOfUnit,
	openInvoicesOfUnit,
	planAllocations,
	type AllocationTarget,
	type OpenInvoice,
	type PlannedAllocation
} from './allocation';
import { notifyPaymentRejected, notifyPaymentVerified } from './notification';
import { PAYMENT_RECORDED_ACTION } from './payment';
import { UnitNotFoundError } from './queries';

/**
 * Verifikasi Pembayaran: the single door through which iuran money enters the buku kas.
 * `docs/spec-iuran-v1.md:144-150` defines the operation — one database transaction that changes the
 * Pembayaran's status, writes one Transaksi Kas into the system category "Iuran warga" dated on the
 * day the money was received, and creates the Alokasi — and is explicit that "ketiganya berhasil
 * bersama atau gagal bersama" and that "Transaksi Kas masuk untuk iuran tidak pernah dibuat dengan
 * cara lain".
 *
 * `ACTION.verifyPayments` in `src/lib/server/authz.ts` is granted to `admin` alone, so every guarded
 * function below is, today, an admin-only function; that is a fact about the permission table, not
 * something re-decided here.
 *
 * ## The atomicity argument
 *
 * Everything a verification does happens inside one `db.transaction`, and nothing it does happens
 * anywhere else:
 *
 * - The status flip, the cash row, the allocations and the single audit row are all statements of
 *   that transaction, so PostgreSQL's own atomicity is the whole mechanism — an error thrown
 *   between any two of them rolls back all of them. There is no step outside the transaction
 *   (no file store write, no email) whose failure could leave the inside half-applied, and
 *   `tests/unit/payment-verification.test.ts` proves it by injecting a failure at every step in
 *   turn and reading back an untouched database.
 * - The status columns move in **one** `update`: `payments_verification_check` refuses `status`,
 *   `verifiedBy` and `verifiedAt` written apart, exactly so that no statement boundary exists at
 *   which the row claims a verification that has not finished being decided.
 * - The cash row is written by `recordDuesIncome` in `src/lib/server/services/cash/transaction.ts`,
 *   which takes this transaction, resolves the system category by its `systemKey`, and is the one
 *   insert into that category in the codebase — the manual recording path refuses it by name. That
 *   is what makes "saldo kas dan status tagihan tidak bisa saling bertentangan" structural: the two
 *   are written by one transaction or not at all.
 *
 * ## The locks, and why each is taken
 *
 * 1. **The Pembayaran row, `for update`, before its status is read.** `cancelOwnPayment` in
 *    `./payment.ts` takes the same lock before deleting a pending row, so a resident's "batalkan"
 *    arriving in the same instant as an admin's "verifikasi" serialises: whichever commits second
 *    reads the other's outcome and refuses cleanly (`alreadyDecided` here, or the payment is simply
 *    gone and answered as not found), instead of a cash transaction pointing at a deleted row.
 * 2. **The Unit's open Tagihan, `for update`, before the plan is made** — `lockOpenInvoicesOfUnit`
 *    in `./allocation.ts`, which is what keeps two concurrent verifications of one Unit from both
 *    filling the same remaining amount.
 * 3. **The Periode, `for share`, last** — inside `recordDuesIncome`, against `receivedOn`, which is
 *    the day the cash row is dated on. The order — the rows the money is about first, the Periode
 *    second — is the one `src/lib/server/services/cash/period.ts` fixes for every money write.
 *
 * ## How the Warga's explicit choice reaches this module — a decision, recorded
 *
 * It does not reach it from the recording form, and cannot: `./payment.ts` establishes that the
 * invoice picker on `/payments/new` stores nothing — the only table that could hold "this payment
 * is meant for that invoice" is `allocations`, and writing one before verification would make a
 * Tagihan read as paid on unconfirmed money. So the choice arrives, when it arrives at all, as
 * `invoiceIds` on the verification request: **the verifying admin's selection on the queue screen**,
 * made while looking at the proof — whose transfer note is where a resident's intent actually
 * travels — with the amount the resident's ticking shaped as the corroborating signal.
 *
 * The allocation policy is then: the explicitly selected Tagihan are served first, oldest Periode
 * first among themselves; whatever money is left continues over the Unit's remaining open Tagihan,
 * oldest first — the spec's own ambient rule, "alokasi otomatis, tertua lebih dulu" — and only what
 * no open Tagihan can absorb becomes saldo titipan. "Dihormati lebih dulu" is read literally:
 * honoured first, not exclusively. Capping the money at the explicit set was considered and
 * rejected, because the remainder would sit as saldo titipan while an older Tagihan stood
 * menunggak, and nothing would ever consume it — issuance's automatic use of the balance only
 * reaches Tagihan that do not exist yet.
 *
 * ## The cash payment (user story 17) goes through this same door
 *
 * `recordCashPayment` writes the `payments` row — method `cash`, no proof, the same shape
 * `src/lib/server/db/schema/payment.ts` makes room for — and then runs the very same verification
 * core, in the same transaction. "Langsung terverifikasi dan melewati alur yang sama persis" is
 * therefore true by construction: there is one verification code path, and the cash flow is a
 * caller of it, not a copy.
 *
 * ## The `payment-verified` and `payment-rejected` emails — #31's own, queued after this commits
 *
 * `docs/spec-iuran-v1.md:174-176` names a "pembayaran diverifikasi" email; ticket #31 is the one
 * that wires it, through `./notification.ts`. `verifyPayment`, `recordCashPayment` and
 * `rejectPayment` each call it **after** their `db.transaction` has resolved, never from inside the
 * transaction callback above — an email announcing a verification that rolled back is worse than a
 * late one. `notifyPaymentVerified`/`notifyPaymentRejected` never throw: see that module's doc
 * comment for why a notification failure must never look like this transaction failed too.
 *
 * ## What is deliberately absent
 *
 * - **No second audit row for the cash transaction.** One decision, one row, filed against the
 *   Pembayaran, with the cash row's id and the allocations in `after`. `recordDuesIncome` writes
 *   none for the same reason, and says so.
 */

/** The audit log's `action` for a Pembayaran an admin verified. */
export const PAYMENT_VERIFIED_ACTION = 'payment_verified';

/** The audit log's `action` for a Pembayaran an admin turned down. */
export const PAYMENT_REJECTED_ACTION = 'payment_rejected';

/** The shape `receivedOn` has to arrive in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How many characters that shape has, which is also where an ISO instant's day part ends. */
const DAY_LENGTH = 10;

/** Milliseconds in a day, for working out the latest `receivedOn` a cash payment may carry. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every rule this service refuses a request for, other than permission and other than the locked
 * Periode, which keeps its own named error (`PeriodLockedError` — see the note on `CASH_RULE` in
 * `src/lib/server/services/cash/transaction.ts` for why it is a class of its own).
 *
 * These are named refusals of a specific request, not of the caller: the admin was inside their
 * rights and the request itself is what is wrong, so a route answers them with `fail(400, …)`
 * rather than a 403 — the split `PAYMENT_RULE` and `CASH_RULE` already draw. The queue screen maps
 * every one of them through an exhaustive `Record`, so a rule added later is a type error there
 * until somebody writes the sentence an admin reads.
 *
 * They are a set of their own rather than additions to `PAYMENT_RULE` because `./payment.ts` is
 * #28's landed surface, which this ticket reads and never edits.
 */
export const VERIFICATION_RULE = {
	/** The payment has already been verified or rejected. There is no second decision. */
	alreadyDecided: 'alreadyDecided',
	/**
	 * The verifying admin has no `residents` row. `payments.verifiedBy` and `payments.recordedBy`
	 * both reference `residents.id`, so there is nowhere to attribute the decision — the same shape
	 * `authorNotRegistered` has in `src/lib/server/services/post/index.ts`.
	 */
	actorNotRegistered: 'actorNotRegistered',
	/** A rejection carries no reason. The Warga is owed the why — user story 16. */
	reasonMissing: 'reasonMissing',
	/**
	 * An explicitly selected Tagihan is not one of this Unit's open Tagihan — cancelled, another
	 * house's, or an id no screen ever rendered. All three are one refusal on purpose: each means
	 * the form and the database disagree, and the admin re-reads the queue either way.
	 */
	unknownInvoiceSelected: 'unknownInvoiceSelected',
	/** The cash payment's amount is zero or negative. A payment is a movement of money. */
	amountNotPositive: 'amountNotPositive',
	/** The cash payment's date is not a real calendar day written as `YYYY-MM-DD`. */
	notACalendarDay: 'notACalendarDay',
	/** The money is claimed to have changed hands on a day that has not arrived. */
	receivedInTheFuture: 'receivedInTheFuture'
} as const;

/** One of the rules above. */
export type VerificationRule = (typeof VERIFICATION_RULE)[keyof typeof VERIFICATION_RULE];

/**
 * Thrown when this service refuses a request by one of the rules in `VERIFICATION_RULE`.
 *
 * Named and `instanceof`-checkable for the reason `PaymentRuleError` is: a route tells this apart
 * from "something broke" by catching the class and reading `rule`, never by matching a message. It
 * lives here rather than in `src/lib/errors.ts` because that file is outside this ticket's surface.
 */
export class VerificationRuleError extends Error {
	override readonly name = 'VerificationRuleError';

	/** Which rule refused the request. */
	readonly rule: VerificationRule;

	constructor(rule: VerificationRule, detail: string) {
		super(`A verification request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/**
 * Thrown when `paymentId` names no Pembayaran at all.
 *
 * A named 404 rather than the indistinguishable `PermissionDeniedError` that `./payment.ts` gives a
 * resident, and the difference is deliberate: the resident-facing refusal hides whether an id
 * exists because the caller may be probing somebody else's payments, while the caller here has
 * already proven `ACTION.verifyPayments` and is entitled to the whole queue — the honest answer to
 * a stale id is "that row is gone", the same shape `CashTransactionNotFoundError` takes.
 */
export class PaymentNotFoundError extends Error {
	override readonly name = 'PaymentNotFoundError';

	/** The id that named no payment. */
	readonly paymentId: string;

	constructor(paymentId: string) {
		super(`No payment exists with id "${paymentId}".`);
		this.paymentId = paymentId;
	}
}

/** One Pembayaran waiting on the queue, with everything the deciding screen shows about it. */
export interface PendingPayment {
	readonly paymentId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/** Who recorded it — the payer, read off the account behind `recordedBy`. */
	readonly recordedByName: string;
	readonly amount: Rupiah;
	/** The day the money changed hands, as `YYYY-MM-DD` — the day the cash row will be dated on. */
	readonly receivedOn: string;
	readonly method: PaymentMethod;
	/**
	 * The `FileStore` key of the proof. The key, never a URL: the signed link is minted by the page
	 * that renders it, so it is minutes old when the admin clicks it — the rule
	 * `(app)/payments/+page.server.ts` records.
	 */
	readonly proofFileKey: string | null;
	readonly recordedAt: Date;
	/**
	 * The Unit's open Tagihan, oldest first, so the deciding screen can offer the explicit choice
	 * and show what the automatic rule would do. Read without locks — it is a display, and the
	 * verification transaction re-reads the same rows under `for update` before anything is written.
	 */
	readonly openInvoices: readonly OpenInvoice[];
}

/**
 * Whether `actorId` may work the verification queue at all, as a question on its own — for the
 * cash-payment screen, whose `load` is a form with nothing on it but a unit list. The same helper,
 * for the same reason, as `assertMayRecordCashTransactions`.
 *
 * @throws {PermissionDeniedError} when `actorId` may not verify a Pembayaran.
 */
export async function assertMayVerifyPayments(db: Database, actorId: string): Promise<void> {
	await requirePermission(db, actorId, ACTION.verifyPayments);
}

/**
 * Every Pembayaran still waiting to be decided, oldest first — the antrean of user story 14, in the
 * order the money arrived rather than the order the screen happened to be refreshed in.
 *
 * @throws {PermissionDeniedError} when `actorId` may not verify a Pembayaran.
 */
export async function listPendingPayments(
	db: Database,
	actorId: string
): Promise<readonly PendingPayment[]> {
	await requirePermission(db, actorId, ACTION.verifyPayments);

	const rows = await db
		.select({
			paymentId: payments.id,
			unitId: payments.unitId,
			block: units.block,
			number: units.number,
			recordedByName: user.name,
			amount: payments.amount,
			receivedOn: payments.receivedOn,
			method: payments.method,
			proofFileKey: payments.proofFileKey,
			recordedAt: payments.createdAt
		})
		.from(payments)
		.innerJoin(units, eq(units.id, payments.unitId))
		.innerJoin(residents, eq(residents.id, payments.recordedBy))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(payments.status, PAYMENT_STATUS.pending))
		// `id` breaks the tie so two payments recorded in the same instant keep one queue order.
		.orderBy(asc(payments.createdAt), asc(payments.id));

	const invoicesByUnit = new Map<string, readonly OpenInvoice[]>();
	for (const unitId of new Set(rows.map((row) => row.unitId))) {
		invoicesByUnit.set(unitId, await openInvoicesOfUnit(db, unitId));
	}

	return rows.map((row) => ({ ...row, openInvoices: invoicesByUnit.get(row.unitId) ?? [] }));
}

/** One house the cash-payment form offers. */
export interface CashPayableUnit {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
}

/**
 * Every active Unit, in the order a street sign reads — the cash-payment form's unit picker.
 *
 * Guarded by the verification action rather than by a unit-management one, because the admin
 * recording a deposit does not hold `manageUnits`; the same reasoning that lets
 * `listActiveCashCategories` fill the manual cash form. Active units only: a deactivated Unit is
 * not a house any more, and a payment for one is not something an admin records over a counter.
 *
 * @throws {PermissionDeniedError} when `actorId` may not verify a Pembayaran.
 */
export async function listCashPayableUnits(
	db: Database,
	actorId: string
): Promise<readonly CashPayableUnit[]> {
	await requirePermission(db, actorId, ACTION.verifyPayments);
	const rows = await db
		.select({ unitId: units.id, block: units.block, number: units.number })
		.from(units)
		.where(eq(units.isActive, true))
		.orderBy(asc(units.block), asc(units.number));
	return rows;
}

/** What one verification produced, all committed together. */
export interface VerificationOutcome {
	/** The Pembayaran as it now stands: `verified`, with its verifier and instant. */
	readonly payment: Payment;
	/** The one cash book row this verification wrote, dated on `receivedOn`. */
	readonly cashTransaction: CashTransaction;
	/** The Alokasi it created, in the order they were planned. Empty when everything became saldo titipan. */
	readonly allocations: readonly Allocation[];
}

/** Who is verifying, which payment, and the Tagihan the admin explicitly chose, when any. */
export interface VerifyPaymentRequest {
	/** The signed-in admin. Checked against `ACTION.verifyPayments` before anything else. */
	readonly actorId: string;
	readonly paymentId: string;
	/**
	 * The Tagihan to serve first — the explicit choice. Empty or absent means the automatic rule
	 * decides everything. See this module's doc comment for the whole policy.
	 */
	readonly invoiceIds?: readonly string[];
}

/**
 * Verifies one pending Pembayaran: status to `verified`, one cash row into "Iuran warga" dated on
 * `receivedOn`, and the Alokasi — one transaction, all or nothing.
 *
 * @throws {PermissionDeniedError} when `actorId` may not verify a Pembayaran.
 * @throws {PaymentNotFoundError} when `paymentId` names no payment.
 * @throws {VerificationRuleError} `alreadyDecided`, `actorNotRegistered`, or
 *   `unknownInvoiceSelected`.
 * @throws {PeriodLockedError} when `receivedOn` falls inside a Periode that is locked. Nothing is
 *   written; the month is reopened first, or the payment waits.
 */
export async function verifyPayment(
	db: Database,
	clock: Clock,
	request: VerifyPaymentRequest
): Promise<VerificationOutcome> {
	const outcome = await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.verifyPayments);
		const verifierResidentId = await requireActorResidentId(transaction, request.actorId);

		const payment = await lockPendingPayment(transaction, request.paymentId);
		return verifyHeldPayment(transaction, clock, {
			actorId: request.actorId,
			verifierResidentId,
			payment,
			invoiceIds: request.invoiceIds ?? []
		});
	});

	await notifyPaymentVerified(db, clock, outcome.payment, outcome.allocations);
	return outcome;
}

/** Who is rejecting, which payment, and the reason the Warga will read. */
export interface RejectPaymentRequest {
	/** The signed-in admin. Checked against `ACTION.verifyPayments` before anything else. */
	readonly actorId: string;
	readonly paymentId: string;
	/** Why it was turned down. Required — user story 16. */
	readonly reason: string;
}

/**
 * Turns one pending Pembayaran down, with a reason and nothing else: no cash transaction, no
 * allocation, no Periode consulted — no money moved, so there is nothing for a locked month to
 * refuse and nothing for the cash book to record.
 *
 * The status and the reason move in one `update`; `verifiedBy` and `verifiedAt` stay null, which is
 * the combination `payments_verification_check` demands of a rejected row. No `residents` row is
 * required of the actor: unlike a verification, a rejection stores no resident reference — the
 * audit row carries who did it, keyed by account, which is `docs/spec-iuran-v1.md:171-172`'s answer
 * to "who rejected".
 *
 * @throws {PermissionDeniedError} when `actorId` may not verify a Pembayaran.
 * @throws {PaymentNotFoundError} when `paymentId` names no payment.
 * @throws {VerificationRuleError} `alreadyDecided` or `reasonMissing`.
 */
export async function rejectPayment(
	db: Database,
	clock: Clock,
	request: RejectPaymentRequest
): Promise<Payment> {
	const reason = request.reason.trim();

	const row = await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.verifyPayments);
		if (reason === '') {
			throw new VerificationRuleError(
				VERIFICATION_RULE.reasonMissing,
				'Rejecting a payment tells the payer what to fix, so an empty reason is refused.'
			);
		}

		const payment = await lockPendingPayment(transaction, request.paymentId);

		const [rejected] = await transaction
			.update(payments)
			.set({ status: PAYMENT_STATUS.rejected, rejectionReason: reason })
			.where(eq(payments.id, payment.id))
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: PAYMENT_REJECTED_ACTION,
			targetId: rejected.id,
			before: { status: payment.status },
			after: { status: rejected.status, reason }
		});

		return rejected;
	});

	await notifyPaymentRejected(db, clock, row);
	return row;
}

/** Who is recording a deposit handed over in person, for which house, and how much. */
export interface RecordCashPaymentRequest {
	/** The signed-in admin. Checked against `ACTION.verifyPayments` before anything else. */
	readonly actorId: string;
	/** The house the money is for. Any active Unit — the payer handed cash over, not a form. */
	readonly unitId: string;
	/** How much changed hands, in whole rupiah. Strictly positive. */
	readonly amount: Rupiah;
	/** The day the money changed hands, as `YYYY-MM-DD`. Not the day this row is typed. */
	readonly receivedOn: string;
	/** The Tagihan to serve first, when the depositor named months. Absent means oldest-first. */
	readonly invoiceIds?: readonly string[];
}

/**
 * Records a Pembayaran an admin took in cash, and verifies it in the same breath — user story 17,
 * "pembayaran itu langsung terverifikasi", through **the same code path** every transfer goes
 * through, so nothing about allocation, the cash row or the audit trail can differ between the two.
 *
 * The row it writes: method `cash`, no proof — money handed over in person has no transfer receipt
 * to photograph, which is why `payments.proofFileKey` is nullable — `recordedBy` the admin's own
 * `residents` row, exactly as `src/lib/server/db/schema/payment.ts` describes user story 17. A
 * `payment_recorded` audit row is written for the recording and a `payment_verified` one for the
 * verification, so the trail reads the same as a transfer's: recorded, then verified — here in one
 * transaction, by one actor.
 *
 * @throws {PermissionDeniedError} when `actorId` may not verify a Pembayaran.
 * @throws {UnitNotFoundError} when `unitId` names no house.
 * @throws {VerificationRuleError} `actorNotRegistered`, `amountNotPositive`, `notACalendarDay`,
 *   `receivedInTheFuture`, or `unknownInvoiceSelected`.
 * @throws {PeriodLockedError} when `receivedOn` falls inside a Periode that is locked.
 */
export async function recordCashPayment(
	db: Database,
	clock: Clock,
	request: RecordCashPaymentRequest
): Promise<VerificationOutcome> {
	const outcome = await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.verifyPayments);
		const verifierResidentId = await requireActorResidentId(transaction, request.actorId);

		const [unit] = await transaction
			.select({ id: units.id })
			.from(units)
			.where(eq(units.id, request.unitId))
			.limit(1);
		if (!unit) {
			throw new UnitNotFoundError(request.unitId);
		}
		assertPositiveAmount(request.amount);
		assertReceiptDay(request.receivedOn, clock);

		const [payment] = await transaction
			.insert(payments)
			.values({
				id: randomUUID(),
				unitId: request.unitId,
				recordedBy: verifierResidentId,
				amount: request.amount,
				receivedOn: request.receivedOn,
				method: PAYMENT_METHOD.cash,
				proofFileKey: null,
				status: PAYMENT_STATUS.pending,
				rejectionReason: null,
				verifiedBy: null,
				verifiedAt: null,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: PAYMENT_RECORDED_ACTION,
			targetId: payment.id,
			after: {
				unitId: payment.unitId,
				amount: payment.amount,
				receivedOn: payment.receivedOn,
				method: payment.method,
				status: payment.status
			}
		});

		return verifyHeldPayment(transaction, clock, {
			actorId: request.actorId,
			verifierResidentId,
			payment,
			invoiceIds: request.invoiceIds ?? []
		});
	});

	await notifyPaymentVerified(db, clock, outcome.payment, outcome.allocations);
	return outcome;
}

/** Everything `verifyHeldPayment` needs, resolved and locked by its caller. */
interface HeldVerification {
	/** The verifying admin's account, for the audit row and the cash row's `recordedBy`. */
	readonly actorId: string;
	/** The same admin's `residents` row, for `payments.verifiedBy`. */
	readonly verifierResidentId: string;
	/** The pending row, either locked `for update` or inserted by this same transaction. */
	readonly payment: Payment;
	/** The explicit choice. Empty means the automatic rule decides everything. */
	readonly invoiceIds: readonly string[];
}

/**
 * The one verification core — `verifyPayment` and `recordCashPayment` both end here, inside their
 * own transaction, holding the payment row. The steps, in the lock order this module's doc comment
 * fixes: the Unit's open Tagihan are locked and the plan is made; the status flips in one `update`;
 * the cash row is written (which asks the Periode, last); the Alokasi land; one audit row records
 * the lot.
 */
async function verifyHeldPayment(
	transaction: Transaction,
	clock: Clock,
	held: HeldVerification
): Promise<VerificationOutcome> {
	const { payment } = held;

	const openInvoices = await lockOpenInvoicesOfUnit(transaction, payment.unitId);
	const plan = planAllocations(payment.amount, allocationTargets(openInvoices, held.invoiceIds));

	const [verified] = await transaction
		.update(payments)
		// One statement: `payments_verification_check` refuses the three columns written apart.
		.set({
			status: PAYMENT_STATUS.verified,
			verifiedBy: held.verifierResidentId,
			verifiedAt: clock.now()
		})
		.where(eq(payments.id, payment.id))
		.returning();

	const cashTransaction = await recordDuesIncome(transaction, clock, {
		occurredOn: payment.receivedOn,
		amount: payment.amount,
		description: await cashDescriptionFor(transaction, payment),
		recordedBy: held.actorId
	});

	const written = await allocatePaymentToInvoices(transaction, clock, payment.id, plan);

	await recordAuditEntry(transaction, clock, {
		actorId: held.actorId,
		action: PAYMENT_VERIFIED_ACTION,
		targetId: payment.id,
		before: { status: payment.status },
		after: {
			status: verified.status,
			amount: payment.amount,
			receivedOn: payment.receivedOn,
			method: payment.method,
			cashTransactionId: cashTransaction.id,
			allocations: plan,
			// What this payment adds to the Unit's saldo titipan — recorded as the number it was at
			// this instant, while the balance itself stays computed and never stored.
			unallocatedRemainder: payment.amount - plannedTotal(plan)
		}
	});

	return { payment: verified, cashTransaction, allocations: written };
}

/**
 * The targets in the order the plan serves them: the explicitly chosen Tagihan first, oldest
 * Periode first among themselves, then every other open Tagihan, oldest first. `openInvoices`
 * arrives already oldest-first from `lockOpenInvoicesOfUnit`, so both halves inherit that order by
 * partitioning it rather than sorting twice.
 *
 * @throws {VerificationRuleError} `unknownInvoiceSelected` when an explicit id is not one of the
 *   Unit's open Tagihan.
 */
function allocationTargets(
	openInvoices: readonly OpenInvoice[],
	explicitIds: readonly string[]
): readonly AllocationTarget[] {
	const open = new Set(openInvoices.map((invoice) => invoice.invoiceId));
	for (const invoiceId of explicitIds) {
		if (!open.has(invoiceId)) {
			throw new VerificationRuleError(
				VERIFICATION_RULE.unknownInvoiceSelected,
				`"${invoiceId}" is not one of this unit's open invoices; the queue was stale or the id was forged either way.`
			);
		}
	}

	const explicit = new Set(explicitIds);
	const chosen = openInvoices.filter((invoice) => explicit.has(invoice.invoiceId));
	const rest = openInvoices.filter((invoice) => !explicit.has(invoice.invoiceId));
	return [...chosen, ...rest].map((invoice) => ({
		invoiceId: invoice.invoiceId,
		remaining: invoice.remainingAmount
	}));
}

/** The sum a plan spends, for the remainder the audit row records. */
function plannedTotal(plan: readonly PlannedAllocation[]): number {
	return plan.reduce((total, planned) => total + planned.amount, 0);
}

/**
 * The cash book line's keterangan: which house's iuran, and which Pembayaran carried it. Data in
 * the book — read back by residents in a Laporan Bulanan — so Indonesian, like
 * `OPENING_BALANCE_DESCRIPTION`. The payment id is in it because `cash_transactions` deliberately
 * has no column pointing at a payment, and the audit row is keyed the other way around.
 */
async function cashDescriptionFor(transaction: Transaction, payment: Payment): Promise<string> {
	const [unit] = await transaction
		.select({ block: units.block, number: units.number })
		.from(units)
		.where(eq(units.id, payment.unitId))
		.limit(1);
	const house = unit ? `Blok ${unit.block} No ${unit.number}` : payment.unitId;
	return `Iuran warga ${house} (pembayaran ${payment.id})`;
}

/**
 * The Pembayaran named by `paymentId`, locked `for update` and still pending — the same lock, on
 * the same row, that `cancelOwnPayment` takes, which is what serialises a cancellation against a
 * decision. See this module's doc comment.
 *
 * @throws {PaymentNotFoundError} when the id names no row.
 * @throws {VerificationRuleError} `alreadyDecided` when the row is no longer pending.
 */
async function lockPendingPayment(transaction: Transaction, paymentId: string): Promise<Payment> {
	const [row] = await transaction
		.select()
		.from(payments)
		.where(eq(payments.id, paymentId))
		.limit(1)
		.for('update');
	if (!row) {
		throw new PaymentNotFoundError(paymentId);
	}
	if (row.status !== PAYMENT_STATUS.pending) {
		throw new VerificationRuleError(
			VERIFICATION_RULE.alreadyDecided,
			`Payment "${row.id}" is "${row.status}", and only a pending payment can be decided.`
		);
	}
	return row;
}

/**
 * The `residents.id` behind the verifying admin, or the refusal that says there is none.
 *
 * @throws {VerificationRuleError} `actorNotRegistered`.
 */
async function requireActorResidentId(transaction: Transaction, actorId: string): Promise<string> {
	const [row] = await transaction
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, actorId))
		.limit(1);
	if (!row) {
		throw new VerificationRuleError(
			VERIFICATION_RULE.actorNotRegistered,
			`User "${actorId}" has no residents row, and payments.verifiedBy references residents.id.`
		);
	}
	return row.id;
}

/**
 * Refuses an amount `payments_amount_check` would let through — the same check, for the same
 * reason, as `recordPayment`'s copy in `./payment.ts`.
 */
function assertPositiveAmount(amount: Rupiah): void {
	if (amount <= 0) {
		throw new VerificationRuleError(
			VERIFICATION_RULE.amountNotPositive,
			`A payment is a movement of money, so its amount is strictly positive, not ${amount}.`
		);
	}
}

/**
 * Refuses a `receivedOn` that is not a real calendar day, or one that has not arrived — a copy of
 * `assertReceiptDay` in `./payment.ts`, thrown as this module's own rule class, because that
 * module's exported surface is #28's and this ticket only reads it. The one-day slack past the UTC
 * day is that copy's decision and is kept identical, so the admin's cash form and the resident's
 * transfer form draw the same line.
 */
function assertReceiptDay(day: string, clock: Clock): void {
	const parsed = new Date(`${day}T00:00:00.000Z`);
	if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime())) {
		throw new VerificationRuleError(
			VERIFICATION_RULE.notACalendarDay,
			`"${day}" is not a calendar day written as YYYY-MM-DD.`
		);
	}
	if (parsed.toISOString().slice(0, DAY_LENGTH) !== day) {
		throw new VerificationRuleError(
			VERIFICATION_RULE.notACalendarDay,
			`"${day}" is not a day that exists on the calendar.`
		);
	}

	const latest = new Date(Date.parse(`${currentDay(clock)}T00:00:00.000Z`) + MILLISECONDS_PER_DAY)
		.toISOString()
		.slice(0, DAY_LENGTH);
	// ISO days compare correctly as plain strings, which is why no date arithmetic happens here.
	if (day > latest) {
		throw new VerificationRuleError(
			VERIFICATION_RULE.receivedInTheFuture,
			`"${day}" has not arrived; the latest day money can already have changed hands is ${latest}.`
		);
	}
}
