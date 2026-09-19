import { and, eq, inArray } from 'drizzle-orm';
import type { Rupiah } from '$lib/money';
import type { DatabaseWriter } from '../../authz';
import { user } from '../../db/schema/auth';
import type { Allocation } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import { occupancies } from '../../db/schema/occupancy';
import type { Payment } from '../../db/schema/payment';
import { residents } from '../../db/schema/resident';
import { enqueueEmail } from '../../email/queue';
import { INVOICE_ISSUED_KIND, invoiceIssuedPayload } from '../../email/templates/invoice-issued';
import {
	PAYMENT_REJECTED_KIND,
	paymentRejectedPayload
} from '../../email/templates/payment-rejected';
import {
	PAYMENT_VERIFIED_KIND,
	paymentVerifiedPayload,
	type PaymentVerifiedSettlement
} from '../../email/templates/payment-verified';
import type { Clock } from '../../ports/clock';
import { currentDay, stillRunningOn } from '../occupancy/visibility';

/**
 * Where the three transactional emails ticket #31 adds get queued from: `invoice-issued` and
 * `payment-verified` — both mandatory `SUBSCRIPTION_KIND`s — and `payment-rejected`, transactional
 * like `registration-approved`. `./issuance.ts` and `./verification.ts` are this module's only
 * callers, each after its own writing transaction has already committed — see the doc comment on
 * `../../email/queue.ts` for why enqueueing never happens inside the transaction that causes it.
 *
 * ## Recipients, and why each is found the way it is
 *
 * - **`invoice-issued`** goes to the Unit's *active* primary occupant, found here with
 *   `stillRunningOn` and `occupancies.isPrimaryOccupant` from `./visibility.ts` and
 *   `./occupancy/index.ts` — never a redefinition of "living here now". A Unit with none is still
 *   invoiced; this module only answers whether it found somewhere to send the email, and the caller
 *   in `./issuance.ts` is the one that records the skip in `InvoiceIssuanceSummary`.
 * - **`payment-verified`** and **`payment-rejected`** both go to the Pembayaran's recorder
 *   (`payments.recordedBy`, a `residents.id` — see `src/lib/server/db/schema/payment.ts`), never to
 *   whoever verified or rejected it.
 *
 * ## A failure here must never undo, or appear to undo, a committed decision
 *
 * By the time any function below runs, the Tagihan is issued or the Pembayaran is decided — that
 * transaction already committed. If finding a recipient or enqueueing the email then throws (a
 * transient database error, or — as `tests/unit/payment-verification.test.ts`'s own
 * failure-injecting clock proves is possible — any read of the clock), letting that exception
 * propagate out of `verifyPayment`/`rejectPayment`/`issueInvoicesForPeriod` would report the whole
 * operation as failed to a caller who would then act as though the Tagihan was never issued or the
 * Pembayaran never decided — which is exactly backwards, since the side effect that actually failed
 * is the least important part of what just happened. Every function below therefore catches its own
 * failures, logs them to the console (there is no logger in this application yet — the same honest
 * placement `describeIssuance`'s caller in `./jobs.ts` uses), and resolves rather than rejects.
 */

/** One Unit whose Tagihan a run just wrote, and everything its email needs. */
export interface InvoiceIssuedNotification {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly period: string;
	readonly amount: Rupiah;
	readonly dueDate: string;
}

/**
 * Queues the `invoice-issued` email to `notification.unitId`'s active primary occupant, when it has
 * one.
 *
 * @returns whether an email was queued. `false` means either the Unit has no active primary
 *   occupant, or queuing failed and was logged — the caller in `./issuance.ts` treats both the same
 *   way, as a Unit to record in `InvoiceIssuanceSummary.skippedNotifications`.
 */
export async function notifyInvoiceIssued(
	db: DatabaseWriter,
	clock: Clock,
	notification: InvoiceIssuedNotification
): Promise<boolean> {
	let notified = false;
	await swallowing(INVOICE_ISSUED_KIND, async () => {
		const recipient = await activePrimaryOccupantEmail(db, clock, notification.unitId);
		if (!recipient) {
			return;
		}
		await enqueueEmail(db, clock, {
			recipient,
			kind: INVOICE_ISSUED_KIND,
			payload: invoiceIssuedPayload({
				block: notification.block,
				number: notification.number,
				period: notification.period,
				amount: notification.amount,
				dueDate: notification.dueDate
			})
		});
		notified = true;
	});
	return notified;
}

/**
 * Queues the `payment-verified` email to `payment.recordedBy`, naming the total amount and every
 * Tagihan `allocations` settled — `VerificationOutcome.allocations`, exactly as `./verification.ts`
 * already has it in hand once its transaction returns.
 */
export async function notifyPaymentVerified(
	db: DatabaseWriter,
	clock: Clock,
	payment: Payment,
	allocations: readonly Allocation[]
): Promise<void> {
	await swallowing(PAYMENT_VERIFIED_KIND, async () => {
		const recipient = await recorderEmail(db, payment.recordedBy);
		if (!recipient) {
			return;
		}
		await enqueueEmail(db, clock, {
			recipient,
			kind: PAYMENT_VERIFIED_KIND,
			payload: paymentVerifiedPayload({
				amount: payment.amount,
				settlements: await settlementsOf(db, allocations)
			})
		});
	});
}

/** Queues the `payment-rejected` email to `payment.recordedBy`, naming `payment.rejectionReason`. */
export async function notifyPaymentRejected(
	db: DatabaseWriter,
	clock: Clock,
	payment: Payment
): Promise<void> {
	await swallowing(PAYMENT_REJECTED_KIND, async () => {
		if (payment.rejectionReason === null) {
			// `payments_rejection_reason_check` guarantees this never happens on a row that is really
			// rejected; refusing quietly here is cheaper than a second named error nothing can act on.
			return;
		}
		const recipient = await recorderEmail(db, payment.recordedBy);
		if (!recipient) {
			return;
		}
		await enqueueEmail(db, clock, {
			recipient,
			kind: PAYMENT_REJECTED_KIND,
			payload: paymentRejectedPayload({ amount: payment.amount, reason: payment.rejectionReason })
		});
	});
}

/**
 * Runs `action`, catching and logging whatever it throws instead of letting it reach the caller —
 * see this module's doc comment for why a notification failure must never look like the business
 * operation that caused it failed too.
 */
async function swallowing(kind: string, action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		console.error(
			`Queuing a "${kind}" notification failed after the change it announces had already committed:`,
			error
		);
	}
}

/**
 * The email of `unitId`'s active primary occupant today, or `undefined` when it has none —
 * `occupancies.isPrimaryOccupant` together with `stillRunningOn`, the one definition of "living here
 * now" `src/lib/server/services/occupancy/visibility.ts` publishes.
 */
async function activePrimaryOccupantEmail(
	db: DatabaseWriter,
	clock: Clock,
	unitId: string
): Promise<string | undefined> {
	const today = currentDay(clock);
	const [row] = await db
		.select({ email: user.email })
		.from(occupancies)
		.innerJoin(residents, eq(residents.id, occupancies.residentId))
		.innerJoin(user, eq(user.id, residents.userId))
		.where(
			and(
				eq(occupancies.unitId, unitId),
				eq(occupancies.isPrimaryOccupant, true),
				stillRunningOn(occupancies.endedOn, today)
			)
		)
		.limit(1);
	return row?.email;
}

/** The email behind a `residents.id`, or `undefined` when the row is somehow gone. */
async function recorderEmail(db: DatabaseWriter, residentId: string): Promise<string | undefined> {
	const [row] = await db
		.select({ email: user.email })
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(residents.id, residentId))
		.limit(1);
	return row?.email;
}

/** `allocations`, with each one's Tagihan period attached — one query, not one per allocation. */
async function settlementsOf(
	db: DatabaseWriter,
	allocations: readonly Allocation[]
): Promise<readonly PaymentVerifiedSettlement[]> {
	if (allocations.length === 0) {
		return [];
	}
	const rows = await db
		.select({ id: invoices.id, period: invoices.period })
		.from(invoices)
		.where(
			inArray(
				invoices.id,
				allocations.map((allocation) => allocation.invoiceId)
			)
		);
	const periodById = new Map(rows.map((row) => [row.id, row.period]));
	return allocations.map((allocation) => ({
		// Falls back to the id itself only if the invoice row is somehow gone — allocations.invoiceId
		// has no `onDelete`, so this is unreachable in practice, not a case worth its own error type.
		period: periodById.get(allocation.invoiceId) ?? allocation.invoiceId,
		amount: allocation.amount
	}));
}
