import { eq, inArray } from 'drizzle-orm';
import { rupiah, type Rupiah } from '#lib/money.ts';
import type { Database } from '../../db';
import type { Allocation } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import type { Payment } from '../../db/schema/payment';
import { residents } from '../../db/schema/resident';
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
import { isInvoiceVisible, residentViewFor, type ResidentView } from '../occupancy/resident-view';
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
 * Queues the `payment-verified` email to `payment.recordedBy`, naming the total amount and the
 * Tagihan `allocations` settled that fall inside the recorder's own Masa Huni —
 * `VerificationOutcome.allocations`, exactly as `./verification.ts` already has it in hand once its
 * transaction returns.
 *
 * The Alokasi runs from the oldest Tagihan of the whole Unit (`./allocation.ts`), so a payment can
 * settle a Tagihan from before the recorder lived there. They must not read it in their email (#335,
 * the rule `isInvoiceVisible` states for every personal screen): the part that went to such Tagihan
 * is summed into `outsideTenureAmount`, one figure with no Periode, and the payment's total stays as
 * it is.
 *
 * @throws whatever `announce` throws; the callers wrap this in `announceAfterCommit`.
 */
export async function notifyPaymentVerified(
	db: Database,
	clock: Clock,
	payment: Payment,
	allocations: readonly Allocation[]
): Promise<void> {
	const { settlements, outsideTenureAmount } = await settlementsOf(
		db,
		clock,
		payment.recordedBy,
		allocations
	);
	await announce(db, clock, {
		kind: PAYMENT_VERIFIED_KIND,
		recipients: [payment.recordedBy],
		payload: ({ locale }) =>
			paymentVerifiedPayload({ amount: payment.amount, settlements, outsideTenureAmount, locale })
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

/**
 * `allocations` split by what the recorder may read: each one inside their Masa Huni with its
 * Tagihan period attached, and the rest summed — one query for the Tagihan, one for the recorder's
 * `ResidentView`, not one per allocation.
 *
 * `residentViewFor` takes an account id and `recordedBy` is a `residents.id`, so the account is
 * looked up first. A recorder with no row, or no Masa Huni, has an empty view, and every Tagihan is
 * then outside it.
 */
async function settlementsOf(
	db: Database,
	clock: Clock,
	recordedBy: string,
	allocations: readonly Allocation[]
): Promise<{ settlements: readonly PaymentVerifiedSettlement[]; outsideTenureAmount: number }> {
	if (allocations.length === 0) {
		return { settlements: [], outsideTenureAmount: 0 };
	}
	const rows = await db
		.select({ id: invoices.id, unitId: invoices.unitId, period: invoices.period })
		.from(invoices)
		.where(
			inArray(
				invoices.id,
				allocations.map((allocation) => allocation.invoiceId)
			)
		);
	const invoiceById = new Map(rows.map((row) => [row.id, row]));
	const view = await viewOfRecorder(db, clock, recordedBy);

	const settlements: PaymentVerifiedSettlement[] = [];
	let outsideTenureAmount = 0;
	for (const allocation of allocations) {
		const invoice = invoiceById.get(allocation.invoiceId);
		// `allocations.invoiceId` has no `onDelete`, so a missing invoice row is unreachable in
		// practice, not a case worth its own error type. Without the row there is no Unit to test
		// against, so what it settled is counted as outside rather than shown.
		if (invoice && isInvoiceVisible(view, invoice)) {
			settlements.push({ period: invoice.period, amount: allocation.amount });
		} else {
			outsideTenureAmount = rupiah(outsideTenureAmount + allocation.amount);
		}
	}
	return { settlements, outsideTenureAmount };
}

/** The `ResidentView` of the account behind `residents.id` `recordedBy`; empty when it has none. */
async function viewOfRecorder(
	db: Database,
	clock: Clock,
	recordedBy: string
): Promise<ResidentView> {
	const [recorder] = await db
		.select({ userId: residents.userId })
		.from(residents)
		.where(eq(residents.id, recordedBy));
	return recorder ? residentViewFor(db, clock, recorder.userId) : { units: [] };
}
