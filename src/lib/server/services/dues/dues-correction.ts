import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { NotFoundError, RuleViolationError } from '#lib/errors.ts';
import type { Rupiah } from '#lib/money.ts';
import { auditEntriesFor, recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { allocations, type Allocation } from '../../db/schema/allocation';
import { cashTransactions, type CashTransaction } from '../../db/schema/cash-transaction';
import { invoices, type Invoice } from '../../db/schema/invoice';
import { PAYMENT_STATUS, payments, type Payment } from '../../db/schema/payment';
import { refunds, type Refund } from '../../db/schema/refund';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import { announceAfterCommit } from '../../email/announce';
import { PAYMENT_REJECTED_KIND } from '../../email/templates/payment-rejected';
import type { Clock } from '../../ports/clock';
import { recordDuesRefund } from '../cash/transaction';
import { CASH_WRITE_KIND, writeCashTransaction } from '../cash/writer';
import { isUuid } from '../identifier';
import { currentDay } from '../occupancy/visibility';
import { planCreditSpend } from './allocation';
import { lockUnallocatedVerifiedPayments, refundInForce } from './credit-balance';
import { notifyPaymentRejected } from './notification';
import { UnitNotFoundError } from './queries';
import {
	PAYMENT_VERIFIED_ACTION,
	PaymentNotFoundError,
	type PaymentVerifiedAfter
} from './verification';

/**
 * The dues-correction module (koreksi iuran, spec #308 decision 4): the superuser's corrections of
 * the dues side, and the typed Audit Log record each one leaves. Today it holds five actions: the
 * first three landed by #30 and gathered here by #324, the fourth added by #329, the fifth by #331:
 *
 * - **Pembatalan Tagihan** (`voidInvoice`): one Tagihan marked `void` with a reason, never deleted.
 * - **Pelepasan Alokasi** (`releaseAllocation`): one Alokasi deleted, its money Saldo Titipan again.
 * - **Pengembalian** (`refundCredit`): part of a Unit's Saldo Titipan paid back out of the kas.
 * - **Pembatalan Pengembalian** (`reverseRefund`, spec #308 decision 6): one Pengembalian's cash
 *   expense reversed by a Koreksi, its money Saldo Titipan again.
 * - **Pembatalan verifikasi** (`unverifyPayment`, spec #308 decision 5): a verified Pembayaran
 *   turned rejected, every Alokasi of it released, and its income line reversed by a Koreksi.
 *
 * The corrections history in
 * `./corrections-history.ts` reads the records through the types declared here, and the old homes
 * of the first three actions (`./invoice-void.ts`, `./allocation-release.ts`, `./credit-refund.ts`)
 * only re-export from here, because `src/lib/server/route-action.ts` and
 * `tests/unit/unit-money-invariant.test.ts` import from those paths.
 *
 * `ACTION.correctDues` in `src/lib/server/authz.ts` is granted to `superuser` alone, so every
 * action below is, today, a superuser-only action; that is a fact about the permission table, not
 * something re-decided here.
 *
 * ## What every action shares, and where it is held
 *
 * Before #324 each of the three repeated the permission check, the reason check, the actor lookup
 * and its audit row. Now:
 *
 * - **The right, the reason and the record** are `runDuesCorrection`'s, the private run every
 *   action goes through. It trims the reason, opens the one transaction, checks
 *   `ACTION.correctDues`, refuses a reason that is empty once trimmed, hands the action its
 *   transaction and the trimmed reason, and writes the action's one Audit Log record as the last
 *   statement of the transaction. An action does not call `recordAuditEntry` itself: it returns its
 *   record, so it can neither forget it nor write two.
 * - **The refusal for an empty reason stays each action's own** (`VOID_RULE.reasonMissing`,
 *   `RELEASE_RULE.reasonMissing`, `REFUND_RULE.reasonMissing`, `REVERSE_REFUND_RULE.reasonMissing`,
 *   `UNVERIFY_RULE.reasonMissing`),
 *   handed to the run as a callback. The finance screen maps each rule set through an exhaustive
 *   `Record` to that action's sentence, so one shared class would change what the screen says.
 * - **The actor lookup** is `requireActorResidentId`, for an action that stores a `residents`
 *   reference to its actor. Today that is only Pembatalan Tagihan (`invoices.voidedBy`): a release
 *   and a refund attribute by account (`refunds.refundedBy` is a `user.id`) and never needed a
 *   `residents` row, so they do not look one up. Nor does a Pembatalan Pengembalian, whose Koreksi
 *   is attributed by account as well (`cash_transactions.recordedBy` is a `user.id`), nor a
 *   Pembatalan verifikasi, which clears `payments.verifiedBy` rather than writing a resident into it
 *   and attributes its Koreksi by account.
 *
 * ## The typed Audit Log record (the decision #324 makes)
 *
 * Before #324 the history read each audit row's `jsonb` by raw field name, so a field renamed by a
 * writer showed up empty on the screen and no test failed. The record is now one TypeScript type
 * per action (`DuesCorrectionRecord` is their union):
 *
 * - **The shape is the audit row's own**: `action`, `targetId`, `before`, `after`, everything
 *   `recordAuditEntry` takes except the actor, whom the run supplies. Each record's JSON is exactly
 *   what #30's writer stored, unchanged since `9a9a78e`, so every row already in a database reads
 *   back through its type and nothing is rewritten.
 * - **Every `after` extends `DuesCorrectionAfter`**: the Unit, which is the key the history finds
 *   one Unit's corrections by (`DUES_CORRECTION_UNIT_KEY`), and the trimmed reason. The history
 *   reads both without knowing which action wrote the row, and an action whose `after` lacks either
 *   does not compile.
 * - **The writer** builds its record as an object literal that `satisfies` its type, so a field
 *   missing, extra or renamed is a compile error in the action. (`satisfies`, because the literal is
 *   returned from a callback whose result type is inferred, where TypeScript would otherwise not
 *   check it for extra fields.)
 * - **The reader** turns a stored row back into its type through `readDuesCorrectionRecord`, which
 *   checks every field the type declares against `RECORD_KINDS`. That table holds, per action, a
 *   check whose field list is keyed by the record type itself, and the action's history summary
 *   (`DuesCorrectionSummary`). A field renamed in a record type is therefore a compile error in the
 *   writer, the check and the summary at once, and `tests/unit/dues-correction.test.ts` reads back
 *   the rows the actions really wrote. A stored row that is not its action's record reads as
 *   `undefined`; the history still lists it, with the blank reason and empty amount the untyped
 *   reader showed for a missing field, rather than handing the screen an `undefined` the type
 *   promised was a string.
 *
 * ### How a new action joins
 *
 * 1. Its `…_ACTION` constant and its record interface, added to `DuesCorrectionRecord`.
 * 2. Its entry in `RECORD_KINDS`: the table is typed over every action, so the module does not
 *    compile until the entry exists. `DUES_CORRECTION_ACTIONS`, which the history query asks for, is
 *    read off the same table.
 * 3. Its entry point, through `runDuesCorrection`, returning its record as a literal that
 *    `satisfies` the record type.
 * 4. Its label on the finance screen, whose `HISTORY_LABELS` is an exhaustive `Record` over the
 *    actions the history returns.
 * 5. Its case in `CASES` in `tests/unit/dues-correction.test.ts`, the shared-run table. That list is
 *    written by hand, so nothing forces a new action into it: this step is the reminder.
 *
 * ## Locks
 *
 * Each action keeps the locks #30 gave it; #324 moved none of them. The fixed order everywhere is
 * the money rows first (a Pembayaran before a Tagihan, a Pembayaran before a cash line), the Periode
 * last, inside `writeCashTransaction`. Each action's own section below says what it locks and why.
 */

// ---------------------------------------------------------------------------------------------
// The typed Audit Log records
// ---------------------------------------------------------------------------------------------

/** The audit log's `action` for a Tagihan a superuser cancelled. */
export const INVOICE_VOIDED_ACTION = 'invoice_voided';

/** The audit log's `action` for an Alokasi a superuser released. */
export const ALLOCATION_RELEASED_ACTION = 'allocation_released';

/** The audit log's `action` for a Saldo Titipan a superuser returned. */
export const CREDIT_REFUNDED_ACTION = 'credit_refunded';

/** The audit log's `action` for a Pengembalian a superuser reversed (Pembatalan Pengembalian). */
export const REFUND_REVERSED_ACTION = 'refund_reversed';

/** The audit log's `action` for a Pembayaran whose verification a superuser undid. */
export const PAYMENT_UNVERIFIED_ACTION = 'payment_unverified';

/** What the `after` of every dues-correction record carries, whichever action wrote it. */
export interface DuesCorrectionAfter {
	/** The Unit the correction was about: the key the corrections history gathers one Unit by. */
	readonly unitId: string;
	/** Why, trimmed. Every dues correction requires one. */
	readonly reason: string;
}

/**
 * The field of `after` the corrections history filters on, typed against `DuesCorrectionAfter` so
 * that renaming the field there breaks the query here instead of emptying the screen.
 */
export const DUES_CORRECTION_UNIT_KEY = 'unitId' satisfies keyof DuesCorrectionAfter;

/** The record a Pembatalan Tagihan leaves. */
export interface InvoiceVoidedRecord {
	readonly action: typeof INVOICE_VOIDED_ACTION;
	/** The cancelled Tagihan. */
	readonly targetId: string;
	/** A standing Tagihan has no cancellation instant. */
	readonly before: { readonly voidedAt: null };
	readonly after: DuesCorrectionAfter & {
		/** The Tagihan's Periode, as `YYYY-MM`. */
		readonly period: string;
		/** The Tagihan's frozen amount. */
		readonly amount: Rupiah;
	};
}

/** The record a Pelepasan Alokasi leaves. */
export interface AllocationReleasedRecord {
	readonly action: typeof ALLOCATION_RELEASED_ACTION;
	/** The released Alokasi, whose row no longer exists. */
	readonly targetId: string;
	/**
	 * The deleted row's whole content: the audit log is the only place a released Alokasi survives,
	 * the design `src/lib/server/db/schema/allocation.ts` records.
	 */
	readonly before: {
		readonly paymentId: string;
		readonly invoiceId: string;
		readonly amount: Rupiah;
		/** When the Alokasi was written, as an ISO 8601 instant. */
		readonly createdAt: string;
	};
	readonly after: DuesCorrectionAfter;
}

/** One Pembayaran's part of a Pengembalian, as the record lists it. */
export interface RefundedPortionRecord {
	readonly paymentId: string;
	/** The cash expense row this part wrote, the one its `refunds` row points at. */
	readonly cashTransactionId: string;
	readonly amount: Rupiah;
}

/** The record a Pengembalian leaves: one per action, however many Pembayaran it drained. */
export interface CreditRefundedRecord {
	readonly action: typeof CREDIT_REFUNDED_ACTION;
	/** The Unit whose Saldo Titipan was returned, the same id as `after.unitId`. */
	readonly targetId: string;
	/** A Pengembalian changes no earlier state, so the row stores no `before`: SQL `null`. */
	readonly before: null;
	readonly after: DuesCorrectionAfter & {
		/** The total returned, the sum of `refunds`. */
		readonly amount: Rupiah;
		/** The day the money was handed back, as `YYYY-MM-DD`. */
		readonly occurredOn: string;
		/** One entry per Pembayaran drained, oldest money first. */
		readonly refunds: readonly RefundedPortionRecord[];
	};
}

/** The record a Pembatalan Pengembalian leaves: one per Pengembalian reversed. */
export interface RefundReversedRecord {
	readonly action: typeof REFUND_REVERSED_ACTION;
	/** The reversed Pengembalian: its `refunds` row, which is never changed or deleted. */
	readonly targetId: string;
	/**
	 * A reversal changes no stored row: it adds a Koreksi beside the Pengembalian's cash line, and
	 * that Koreksi is what makes the Pengembalian count as reversed. So no `before`: SQL `null`, the
	 * same as a Pengembalian's own record.
	 */
	readonly before: null;
	readonly after: DuesCorrectionAfter & {
		/** The Pembayaran whose remainder the Pengembalian had consumed, and now gets back. */
		readonly paymentId: string;
		/** The Pengembalian's cash expense row, the line the Koreksi reverses. */
		readonly cashTransactionId: string;
		/** The Koreksi this reversal wrote, an `income` row in "Iuran warga". */
		readonly correctionId: string;
		/** The Pengembalian's amount, which the Unit's Saldo Titipan gets back. */
		readonly amount: Rupiah;
		/** The day the Pengembalian's money moved, which its Koreksi carries too, as `YYYY-MM-DD`. */
		readonly occurredOn: string;
	};
}

/** One Alokasi a Pembatalan verifikasi released, as the record keeps it: the deleted row's content. */
export interface UnverifyReleasedAllocationRecord {
	readonly allocationId: string;
	readonly invoiceId: string;
	readonly amount: Rupiah;
	/** When the Alokasi was written, by the verification or by an issuance, as an ISO 8601 instant. */
	readonly createdAt: string;
}

/** The record a Pembatalan verifikasi leaves: one per Pembayaran, filed against it. */
export interface PaymentUnverifiedRecord {
	readonly action: typeof PAYMENT_UNVERIFIED_ACTION;
	/** The Pembayaran, whose row now reads `rejected`. */
	readonly targetId: string;
	/** The verification the action undid: the three columns its one `update` cleared or changed. */
	readonly before: {
		readonly status: typeof PAYMENT_STATUS.verified;
		/** The verifying admin's `residents.id`. */
		readonly verifiedBy: string;
		/** When it was verified, as an ISO 8601 instant. */
		readonly verifiedAt: string;
	};
	readonly after: DuesCorrectionAfter & {
		/** Always `rejected`: spec #308 adds no status, and `reason` is now its `rejectionReason`. */
		readonly status: typeof PAYMENT_STATUS.rejected;
		/** The Pembayaran's amount: the money the kas no longer counts. */
		readonly amount: Rupiah;
		/** The day the money was said to change hands, which the income line and its Koreksi carry. */
		readonly receivedOn: string;
		/** The income line the verification wrote, found through its `payment_verified` record. */
		readonly cashTransactionId: string;
		/** The Koreksi this action wrote, an `expense` row in "Iuran warga". */
		readonly correctionId: string;
		/** Every Alokasi released, oldest first; empty when the whole payment was Saldo Titipan. */
		readonly allocations: readonly UnverifyReleasedAllocationRecord[];
	};
}

/** Every record this module writes: one type per action. */
export type DuesCorrectionRecord =
	| InvoiceVoidedRecord
	| AllocationReleasedRecord
	| CreditRefundedRecord
	| RefundReversedRecord
	| PaymentUnverifiedRecord;

/** The audit `action` of one dues correction. */
export type DuesCorrectionAction = DuesCorrectionRecord['action'];

/**
 * What the corrections history shows of one record besides its action, actor, instant and reason.
 * Each action decides it in its `RECORD_KINDS` entry.
 */
export interface DuesCorrectionSummary {
	/**
	 * The money the action was about: the voided Tagihan's, the released Alokasi's, the refund's, the
	 * reversed refund's, the unverified Pembayaran's.
	 */
	readonly amount: Rupiah | null;
	/** The Periode, for an action about one Tagihan; `null` for the others. */
	readonly period: string | null;
}

/** One stored Audit Log row, as much of it as a record is read back from. */
export interface StoredDuesCorrectionRow {
	readonly action: string;
	readonly targetId: string;
	readonly before: unknown;
	readonly after: unknown;
}

/** A check that a stored `jsonb` value is a `T`. */
type Check<T> = (value: unknown) => value is T;

/** One check per field of `T`, keyed by `T`'s own field names, so a rename in `T` is a compile error. */
type FieldChecks<T> = { readonly [K in keyof T]-?: Check<T[K]> };

/** The record type of one action. */
type RecordsByAction = {
	readonly [A in DuesCorrectionAction]: Extract<DuesCorrectionRecord, { readonly action: A }>;
};

/** What this module knows of one action's record beyond its type: how to check it, how to show it. */
interface DuesCorrectionRecordKind<R extends DuesCorrectionRecord> {
	/** Whether a stored row, as its four parts, is this record: every field of the type checked. */
	readonly record: Check<R>;
	/** What the corrections history shows of it besides the reason. */
	readonly summary: (record: R) => DuesCorrectionSummary;
}

/** The table above, one entry per action. */
type RecordKinds = {
	readonly [A in DuesCorrectionAction]: DuesCorrectionRecordKind<RecordsByAction[A]>;
};

const isString: Check<string> = (value): value is string => typeof value === 'string';

const isNull: Check<null> = (value): value is null => value === null;

/** A check for exactly the string `expected`: a record's `action`. */
function isExactly<T extends string>(expected: T): Check<T> {
	return (value): value is T => value === expected;
}

/** A whole-rupiah amount as JSON keeps it: a safe integer, the same rule `rupiah()` holds. */
const isRupiah: Check<Rupiah> = (value): value is Rupiah =>
	typeof value === 'number' && Number.isSafeInteger(value);

/** A check for a JSON object holding every field `fields` names, each passing its own check. */
function objectOf<T extends object>(fields: FieldChecks<T>): Check<T> {
	const entries: readonly (readonly [string, Check<unknown>])[] = Object.entries(fields);
	return (value): value is T => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return false;
		}
		// `Object.hasOwn`, not `in`: the value is data read back from a table, and `in` answers for
		// names its prototype carries.
		return entries.every(
			([field, check]) =>
				Object.hasOwn(value, field) && check((value as Record<string, unknown>)[field])
		);
	};
}

/** A check for a JSON array whose every element passes `element`. */
function arrayOf<T>(element: Check<T>): Check<readonly T[]> {
	return (value): value is readonly T[] =>
		Array.isArray(value) && value.every((item: unknown) => element(item));
}

/**
 * Every action's record: its check and its history summary. Typed over every action, so a record
 * type added to `DuesCorrectionRecord` without an entry here does not compile.
 */
const RECORD_KINDS: RecordKinds = {
	[INVOICE_VOIDED_ACTION]: {
		record: objectOf<InvoiceVoidedRecord>({
			action: isExactly(INVOICE_VOIDED_ACTION),
			targetId: isString,
			before: objectOf<InvoiceVoidedRecord['before']>({ voidedAt: isNull }),
			after: objectOf<InvoiceVoidedRecord['after']>({
				unitId: isString,
				reason: isString,
				period: isString,
				amount: isRupiah
			})
		}),
		summary: (record) => ({ amount: record.after.amount, period: record.after.period })
	},
	[ALLOCATION_RELEASED_ACTION]: {
		record: objectOf<AllocationReleasedRecord>({
			action: isExactly(ALLOCATION_RELEASED_ACTION),
			targetId: isString,
			before: objectOf<AllocationReleasedRecord['before']>({
				paymentId: isString,
				invoiceId: isString,
				amount: isRupiah,
				createdAt: isString
			}),
			after: objectOf<AllocationReleasedRecord['after']>({ unitId: isString, reason: isString })
		}),
		// The released Alokasi's amount is in `before`, the deleted row's content.
		summary: (record) => ({ amount: record.before.amount, period: null })
	},
	[CREDIT_REFUNDED_ACTION]: {
		record: objectOf<CreditRefundedRecord>({
			action: isExactly(CREDIT_REFUNDED_ACTION),
			targetId: isString,
			before: isNull,
			after: objectOf<CreditRefundedRecord['after']>({
				unitId: isString,
				reason: isString,
				amount: isRupiah,
				occurredOn: isString,
				refunds: arrayOf(
					objectOf<RefundedPortionRecord>({
						paymentId: isString,
						cashTransactionId: isString,
						amount: isRupiah
					})
				)
			})
		}),
		summary: (record) => ({ amount: record.after.amount, period: null })
	},
	[REFUND_REVERSED_ACTION]: {
		record: objectOf<RefundReversedRecord>({
			action: isExactly(REFUND_REVERSED_ACTION),
			targetId: isString,
			before: isNull,
			after: objectOf<RefundReversedRecord['after']>({
				unitId: isString,
				reason: isString,
				paymentId: isString,
				cashTransactionId: isString,
				correctionId: isString,
				amount: isRupiah,
				occurredOn: isString
			})
		}),
		summary: (record) => ({ amount: record.after.amount, period: null })
	},
	[PAYMENT_UNVERIFIED_ACTION]: {
		record: objectOf<PaymentUnverifiedRecord>({
			action: isExactly(PAYMENT_UNVERIFIED_ACTION),
			targetId: isString,
			before: objectOf<PaymentUnverifiedRecord['before']>({
				status: isExactly(PAYMENT_STATUS.verified),
				verifiedBy: isString,
				verifiedAt: isString
			}),
			after: objectOf<PaymentUnverifiedRecord['after']>({
				unitId: isString,
				reason: isString,
				status: isExactly(PAYMENT_STATUS.rejected),
				amount: isRupiah,
				receivedOn: isString,
				cashTransactionId: isString,
				correctionId: isString,
				allocations: arrayOf(
					objectOf<UnverifyReleasedAllocationRecord>({
						allocationId: isString,
						invoiceId: isString,
						amount: isRupiah,
						createdAt: isString
					})
				)
			})
		}),
		summary: (record) => ({ amount: record.after.amount, period: null })
	}
};

/** Whether `action` is one this module writes. */
export function isDuesCorrectionAction(action: string): action is DuesCorrectionAction {
	return Object.hasOwn(RECORD_KINDS, action);
}

/** Every action this module writes, read off `RECORD_KINDS`: the actions the history asks for. */
export const DUES_CORRECTION_ACTIONS: readonly DuesCorrectionAction[] =
	Object.keys(RECORD_KINDS).filter(isDuesCorrectionAction);

/**
 * One stored Audit Log row read back as the record its writer wrote, every field checked against
 * that record's type, or `undefined` when the row is not a dues correction or does not match its
 * action's type.
 */
export function readDuesCorrectionRecord(
	row: StoredDuesCorrectionRow
): DuesCorrectionRecord | undefined {
	return isDuesCorrectionAction(row.action) ? readRecordAs(row.action, row) : undefined;
}

/** What the corrections history shows of `record` besides the reason, as its action decides. */
export function duesCorrectionSummary(record: DuesCorrectionRecord): DuesCorrectionSummary {
	return summaryAs(record.action, record);
}

/** `readDuesCorrectionRecord` for one known action, generic so the table entry and the row agree. */
function readRecordAs<A extends DuesCorrectionAction>(
	action: A,
	row: StoredDuesCorrectionRow
): RecordsByAction[A] | undefined {
	const kind: RecordKinds[A] = RECORD_KINDS[action];
	const candidate = {
		action: row.action,
		targetId: row.targetId,
		before: row.before,
		after: row.after
	};
	return kind.record(candidate) ? candidate : undefined;
}

/** `duesCorrectionSummary` for one known action, generic for the reason `readRecordAs` is. */
function summaryAs<A extends DuesCorrectionAction>(
	action: A,
	record: RecordsByAction[A]
): DuesCorrectionSummary {
	return RECORD_KINDS[action].summary(record);
}

// ---------------------------------------------------------------------------------------------
// The shared run
// ---------------------------------------------------------------------------------------------

/** What every dues correction is asked with: who acts, and why. */
interface DuesCorrectionRequest {
	/** The signed-in superuser. Checked against `ACTION.correctDues` before anything else. */
	readonly actorId: string;
	/** Why. Required: refused when empty once trimmed. */
	readonly reason: string;
}

/** What the run hands an action, once the right and the reason are settled. */
interface DuesCorrectionScope {
	/** The one transaction the action, its record and nothing else run in. */
	readonly transaction: Transaction;
	readonly actorId: string;
	/** The reason, trimmed and never empty: what the action stores and what its record keeps. */
	readonly reason: string;
}

/** What an action answers the run with: its result, and the one record the audit log keeps of it. */
interface DuesCorrectionResult<T> {
	readonly outcome: T;
	readonly record: DuesCorrectionRecord;
}

/**
 * The part every dues correction shares, in this order: the reason is trimmed; one transaction
 * opens; `ACTION.correctDues` is checked; a reason that is empty once trimmed is refused with the
 * action's own error; the action runs with the transaction and the trimmed reason; its record is
 * written, attributed to the actor, as the last statement; the transaction commits.
 *
 * A caller that must do something only after the commit (#331's rejection email) does it after
 * this resolves, never inside `act`.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues. Nothing else has run.
 * @throws whatever `reasonMissing` builds, when the trimmed reason is empty.
 */
async function runDuesCorrection<T>(
	db: Database,
	clock: Clock,
	request: DuesCorrectionRequest,
	reasonMissing: () => Error,
	act: (scope: DuesCorrectionScope) => Promise<DuesCorrectionResult<T>>
): Promise<T> {
	const reason = request.reason.trim();

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.correctDues);
		if (reason === '') {
			throw reasonMissing();
		}

		const { outcome, record } = await act({ transaction, actorId: request.actorId, reason });

		await recordAuditEntry(transaction, clock, { actorId: request.actorId, ...record });
		return outcome;
	});
}

/**
 * The `residents.id` behind the acting superuser, for an action that stores a `residents`
 * reference to its actor, or the action's own refusal when there is none.
 *
 * @throws whatever `notRegistered` builds.
 */
async function requireActorResidentId(
	transaction: Transaction,
	actorId: string,
	notRegistered: () => Error
): Promise<string> {
	const [row] = await transaction
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, actorId))
		.limit(1);
	if (!row) {
		throw notRegistered();
	}
	return row.id;
}

// ---------------------------------------------------------------------------------------------
// Pembatalan Tagihan
// ---------------------------------------------------------------------------------------------
//
// Marking one Tagihan `void` with a reason and an actor, never deleting it: user story 20 of
// `docs/spec-iuran-v1.md`.
//
// ## Why a void moves no money, and what that buys
//
// A void writes `voidedAt`, `voidReason` and `voidedBy` in one `update`, all three together, which
// is the only combination `invoices_void_check` accepts, and touches nothing else: no cash row, no
// Periode consulted, no allocation. It may only do that because of the rule it enforces first: **a
// Tagihan that has absorbed money cannot be voided.** `docs/spec-iuran-v1.md:156-161` gives the
// reason (cancelling an allocated Tagihan makes money vanish from the Tagihan's side without a
// trace), and the refusal names every Alokasi that has to be released first, which is the spec's
// "pesan yang menyebut langkah yang harus dilakukan lebih dulu".
//
// ## The lock, and why it is only the invoice's
//
// The Tagihan row is taken `for update` before its allocations are counted, and that one lock is
// sufficient because every writer that can grow this invoice's allocated sum already holds it:
//
// - **Verification** locks the Unit's open Tagihan through `lockOpenInvoicesOfUnit` before it
//   plans. If verification holds the lock first, this void waits, then counts under a fresh
//   snapshot and sees the new Alokasi: refused. If this void commits first, verification's locking
//   read re-evaluates its `voidedAt is null` filter on the committed row and **excludes it**, so a
//   voided Tagihan can never absorb new money.
// - **Issuance's credit application** allocates only onto the Tagihan its own transaction just
//   inserted, which this void cannot even see until that transaction commits; after it commits,
//   the count here reads the allocation.
//
// So "no allocations at the moment of voiding" is checked and made permanent in one critical
// section, and the pair of invariants (a void Tagihan has no Alokasi, an Alokasi's Tagihan is never
// void) holds in both directions. Payment rows are deliberately not locked: a void neither reads
// nor changes any payment's remainder, and taking locks it does not need would only widen the
// surface a deadlock analysis has to cover. The lock order stays one-way regardless: a void takes
// an invoice lock and nothing after it.

/**
 * Every rule a cancellation is refused for, other than permission. The finance screen maps each of
 * these to a sentence through an exhaustive `Record`, so a rule added later is a type error there
 * until somebody writes its message. These are refusals of a request, never of the caller, so a
 * route answers them with `fail(400, …)` rather than a 403.
 */
export const VOID_RULE = {
	/** A cancellation records why ("dengan alasan wajib"), so an empty reason is refused. */
	reasonMissing: 'reasonMissing',
	/** The Tagihan is already void. There is no second cancellation and no un-cancellation here. */
	alreadyVoided: 'alreadyVoided',
	/**
	 * The cancelling superuser has no `residents` row. `invoices.voidedBy` references
	 * `residents.id`, so there is nowhere to attribute the cancellation: the same shape
	 * `actorNotRegistered` has in `./verification.ts`.
	 */
	actorNotRegistered: 'actorNotRegistered'
} as const;

/** One of the rules above. */
export type VoidRule = (typeof VOID_RULE)[keyof typeof VOID_RULE];

/**
 * Thrown when a cancellation is refused by one of the rules in `VOID_RULE`. Named and
 * `instanceof`-checkable for the reason `VerificationRuleError` is. It extends `Error` directly
 * because it predates `RuleViolationError`, and `src/lib/server/route-action.ts` lists it instead.
 */
export class VoidRuleError extends Error {
	override readonly name = 'VoidRuleError';

	/** Which rule refused the request. */
	readonly rule: VoidRule;

	constructor(rule: VoidRule, detail: string) {
		super(`A void request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** One Alokasi standing in the way of a cancellation, as the refusal names it. */
export interface BlockingAllocation {
	readonly allocationId: string;
	/** The Pembayaran whose money the Alokasi holds: where a release will send it back. */
	readonly paymentId: string;
	readonly amount: Rupiah;
}

/**
 * Thrown when the Tagihan still has Alokasi: the named refusal, carrying every allocation that has
 * to be released first so the screen can say exactly which, not merely that some exist. A class of
 * its own rather than a `VOID_RULE` member because it carries data no other rule has; a route
 * answers it with `fail(400, …)` like the rules.
 */
export class VoidRefusedAllocatedError extends Error {
	override readonly name = 'VoidRefusedAllocatedError';

	/** The Tagihan that refused. */
	readonly invoiceId: string;
	/** Every Alokasi that must be released before this Tagihan can be cancelled. */
	readonly allocations: readonly BlockingAllocation[];

	constructor(invoiceId: string, blocking: readonly BlockingAllocation[]) {
		super(
			`Invoice "${invoiceId}" has ${blocking.length} allocation(s) and cannot be voided until each is released: ${blocking
				.map((allocation) => allocation.allocationId)
				.join(', ')}.`
		);
		this.invoiceId = invoiceId;
		this.allocations = blocking;
	}
}

/**
 * Thrown when `invoiceId` names no Tagihan at all, an id no screen ever rendered. The same named
 * 404 shape `PaymentNotFoundError` takes, and for the same reason: the caller has already proven
 * `ACTION.correctDues`, so the honest answer to a stale id is "that row is gone".
 */
export class InvoiceNotFoundError extends Error {
	override readonly name = 'InvoiceNotFoundError';

	/** The id that named no invoice. */
	readonly invoiceId: string;

	constructor(invoiceId: string) {
		super(`No invoice exists with id "${invoiceId}".`);
		this.invoiceId = invoiceId;
	}
}

/** Who is cancelling, which Tagihan, and the reason the audit log will keep. */
export interface VoidInvoiceRequest extends DuesCorrectionRequest {
	readonly invoiceId: string;
}

/**
 * Cancels one Tagihan: `voidedAt`, `voidReason` and `voidedBy` filled together in one `update`,
 * the row never deleted, one `InvoiceVoidedRecord`, or the named refusal that says why not.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {InvoiceNotFoundError} when `invoiceId` names no Tagihan.
 * @throws {VoidRuleError} `reasonMissing`, `alreadyVoided`, or `actorNotRegistered`.
 * @throws {VoidRefusedAllocatedError} when the Tagihan still has Alokasi, naming each one.
 */
export async function voidInvoice(
	db: Database,
	clock: Clock,
	request: VoidInvoiceRequest
): Promise<Invoice> {
	return runDuesCorrection(
		db,
		clock,
		request,
		() =>
			new VoidRuleError(
				VOID_RULE.reasonMissing,
				'Cancelling an invoice records why it should never have stood, so an empty reason is refused.'
			),
		async ({ transaction, actorId, reason }) => {
			const actorResidentId = await requireActorResidentId(
				transaction,
				actorId,
				() =>
					new VoidRuleError(
						VOID_RULE.actorNotRegistered,
						`User "${actorId}" has no residents row, and invoices.voidedBy references residents.id.`
					)
			);

			const invoice = await lockStandingInvoice(transaction, request.invoiceId);

			// A fresh statement under the invoice lock: every writer that could add a row here either
			// holds this same lock or is invisible until it commits. See "Pembatalan Tagihan" above.
			const blocking = await transaction
				.select({
					allocationId: allocations.id,
					paymentId: allocations.paymentId,
					amount: allocations.amount
				})
				.from(allocations)
				.where(eq(allocations.invoiceId, invoice.id));
			if (blocking.length > 0) {
				throw new VoidRefusedAllocatedError(invoice.id, blocking);
			}

			const [voided] = await transaction
				.update(invoices)
				// One statement: `invoices_void_check` refuses the three columns written apart.
				.set({ voidedAt: clock.now(), voidReason: reason, voidedBy: actorResidentId })
				.where(eq(invoices.id, invoice.id))
				.returning();

			return {
				outcome: voided,
				record: {
					action: INVOICE_VOIDED_ACTION,
					targetId: invoice.id,
					before: { voidedAt: null },
					after: {
						unitId: invoice.unitId,
						period: invoice.period,
						amount: invoice.amount,
						reason
					}
				} satisfies InvoiceVoidedRecord
			};
		}
	);
}

/**
 * The Tagihan named by `invoiceId`, locked `for update` and still standing.
 *
 * @throws {InvoiceNotFoundError} when the id names no row.
 * @throws {VoidRuleError} `alreadyVoided` when the row is already cancelled.
 */
async function lockStandingInvoice(transaction: Transaction, invoiceId: string): Promise<Invoice> {
	const [row] = await transaction
		.select()
		.from(invoices)
		.where(eq(invoices.id, invoiceId))
		.limit(1)
		.for('update');
	if (!row) {
		throw new InvoiceNotFoundError(invoiceId);
	}
	if (row.voidedAt !== null) {
		throw new VoidRuleError(
			VOID_RULE.alreadyVoided,
			`Invoice "${row.id}" was already voided, and a cancellation happens once.`
		);
	}
	return row;
}

// ---------------------------------------------------------------------------------------------
// Pelepasan Alokasi
// ---------------------------------------------------------------------------------------------
//
// Deleting one `allocations` row so its money becomes the Unit's Saldo Titipan again: user story 22
// of `docs/spec-iuran-v1.md`.
//
// ## The deletion is the whole restoration
//
// Saldo Titipan is *defined* as verified payments less their allocations less their refunds
// (`./credit-balance.ts`), and a Tagihan's status is *defined* as its amount against its allocated
// sum (`invoiceStandings` in `./invoice-standing.ts`). Deleting the row therefore restores the
// balance and reopens the Tagihan in the same instant, with no second write that could be skipped
// and no compensating column that could be wrong: the argument
// `src/lib/server/db/schema/allocation.ts` records for why this is the one table in the iuran
// schema whose rows are deleted on purpose. **No cash row is touched**: the money entered the buku
// kas when its Pembayaran was verified and it has not left the complex, only its peruntukan
// changed. The record is where the fact of the release lives, which is what
// `docs/spec-iuran-v1.md:171-172` asks ("pelepasan alokasi" is on its list), and why it carries
// everything the deleted Alokasi said.
//
// ## The locks, in the fixed order: payment first, invoice second
//
// - **The payment row, `for update`, first.** Every spender of this payment's remainder
//   (verification, issuance's credit application, the Pengembalian) holds this lock while it reads
//   sums and writes rows. Holding it here means a release and a spend serialise: whichever runs
//   second sees the other's committed rows, so a remainder is never computed from a half-changed
//   set.
// - **The Tagihan row, `for update`, second**: the same direction verification takes them
//   (payment, then the Unit's invoices), so no pair of writers can wait on each other in a cycle.
//   The invoice lock is what serialises a release against a void: `voidInvoice` counts
//   allocations under this same lock, so a void and a release of the same Tagihan cannot
//   interleave into a voided Tagihan that still has a row here.
//
// The Alokasi itself is re-read by id in a fresh statement only after both locks are held: two
// releases of the same row serialise on the payment lock, and the loser finds the row already gone
// and answers `AllocationNotFoundError` instead of deleting nothing silently.

/**
 * Every rule a release is refused for, other than permission: one member today, shaped like
 * `VOID_RULE` so the finance screen maps it through the same exhaustive `Record`.
 */
export const RELEASE_RULE = {
	/** A release records why ("beserta alasannya"), so an empty reason is refused. */
	reasonMissing: 'reasonMissing'
} as const;

/** One of the rules above. */
export type ReleaseRule = (typeof RELEASE_RULE)[keyof typeof RELEASE_RULE];

/** Thrown when a release is refused by one of the rules in `RELEASE_RULE`. */
export class ReleaseRuleError extends Error {
	override readonly name = 'ReleaseRuleError';

	/** Which rule refused the request. */
	readonly rule: ReleaseRule;

	constructor(rule: ReleaseRule, detail: string) {
		super(`A release request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/**
 * Thrown when `allocationId` names no Alokasi: an id no screen ever rendered, or a row a
 * concurrent release already deleted. Both mean the same thing to the caller: there is nothing
 * left to release.
 */
export class AllocationNotFoundError extends Error {
	override readonly name = 'AllocationNotFoundError';

	/** The id that named no allocation. */
	readonly allocationId: string;

	constructor(allocationId: string) {
		super(`No allocation exists with id "${allocationId}".`);
		this.allocationId = allocationId;
	}
}

/** Who is releasing, which Alokasi, and the reason the audit log will keep. */
export interface ReleaseAllocationRequest extends DuesCorrectionRequest {
	readonly allocationId: string;
}

/**
 * Releases one Alokasi: the row is deleted under the payment's and the Tagihan's row locks, the
 * money is Saldo Titipan again by definition, no cash row moves, and one
 * `AllocationReleasedRecord` keeps everything the deleted row said.
 *
 * @returns the Alokasi as it stood at the moment it was released.
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {AllocationNotFoundError} when `allocationId` names no Alokasi.
 * @throws {ReleaseRuleError} `reasonMissing`.
 */
export async function releaseAllocation(
	db: Database,
	clock: Clock,
	request: ReleaseAllocationRequest
): Promise<Allocation> {
	return runDuesCorrection(
		db,
		clock,
		request,
		() =>
			new ReleaseRuleError(
				RELEASE_RULE.reasonMissing,
				'Releasing an allocation records why in the audit log, so an empty reason is refused.'
			),
		async ({ transaction, reason }) => {
			// A plain read first, only to learn which payment and invoice rows to lock; nothing is
			// decided on it. The row is read again under the locks before anything happens.
			const [found] = await transaction
				.select()
				.from(allocations)
				.where(eq(allocations.id, request.allocationId))
				.limit(1);
			if (!found) {
				throw new AllocationNotFoundError(request.allocationId);
			}

			const unitId = await lockSpentPayment(transaction, found.paymentId);
			await lockAllocatedInvoice(transaction, found.invoiceId);

			// Under both locks, in a fresh statement: a concurrent release that won the payment lock
			// has already committed its deletion, and this read sees it.
			const [held] = await transaction
				.select()
				.from(allocations)
				.where(eq(allocations.id, request.allocationId))
				.limit(1);
			if (!held) {
				throw new AllocationNotFoundError(request.allocationId);
			}

			await transaction.delete(allocations).where(eq(allocations.id, held.id));

			return {
				outcome: held,
				record: {
					action: ALLOCATION_RELEASED_ACTION,
					targetId: held.id,
					before: {
						paymentId: held.paymentId,
						invoiceId: held.invoiceId,
						amount: held.amount,
						createdAt: held.createdAt.toISOString()
					},
					after: { unitId, reason }
				} satisfies AllocationReleasedRecord
			};
		}
	);
}

/**
 * Takes `for update` on the Pembayaran whose money an Alokasi or a Pengembalian holds (the same lock
 * every spender of that payment's remainder takes) and answers the Unit it belongs to, which the
 * record needs. Used by the release and by the Pembatalan Pengembalian.
 */
async function lockSpentPayment(transaction: Transaction, paymentId: string): Promise<string> {
	const [row] = await transaction
		.select({ unitId: payments.unitId })
		.from(payments)
		.where(eq(payments.id, paymentId))
		.limit(1)
		.for('update');
	// Unreachable while the allocation or refund exists: neither
	// `allocations_payment_id_payments_id_fk` nor the `refunds` foreign key to `payments` carries a
	// cascade, so a payment one of them points at cannot be deleted. Stated rather than asserted away.
	if (!row) {
		throw new Error(
			`Payment "${paymentId}" is gone although an allocation or a refund still points at it.`
		);
	}
	return row.unitId;
}

/** Takes `for update` on the Tagihan the Alokasi answers: the lock `voidInvoice` counts under. */
async function lockAllocatedInvoice(transaction: Transaction, invoiceId: string): Promise<void> {
	const [row] = await transaction
		.select({ id: invoices.id })
		.from(invoices)
		.where(eq(invoices.id, invoiceId))
		.limit(1)
		.for('update');
	// Unreachable for the same reason as the payment above: the foreign key has no cascade.
	if (!row) {
		throw new Error(`Invoice "${invoiceId}" is gone although an allocation still points at it.`);
	}
}

// ---------------------------------------------------------------------------------------------
// Pengembalian
// ---------------------------------------------------------------------------------------------
//
// Returning part or all of a Unit's Saldo Titipan to its Warga as money out of the kas: user story
// 23 of `docs/spec-iuran-v1.md` ("superuser mencatat pengembalian sebagai uang keluar yang
// mengonsumsi saldo itu").
//
// ## The invariant a Pengembalian answers for
//
// Refunded money must be money nothing can spend again, for as long as the refund is in force (a
// Pembatalan Pengembalian, below, gives it back). Saldo Titipan has one other spender,
// `applyCreditToInvoice` in `./allocation.ts`, run by every month's issuance, which drains
// **per-payment remainders** handed to it by `lockUnallocatedVerifiedPayments`. So a refund is
// stored per payment: one `refunds` row and one cash expense row for each Pembayaran whose
// remainder it consumed, drained oldest money first by the very function issuance drains with,
// `planCreditSpend` in `./allocation.ts`. `./credit-balance.ts` subtracts the `refunds` in force
// beside `allocations` in both of its reads, which yields the two halves of the invariant in one
// stroke:
//
// - **A Pembayaran is never spent past its amount** (allocations plus refunds in force never exceed
//   it), because both spenders draw from the same remainder arithmetic under the same lock.
// - **`verified = allocations + saldo titipan + refunds in force` holds for every Unit** (the equation
//   `tests/unit/unit-money-invariant.test.ts` runs), because the refund is a term of the very
//   subtraction that defines the balance, not a second ledger that could drift from it.
//
// ## The locks, and why a concurrent issuance cannot double-spend
//
// `lockUnallocatedVerifiedPayments` takes `for update` on every verified Pembayaran of the Unit
// before a single remainder is read: the identical critical section issuance's credit application
// enters. Two spenders of one Unit's balance therefore serialise on those rows: whichever wins, the
// loser's locking read completes only after the winner commits, its remainder sums are read in
// fresh statements that see the winner's rows (allocations or refunds), and the money it offers to
// spend is only what is genuinely left. A refund racing an issuance can end refused
// (`amountAboveBalance`), never doubled. `tests/unit/credit-refund.test.ts` holds the interleaving
// with a second connection holding an uncommitted claim.
//
// The lock order is the fixed one, the payment rows first and the Periode second: every cash row is
// written through `recordDuesRefund`, whose Periode guard takes the Periode share lock only after
// the payment locks are already held. No writer anywhere takes these two in the other order.
//
// ## One action, one record, N cash rows
//
// A refund that drains several Pembayaran writes one cash expense row per payment, the mirror of
// verification, which writes one income row per payment verified, so the buku kas stays
// reconcilable payment by payment in both directions. The action itself is still one decision, so
// it leaves exactly one `CreditRefundedRecord`, filed against the Unit, with every portion in it.

/** The shape `occurredOn` has to arrive in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How many characters that shape has, which is also where an ISO instant's day part ends. */
const DAY_LENGTH = 10;

/** Milliseconds in a day, for working out the latest day money can already have been returned. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every rule a refund is refused for, other than permission and other than the locked Periode,
 * which keeps its own named error (`PeriodLockedError`) for the reason `CASH_RULE` records.
 * Refusals of a request, never of the caller: `fail(400, …)` at the route.
 */
export const REFUND_RULE = {
	/** The amount is zero or negative. A refund is a movement of money. */
	amountNotPositive: 'amountNotPositive',
	/** The date is not a real calendar day written as `YYYY-MM-DD`. */
	notACalendarDay: 'notACalendarDay',
	/** The money is claimed to have been handed back on a day that has not arrived. */
	dayInTheFuture: 'dayInTheFuture',
	/** A refund records why ("beserta alasannya"), so an empty reason is refused. */
	reasonMissing: 'reasonMissing',
	/** More money was asked back than the Unit's Saldo Titipan holds. */
	amountAboveBalance: 'amountAboveBalance'
} as const;

/** One of the rules above. */
export type RefundRule = (typeof REFUND_RULE)[keyof typeof REFUND_RULE];

/**
 * Thrown when a refund is refused by one of the rules in `REFUND_RULE`. Named and
 * `instanceof`-checkable for the reason `VerificationRuleError` is.
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
	/** The total returned: the sum of the portions, which is the requested amount exactly. */
	readonly amount: Rupiah;
	/** One entry per Pembayaran drained, oldest money first. */
	readonly portions: readonly RefundedPortion[];
}

/** Who is refunding, which Unit, how much, when the money moved, and why. */
export interface RefundCreditRequest extends DuesCorrectionRequest {
	/** The house whose Saldo Titipan is being returned. */
	readonly unitId: string;
	/** How much to return, in whole rupiah. Strictly positive, at most the balance. */
	readonly amount: Rupiah;
	/** The day the money was handed back, as `YYYY-MM-DD`. Not the day this row is typed. */
	readonly occurredOn: string;
}

/**
 * Returns `amount` of one Unit's Saldo Titipan: the Unit's verified Pembayaran are locked, their
 * remainders drained oldest first, and each drained payment gets one cash expense row in the
 * system category "Iuran warga" and one `refunds` row pointing at it: one transaction, all or
 * nothing, closed by a single `CreditRefundedRecord`.
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
	return runDuesCorrection(
		db,
		clock,
		request,
		() =>
			new RefundRuleError(
				REFUND_RULE.reasonMissing,
				'Returning money records why in the audit log, so an empty reason is refused.'
			),
		async ({ transaction, actorId, reason }) => {
			assertPositiveAmount(request.amount);
			assertRefundDay(request.occurredOn, clock);
			const unit = await requireUnit(transaction, request.unitId);

			// The critical section. `for update` on every verified payment of this Unit (the same
			// locks every other spender of this balance takes), and the remainder sums are read in
			// fresh statements inside them, so they include everything any earlier winner committed.
			const remainders = await lockUnallocatedVerifiedPayments(transaction, request.unitId);
			const balance = remainders.reduce((total, payment) => total + payment.remainder, 0);
			if (request.amount > balance) {
				throw new RefundRuleError(
					REFUND_RULE.amountAboveBalance,
					`The unit's saldo titipan is ${balance}, so ${request.amount} cannot be returned.`
				);
			}

			const portions: RefundedPortion[] = [];
			for (const spend of planCreditSpend(remainders, request.amount)) {
				const cashTransaction = await recordDuesRefund(transaction, clock, {
					occurredOn: request.occurredOn,
					amount: spend.amount,
					// Data in the buku kas, read back by residents in a Laporan Bulanan, so Indonesian,
					// naming the house and the payment: the mirror of `cashDescriptionFor` in
					// `./verification.ts`.
					description: `Pengembalian saldo titipan Blok ${unit.block} No ${unit.number} (pembayaran ${spend.paymentId})`,
					recordedBy: actorId
				});
				const [refund] = await transaction
					.insert(refunds)
					.values({
						id: randomUUID(),
						paymentId: spend.paymentId,
						cashTransactionId: cashTransaction.id,
						amount: spend.amount,
						reason,
						refundedBy: actorId,
						createdAt: clock.now()
					})
					.returning();

				portions.push({ refund, cashTransaction });
			}

			return {
				outcome: { unitId: request.unitId, amount: request.amount, portions },
				record: {
					action: CREDIT_REFUNDED_ACTION,
					targetId: request.unitId,
					before: null,
					after: {
						unitId: request.unitId,
						amount: request.amount,
						occurredOn: request.occurredOn,
						reason,
						refunds: portions.map((portion): RefundedPortionRecord => ({
							paymentId: portion.refund.paymentId,
							cashTransactionId: portion.refund.cashTransactionId,
							amount: portion.refund.amount
						}))
					}
				} satisfies CreditRefundedRecord
			};
		}
	);
}

/** The house named by `unitId`, for the cash rows' keterangan, or the named 404. */
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
 * Refuses an `occurredOn` that is not a real calendar day, or one that has not arrived: the same
 * checks, with the same one-day slack past the WIB day (`currentDay`), as `assertReceiptDay` in
 * `./verification.ts`, thrown as this action's own rule class. Money out draws the same line as
 * money in: a cash book line dated on a day that has not happened is a lie whichever direction the
 * money moved.
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

// ---------------------------------------------------------------------------------------------
// Pembatalan Pengembalian
// ---------------------------------------------------------------------------------------------
//
// Reversing one Pengembalian that was recorded by mistake: spec #308 decision 6, `reverse` on
// `Refund` in `CONTEXT.md` ("Pengeluaran kasnya dibalik dengan Koreksi dan Saldo Titipan Unit kembali
// seperti sebelum Pengembalian itu").
//
// ## One Pengembalian, one Koreksi, no column
//
// One Pengembalian is one `refunds` row and the one cash expense row it points at
// (`refunds_cash_transaction_id_unique`). A refund action that drained two Pembayaran stored two
// Pengembalian, and each is reversed on its own. The reversal writes exactly one row: a Koreksi of
// that cash expense, through the writer's `refundReverseCorrection` kind, which reads its amount,
// category and day off the expense line, gives it the opposite direction (`income`), and asks the
// Periode of that day. Nothing else changes: the `refunds` row is never updated or deleted (its
// schema says so), and no column records the reversal.
//
// **"Already reversed" is derived, from the Koreksi on the refund's cash line**, and one rule says
// so everywhere: `refundInForce` in `./credit-balance.ts`, which both balance reads and the finance
// screen's list use. A Pengembalian in force is one whose cash line has no Koreksi. Since the
// moment a Koreksi exists the refund stops counting, the Saldo Titipan rises by the refund's amount
// in the very commit that writes the Koreksi, with no second write that could be skipped.
//
// A reversal is permanent. No writer can take the Koreksi back: the ordinary Koreksi refuses every
// line in "Iuran warga" (`duesLine`), and both dues kinds refuse a line that is itself a Koreksi
// (`notThisKind`), both in `assertCorrectableBy` in `../cash/writer.ts`. So once a Pengembalian is
// reversed it stays reversed, and a Pembayaran's remainder only ever *rises* through this action.
//
// ## The locks, in the fixed order: the Pembayaran, then the cash line, then the Periode
//
// - **The Pembayaran the refund drained, `for update`, first.** The same lock every spender of that
//   payment's remainder takes (verification on its own row, issuance's credit application and the
//   Pengembalian through `lockUnallocatedVerifiedPayments`), and the one #331's Pembatalan
//   verifikasi takes before it asks whether a Pengembalian of the payment is in force. Holding it
//   means a reversal and anything that reads or spends this payment's remainder serialise: whichever
//   runs second reads the other's committed rows in fresh statements.
// - **"Already reversed" is read under that lock**, in a fresh statement, and refused by name
//   (`REVERSE_REFUND_RULE.alreadyReversed`). Two reversals of one refund serialise on the payment
//   row, and the second sees the first's committed Koreksi. The only other writer that could put a
//   Koreksi on this line is refused by the writer before it writes, as above.
// - **The cash line, `for update`, second**, inside the writer (`lockTransaction`), which re-checks
//   that the line has no Koreksi and refuses with `CashTransactionAlreadyCorrectedError` if it has:
//   the backstop that holds even for a caller that took no payment lock.
// - **The Periode, `for share`, last**, inside the writer (`requireOpenPeriodFor`), against the
//   refund's own day: a reversal of a month whose Laporan Bulanan is published waits for the month
//   to be reopened (`PeriodLockedError`) and is never re-dated into an open one.
//
// No writer takes a cash line and then a Pembayaran: the ordinary Koreksi locks a line and nothing
// after it, and verification and the Pengembalian lock their Pembayaran before they insert their
// cash rows. So the order cannot form a cycle.
//
// ## Why the balance cannot go wrong under any order of operations
//
// A reversal only ever adds to a Pembayaran's remainder. A spender that read the remainder before the
// reversal committed spends at most what was there without it, which is less than is there now: a
// lost opportunity, never an overdraft. A spender that reads after it sees the larger remainder,
// which is exactly the money the refund had taken and the reversal gave back. And the reversal
// itself spends nothing, so it needs no balance check of its own. The payment lock adds to this that
// a reversal and a spender of the same Pembayaran never overlap at all, so every reader of the
// remainder sees either both of the reversal's effects (the Koreksi and the higher remainder) or
// neither.

/**
 * Every rule a Pembatalan Pengembalian is refused for, other than permission and the locked Periode,
 * which keeps its own named error (`PeriodLockedError`). Refusals of a request, never of the caller:
 * `fail(400, …)` at the route, each mapped to its sentence through an exhaustive `Record`.
 */
export const REVERSE_REFUND_RULE = {
	/** A reversal records why, so an empty reason is refused. */
	reasonMissing: 'reasonMissing',
	/** The Pengembalian's cash line already has a Koreksi: it is reversed once. */
	alreadyReversed: 'alreadyReversed'
} as const;

/** One of the rules above. */
export type ReverseRefundRule = (typeof REVERSE_REFUND_RULE)[keyof typeof REVERSE_REFUND_RULE];

/** Thrown when a Pembatalan Pengembalian is refused by one of the rules in `REVERSE_REFUND_RULE`. */
export class ReverseRefundRuleError extends RuleViolationError {
	override readonly name = 'ReverseRefundRuleError';

	/** Which rule refused the request. */
	readonly rule: ReverseRefundRule;

	constructor(rule: ReverseRefundRule, detail: string) {
		super(`A refund reversal was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** Thrown when `refundId` names no Pengembalian: an id no screen ever rendered. */
export class RefundNotFoundError extends NotFoundError {
	override readonly name = 'RefundNotFoundError';

	/** The id that named no refund. */
	readonly refundId: string;

	constructor(refundId: string) {
		super(`No refund exists with id "${refundId}".`);
		this.refundId = refundId;
	}
}

/** Who is reversing, which Pengembalian, and the reason the Koreksi and the audit log will keep. */
export interface ReverseRefundRequest extends DuesCorrectionRequest {
	/** The `refunds` row being reversed. */
	readonly refundId: string;
}

/** What one reversal came to, committed together. */
export interface ReversedRefund {
	/** The Unit whose Saldo Titipan got the money back. */
	readonly unitId: string;
	/** The reversed Pengembalian, unchanged. */
	readonly refund: Refund;
	/** The Koreksi of its cash line: `income`, same amount, same day, in "Iuran warga". */
	readonly correction: CashTransaction;
}

/**
 * Reverses one Pengembalian: its Pembayaran locked, "already reversed" refused under that lock, one
 * Koreksi of its cash expense written through the writer's `refundReverseCorrection` kind on the
 * expense's own day, and one `RefundReversedRecord`. The Unit's Saldo Titipan rises by the refund's
 * amount in the same commit, because a refund whose cash line has a Koreksi is no longer in force.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {RefundNotFoundError} when `refundId` names no Pengembalian.
 * @throws {ReverseRefundRuleError} `reasonMissing` or `alreadyReversed`.
 * @throws {PeriodLockedError} when the Pengembalian's day falls inside a Periode that is locked.
 *   Nothing is written; the month is reopened first.
 */
export async function reverseRefund(
	db: Database,
	clock: Clock,
	request: ReverseRefundRequest
): Promise<ReversedRefund> {
	return runDuesCorrection(
		db,
		clock,
		request,
		() =>
			new ReverseRefundRuleError(
				REVERSE_REFUND_RULE.reasonMissing,
				'Reversing a refund records why on its Koreksi and in the audit log, so an empty reason is refused.'
			),
		async ({ transaction, actorId, reason }) => {
			// A plain read: a `refunds` row is never updated or deleted, so what it says cannot move.
			// It names the Pembayaran to lock and the cash line to reverse.
			const [refund] = await transaction
				.select()
				.from(refunds)
				.where(eq(refunds.id, request.refundId))
				.limit(1);
			if (!refund) {
				throw new RefundNotFoundError(request.refundId);
			}

			const unitId = await lockSpentPayment(transaction, refund.paymentId);

			// Under the payment lock, in a fresh statement: a reversal that won the lock has committed
			// its Koreksi, and this read sees it.
			const [existing] = await transaction
				.select({ id: cashTransactions.id })
				.from(cashTransactions)
				.where(eq(cashTransactions.correctionOf, refund.cashTransactionId))
				.limit(1);
			if (existing) {
				throw new ReverseRefundRuleError(
					REVERSE_REFUND_RULE.alreadyReversed,
					`Refund "${refund.id}" was already reversed by Koreksi "${existing.id}", and a refund is reversed once.`
				);
			}

			const correction = await writeCashTransaction(transaction, clock, {
				kind: CASH_WRITE_KIND.refundReverseCorrection,
				recordedBy: actorId,
				transactionId: refund.cashTransactionId,
				reason
			});

			return {
				outcome: { unitId, refund, correction },
				record: {
					action: REFUND_REVERSED_ACTION,
					targetId: refund.id,
					before: null,
					after: {
						unitId,
						reason,
						paymentId: refund.paymentId,
						cashTransactionId: refund.cashTransactionId,
						correctionId: correction.id,
						amount: refund.amount,
						occurredOn: correction.occurredOn
					}
				} satisfies RefundReversedRecord
			};
		}
	);
}

// ---------------------------------------------------------------------------------------------
// Pembatalan verifikasi
// ---------------------------------------------------------------------------------------------
//
// Undoing the verification of one Pembayaran whose money never arrived or whose proof was not
// genuine: spec #308 decision 5, `unverify` in `CONTEXT.md` ("Seluruh Alokasinya dilepas dan
// pemasukan kasnya dibalik dengan Koreksi. Tidak bisa dilakukan selama sebagian Pembayaran itu sudah
// keluar lewat Pengembalian").
//
// ## What one Pembatalan verifikasi changes, in one transaction
//
// - **Every Alokasi of the Pembayaran is deleted**, the ones its verification wrote and the ones an
//   issuance's credit application wrote out of its remainder alike. A Tagihan's status is computed
//   from its Alokasi (`invoiceStandings` in `./invoice-standing.ts`), so each Tagihan it paid reads
//   unpaid again in the same commit, with no second write.
// - **Its income line is reversed by one Koreksi**, through the writer's `unverifyCorrection` kind,
//   which reads amount, category and day off the line, gives the Koreksi the opposite direction
//   (`expense`) and asks the Periode of that day. A locked month refuses the whole action
//   (`PeriodLockedError`, naming the month): the Koreksi is never re-dated into an open one.
// - **The line is found through the verification's Audit Log record**, the only link there is:
//   `cash_transactions` deliberately has no column pointing at a Pembayaran. The `payment_verified`
//   row's `after.cashTransactionId` (`PaymentVerifiedAfter` in `./verification.ts`, checked here
//   against that type) names it. A Pembayaran with no such record, or a record that names no line,
//   is refused (`UNVERIFY_RULE.verificationRecordMissing`): guessing the line from its keterangan or
//   its amount could reverse another payment's money.
// - **The Pembayaran turns `rejected`** in one `update` that clears `verifiedBy` and `verifiedAt` and
//   writes the reason as its `rejectionReason`: the one combination `payments_verification_check`
//   and `payments_rejection_reason_check` accept together. Spec #308 adds no status (decision Q18),
//   and a rejected Pembayaran is never verified again (`lockPendingPayment` in `./verification.ts`).
// - **One `PaymentUnverifiedRecord`**, with the verification it undid in `before`, and the rejected
//   state, the cash line, its Koreksi and every Alokasi released in `after`.
//
// After the commit, and only then, the Pembayaran's recorder gets the `payment-rejected` email, the
// same one an admin's rejection sends, through `announceAfterCommit`: a failure to queue it is logged
// and never fails, or seems to fail, the committed correction (#309).
//
// ## Why the Saldo Titipan cannot go negative: the Pengembalian rule
//
// The Pembayaran's money is spent in two ways: its Alokasi, which this action releases, and the
// Pengembalian in force that drew on its remainder, which it cannot undo. Taking the Pembayaran out of
// the verified money while a Pengembalian of it is in force would leave money paid out of the kas that
// no verified money stands behind. So the action is refused while one exists
// (`UnverifyRefusedRefundedError`, naming each), and the superuser reverses those Pengembalian first
// (`reverseRefund`). `reverseRefund` does not ask whether the Pembayaran is still verified, so this
// refusal is the one guard; it is read with `refundInForce` from `./credit-balance.ts`, the same rule
// both balance reads use, so "in force" here and in the balance cannot disagree.
//
// ## The locks, in the fixed order: the Pembayaran, its Tagihan, the cash line, the Periode
//
// - **The Pembayaran, `for update`, first, before its status is read.** Every writer that spends or
//   gives back this payment's remainder holds the same lock while it reads and writes: issuance's
//   credit application and the Pengembalian through `lockUnallocatedVerifiedPayments`, the release
//   and the Pembatalan Pengembalian through `lockSpentPayment`. So under this lock the Pembayaran's
//   Alokasi and its Pengembalian cannot change, and everything below is read in fresh statements
//   that see whatever an earlier holder committed. Two Pembatalan verifikasi of one Pembayaran
//   serialise here, and the second reads `rejected` and is refused (`notVerified`). A spender that
//   waited behind this action re-evaluates its own `status = 'verified'` filter on the committed row
//   once the lock is released, and no longer sees the Pembayaran at all.
// - **The Pengembalian in force, read under that lock**, then refused by name if any exist. A
//   Pengembalian that won the lock first has committed its `refunds` row, and this read sees it.
// - **Its Tagihan, `for update`, second**, in the order `lockOpenInvoicesOfUnit` takes them (Periode,
//   then id), the direction the release and verification take: a Pembayaran before a Tagihan. These
//   are the locks `voidInvoice` counts Alokasi under, and the ones a verification of another
//   Pembayaran of the Unit plans under, so neither reads an Alokasi sum this action is changing.
// - **The cash line, `for update`, third**, inside the writer (`lockTransaction`), which also refuses
//   a line that already has a Koreksi (`CashTransactionAlreadyCorrectedError`) or is not a dues income
//   line (`CashCorrectionTargetError`, a defect from here).
// - **The Periode, `for share`, last**, inside the writer (`requireOpenPeriodFor`).
//
// No writer takes these in the other order: issuance locks only the Tagihan its own transaction
// inserted, invisible here, before the payments; the ordinary Koreksi locks a line and nothing
// after it; verification and the Pengembalian lock their Pembayaran before they write cash rows.

/**
 * Every rule a Pembatalan verifikasi is refused for, other than permission, the locked Periode
 * (`PeriodLockedError`) and the Pengembalian in force (`UnverifyRefusedRefundedError`, which carries
 * data). Refusals of a request, never of the caller: `fail(400, …)` at the route, each mapped to its
 * sentence through an exhaustive `Record`.
 */
export const UNVERIFY_RULE = {
	/** A Pembatalan verifikasi records why, and the Warga reads it, so an empty reason is refused. */
	reasonMissing: 'reasonMissing',
	/**
	 * The Pembayaran is not verified: still pending (an admin decides it on the queue), or already
	 * rejected, which includes one whose verification was already undone.
	 */
	notVerified: 'notVerified',
	/**
	 * No `payment_verified` Audit Log record names the income line of this Pembayaran, or the line it
	 * names does not exist, so there is no line to reverse that is known to be this payment's.
	 */
	verificationRecordMissing: 'verificationRecordMissing'
} as const;

/** One of the rules above. */
export type UnverifyRule = (typeof UNVERIFY_RULE)[keyof typeof UNVERIFY_RULE];

/** Thrown when a Pembatalan verifikasi is refused by one of the rules in `UNVERIFY_RULE`. */
export class UnverifyRuleError extends RuleViolationError {
	override readonly name = 'UnverifyRuleError';

	/** Which rule refused the request. */
	readonly rule: UnverifyRule;

	constructor(rule: UnverifyRule, detail: string) {
		super(`A verification undo was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** One Pengembalian in force standing in the way of a Pembatalan verifikasi, as the refusal names it. */
export interface BlockingRefund {
	readonly refundId: string;
	readonly amount: Rupiah;
	/** The day the money was handed back, off its cash expense row, as `YYYY-MM-DD`. */
	readonly occurredOn: string;
}

/**
 * Thrown when part of the Pembayaran has left the kas through a Pengembalian still in force: the
 * named refusal, carrying every such Pengembalian so the screen can say which to reverse first. A
 * class of its own rather than an `UNVERIFY_RULE` member because it carries data no other rule has,
 * the shape `VoidRefusedAllocatedError` has.
 */
export class UnverifyRefusedRefundedError extends RuleViolationError {
	override readonly name = 'UnverifyRefusedRefundedError';

	/** The Pembayaran that refused. */
	readonly paymentId: string;
	/** Every Pengembalian in force drawn on it, oldest first. */
	readonly refunds: readonly BlockingRefund[];

	constructor(paymentId: string, blocking: readonly BlockingRefund[]) {
		super(
			`Payment "${paymentId}" has ${blocking.length} refund(s) in force and its verification cannot be undone until each is reversed: ${blocking
				.map((refund) => refund.refundId)
				.join(', ')}.`
		);
		this.paymentId = paymentId;
		this.refunds = blocking;
	}
}

/** Who is undoing, which Pembayaran, and the reason the Warga, the Koreksi and the audit log keep. */
export interface UnverifyPaymentRequest extends DuesCorrectionRequest {
	readonly paymentId: string;
}

/** What one Pembatalan verifikasi came to, committed together. */
export interface UnverifiedPayment {
	readonly unitId: string;
	/** The Pembayaran as it now stands: `rejected`, the reason as its `rejectionReason`. */
	readonly payment: Payment;
	/** The Koreksi of its income line: `expense`, same amount, same day, in "Iuran warga". */
	readonly correction: CashTransaction;
	/** Every Alokasi released, oldest first, as each stood when it was deleted. */
	readonly releasedAllocations: readonly Allocation[];
}

/**
 * Undoes the verification of one Pembayaran: the Pembayaran locked and refused unless verified and
 * free of Pengembalian in force, every Alokasi of it released under its Tagihan's locks, its income
 * line reversed by one Koreksi through the writer's `unverifyCorrection` kind on the line's own day,
 * the row turned `rejected` with the reason, and one `PaymentUnverifiedRecord`. After the commit the
 * recorder's `payment-rejected` email is queued, and a failure to queue it fails nothing.
 *
 * @throws {PermissionDeniedError} when `actorId` may not correct dues.
 * @throws {PaymentNotFoundError} when `paymentId` names no Pembayaran.
 * @throws {UnverifyRuleError} `reasonMissing`, `notVerified` or `verificationRecordMissing`.
 * @throws {UnverifyRefusedRefundedError} when a Pengembalian drawn on it is in force, naming each.
 * @throws {PeriodLockedError} when the income line's day falls inside a Periode that is locked.
 *   Nothing is written; the month is reopened first.
 * @throws {CashTransactionAlreadyCorrectedError} when the income line already carries a Koreksi,
 *   which only an Admin's ordinary Koreksi from before #323 can have written.
 */
export async function unverifyPayment(
	db: Database,
	clock: Clock,
	request: UnverifyPaymentRequest
): Promise<UnverifiedPayment> {
	const outcome = await runDuesCorrection(
		db,
		clock,
		request,
		() =>
			new UnverifyRuleError(
				UNVERIFY_RULE.reasonMissing,
				'Undoing a verification tells the payer why and is kept on the Koreksi and in the audit log, so an empty reason is refused.'
			),
		async ({ transaction, actorId, reason }) => {
			const payment = await lockVerifiedPayment(transaction, request.paymentId);
			await refuseRefundsInForce(transaction, payment.id);

			// Under the payment lock, in a fresh statement: every writer of this payment's Alokasi holds
			// that lock, so the set read here is the set deleted below.
			const held = await transaction
				.select()
				.from(allocations)
				.where(eq(allocations.paymentId, payment.id))
				.orderBy(asc(allocations.createdAt), asc(allocations.id));
			await lockAllocatedInvoices(
				transaction,
				held.map((allocation) => allocation.invoiceId)
			);
			if (held.length > 0) {
				await transaction.delete(allocations).where(
					inArray(
						allocations.id,
						held.map((allocation) => allocation.id)
					)
				);
			}

			const cashTransactionId = await verifiedIncomeLineOf(transaction, payment.id);
			const correction = await writeCashTransaction(transaction, clock, {
				kind: CASH_WRITE_KIND.unverifyCorrection,
				recordedBy: actorId,
				transactionId: cashTransactionId,
				reason
			});
			// The writer already refused a line that is not a dues income line. A dues income line of
			// another amount or day is another payment's: a defect in the record, rolled back here.
			if (correction.amount !== payment.amount || correction.occurredOn !== payment.receivedOn) {
				throw new Error(
					`The verification record of payment "${payment.id}" names cash transaction "${cashTransactionId}", whose amount or day is not the payment's.`
				);
			}

			const [rejected] = await transaction
				.update(payments)
				// One statement: `payments_verification_check` refuses the verifier and the instant
				// cleared apart from the status, and `payments_rejection_reason_check` a reason on a row
				// that is not rejected.
				.set({
					status: PAYMENT_STATUS.rejected,
					rejectionReason: reason,
					verifiedBy: null,
					verifiedAt: null
				})
				.where(eq(payments.id, payment.id))
				.returning();

			return {
				outcome: {
					unitId: payment.unitId,
					payment: rejected,
					correction,
					releasedAllocations: held
				},
				record: {
					action: PAYMENT_UNVERIFIED_ACTION,
					targetId: payment.id,
					before: {
						status: PAYMENT_STATUS.verified,
						verifiedBy: payment.verifiedBy,
						verifiedAt: payment.verifiedAt.toISOString()
					},
					after: {
						unitId: payment.unitId,
						reason,
						status: PAYMENT_STATUS.rejected,
						amount: payment.amount,
						receivedOn: payment.receivedOn,
						cashTransactionId,
						correctionId: correction.id,
						allocations: held.map((allocation): UnverifyReleasedAllocationRecord => ({
							allocationId: allocation.id,
							invoiceId: allocation.invoiceId,
							amount: allocation.amount,
							createdAt: allocation.createdAt.toISOString()
						}))
					}
				} satisfies PaymentUnverifiedRecord
			};
		}
	);

	// After the commit, never inside it: `runDuesCorrection` resolves once the transaction has
	// committed, and the email names a decision that has to have happened.
	await announceAfterCommit(
		`the "${PAYMENT_REJECTED_KIND}" email for Pembayaran ${outcome.payment.id}`,
		() => notifyPaymentRejected(db, clock, outcome.payment)
	);
	return outcome;
}

/** A verified Pembayaran row, its verifier and instant known present. */
type VerifiedPayment = Payment & { readonly verifiedBy: string; readonly verifiedAt: Date };

/**
 * The Pembayaran named by `paymentId`, locked `for update` and still verified.
 *
 * @throws {PaymentNotFoundError} when the id names no row.
 * @throws {UnverifyRuleError} `notVerified` when the row is pending or rejected.
 */
async function lockVerifiedPayment(
	transaction: Transaction,
	paymentId: string
): Promise<VerifiedPayment> {
	const [row] = await transaction
		.select()
		.from(payments)
		.where(eq(payments.id, paymentId))
		.limit(1)
		.for('update');
	if (!row) {
		throw new PaymentNotFoundError(paymentId);
	}
	if (row.status !== PAYMENT_STATUS.verified) {
		throw new UnverifyRuleError(
			UNVERIFY_RULE.notVerified,
			`Payment "${row.id}" is "${row.status}", and only a verified payment's verification can be undone.`
		);
	}
	const { verifiedBy, verifiedAt } = row;
	// Unreachable: `payments_verification_check` requires both on every verified row. Stated rather
	// than asserted away, as `lockSpentPayment` does.
	if (verifiedBy === null || verifiedAt === null) {
		throw new Error(`Payment "${row.id}" is verified but carries no verifier or instant.`);
	}
	return { ...row, verifiedBy, verifiedAt };
}

/**
 * Refuses the Pembatalan verifikasi while a Pengembalian drawn on `paymentId` is in force. Read in a
 * fresh statement under the payment lock, with the one rule for "in force", `refundInForce`.
 *
 * @throws {UnverifyRefusedRefundedError} naming every such Pengembalian, oldest first.
 */
async function refuseRefundsInForce(transaction: Transaction, paymentId: string): Promise<void> {
	const blocking = await transaction
		.select({
			refundId: refunds.id,
			amount: refunds.amount,
			occurredOn: cashTransactions.occurredOn
		})
		.from(refunds)
		.innerJoin(cashTransactions, eq(cashTransactions.id, refunds.cashTransactionId))
		.where(and(eq(refunds.paymentId, paymentId), refundInForce()))
		.orderBy(asc(cashTransactions.occurredOn), asc(refunds.createdAt), asc(refunds.id));
	if (blocking.length > 0) {
		throw new UnverifyRefusedRefundedError(paymentId, blocking);
	}
}

/**
 * Takes `for update` on every Tagihan in `invoiceIds`, Periode first then id: the order
 * `lockOpenInvoicesOfUnit` locks a Unit's Tagihan in, so this and a verification of another payment
 * of the Unit wait on each other in one direction only.
 */
async function lockAllocatedInvoices(
	transaction: Transaction,
	invoiceIds: readonly string[]
): Promise<void> {
	const distinct = [...new Set(invoiceIds)];
	if (distinct.length === 0) {
		return;
	}
	const rows = await transaction
		.select({ id: invoices.id })
		.from(invoices)
		.where(inArray(invoices.id, distinct))
		.orderBy(asc(invoices.period), asc(invoices.id))
		.for('update');
	// Unreachable for the reason `lockAllocatedInvoice` gives: the foreign key has no cascade.
	if (rows.length !== distinct.length) {
		throw new Error(`An invoice is gone although an allocation still points at it.`);
	}
}

/** The part of a `payment_verified` record this action reads, checked against the writer's type. */
const isVerificationLink = objectOf<Pick<PaymentVerifiedAfter, 'cashTransactionId'>>({
	cashTransactionId: isString
});

/**
 * The income line the verification of `paymentId` wrote, read off its `payment_verified` Audit Log
 * record. A Pembayaran leaves `pending` once, so it has at most one such record.
 *
 * @throws {UnverifyRuleError} `verificationRecordMissing` when there is no record, or it names no line.
 */
async function verifiedIncomeLineOf(transaction: Transaction, paymentId: string): Promise<string> {
	const verifications = (await auditEntriesFor(transaction, paymentId)).filter(
		(entry) => entry.action === PAYMENT_VERIFIED_ACTION
	);
	if (verifications.length > 1) {
		throw new Error(
			`Payment "${paymentId}" has ${verifications.length} verification records, and a payment is verified once.`
		);
	}
	const after: unknown = verifications[0]?.after;
	// `isUuid` too: the id is read back from `jsonb`, and any other shape would reach the `uuid`
	// column below as a driver error rather than as this refusal.
	if (!isVerificationLink(after) || !isUuid(after.cashTransactionId)) {
		throw new UnverifyRuleError(
			UNVERIFY_RULE.verificationRecordMissing,
			`No verification record of payment "${paymentId}" names the cash transaction it wrote, so there is no line known to be this payment's to reverse.`
		);
	}
	const [line] = await transaction
		.select({ id: cashTransactions.id })
		.from(cashTransactions)
		.where(eq(cashTransactions.id, after.cashTransactionId))
		.limit(1);
	if (!line) {
		throw new UnverifyRuleError(
			UNVERIFY_RULE.verificationRecordMissing,
			`The verification record of payment "${paymentId}" names cash transaction "${after.cashTransactionId}", which does not exist.`
		);
	}
	return line.id;
}
