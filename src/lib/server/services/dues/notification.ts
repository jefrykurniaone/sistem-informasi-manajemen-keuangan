import { inArray } from 'drizzle-orm';
import type { Rupiah } from '#lib/money.ts';
import type { Database } from '../../db';
import type { Allocation } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import type { Payment } from '../../db/schema/payment';
import { announce, type AnnounceOutcome } from '../../email/announce';
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
import { primaryOccupantsOn } from '../occupancy';
import { currentDay } from '../occupancy/visibility';

/**
 * What the three transactional emails ticket #31 added say and who they are addressed to:
 * `invoice-issued` and `payment-verified` — both mandatory `SUBSCRIPTION_KIND`s — and
 * `payment-rejected`, which no Langganan governs, so it is sent like a mandatory kind.
 * `./issuance.ts` and `./verification.ts` are this module's only callers, each after its own writing
 * transaction has already committed — see the doc comment on `../../email/queue.ts` for why
 * enqueueing never happens inside the transaction that causes it.
 *
 * This module only names the recipient and builds the payload. `../../email/announce.ts` does the
 * rest: the Langganan (none applies to these three), the one queue row per resident, the address
 * lookup and the language.
 *
 * ## Recipients, and why each is found the way it is
 *
 * - **`invoice-issued`** goes to the Unit's Penanggung Jawab today, as `primaryOccupantsOn` in
 *   `../occupancy/index.ts` answers it — the one read, with the one pick order, every screen and
 *   service that names the Penanggung Jawab asks. The flag moves between stays
 *   (`docs/adr/0001-penanggung-jawab-berpindah.md`), so a flagged stay that has not begun is not the
 *   recipient yet, and one whose last day has passed no longer is. A Unit with none is still
 *   invoiced; `notifyInvoiceIssued` then queues nothing, and the caller in `./issuance.ts` is the
 *   one that records the skip in `InvoiceIssuanceSummary`.
 * - **`payment-verified`** and **`payment-rejected`** both go to the Pembayaran's recorder
 *   (`payments.recordedBy`, a `residents.id` — see `src/lib/server/db/schema/payment.ts`), never to
 *   whoever verified or rejected it.
 *
 * ## A failure here must never undo, or appear to undo, a committed decision, and this is not where
 * that is kept
 *
 * By the time any function below runs, the Tagihan is issued or the Pembayaran is decided — that
 * transaction already committed. Every function below therefore throws whatever `announce` throws,
 * and each of its callers in `./issuance.ts` and `./verification.ts` wraps the call in
 * `announceAfterCommit`, which logs the failure and reports the committed decision as the success it
 * is (#309, decision 1). Keeping the rule at the call site is what makes it hold for whatever a
 * caller substitutes for these functions as well.
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
 * Queues the `invoice-issued` email to `notification.unitId`'s Penanggung Jawab today, when it has
 * one.
 *
 * @param db the plain database, once the Tagihan's transaction has committed.
 * @returns what `announce` queued: `queued` is empty for a Unit with no Penanggung Jawab today, which
 *   the caller in `./issuance.ts` records in `InvoiceIssuanceSummary.skippedNotifications`.
 * @throws whatever `announce` throws; the caller wraps this in `announceAfterCommit`.
 */
export async function notifyInvoiceIssued(
	db: Database,
	clock: Clock,
	notification: InvoiceIssuedNotification
): Promise<AnnounceOutcome> {
	return announce(db, clock, {
		kind: INVOICE_ISSUED_KIND,
		recipients: async (database) => {
			const primary = await primaryOccupantsOn(database, currentDay(clock), [notification.unitId]);
			const occupant = primary.get(notification.unitId);
			return occupant ? [occupant.residentId] : [];
		},
		payload: ({ locale }) =>
			invoiceIssuedPayload({
				block: notification.block,
				number: notification.number,
				period: notification.period,
				amount: notification.amount,
				dueDate: notification.dueDate,
				locale
			})
	});
}

/**
 * Queues the `payment-verified` email to `payment.recordedBy`, naming the total amount and every
 * Tagihan `allocations` settled — `VerificationOutcome.allocations`, exactly as `./verification.ts`
 * already has it in hand once its transaction returns.
 *
 * @throws whatever `announce` throws; the callers wrap this in `announceAfterCommit`.
 */
export async function notifyPaymentVerified(
	db: Database,
	clock: Clock,
	payment: Payment,
	allocations: readonly Allocation[]
): Promise<void> {
	const settlements = await settlementsOf(db, allocations);
	await announce(db, clock, {
		kind: PAYMENT_VERIFIED_KIND,
		recipients: [payment.recordedBy],
		payload: ({ locale }) => paymentVerifiedPayload({ amount: payment.amount, settlements, locale })
	});
}

/**
 * Queues the `payment-rejected` email to `payment.recordedBy`, naming `payment.rejectionReason`.
 *
 * @throws whatever `announce` throws; the caller wraps this in `announceAfterCommit`.
 */
export async function notifyPaymentRejected(
	db: Database,
	clock: Clock,
	payment: Payment
): Promise<void> {
	if (payment.rejectionReason === null) {
		// `payments_rejection_reason_check` guarantees this never happens on a row that is really
		// rejected; refusing quietly here is cheaper than a second named error nothing can act on.
		return;
	}
	const reason = payment.rejectionReason;
	await announce(db, clock, {
		kind: PAYMENT_REJECTED_KIND,
		recipients: [payment.recordedBy],
		payload: ({ locale }) => paymentRejectedPayload({ amount: payment.amount, reason, locale })
	});
}

/** `allocations`, with each one's Tagihan period attached — one query, not one per allocation. */
async function settlementsOf(
	db: Database,
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
