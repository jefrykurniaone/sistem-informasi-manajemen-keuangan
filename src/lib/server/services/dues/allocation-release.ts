import { eq } from 'drizzle-orm';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { allocations, type Allocation } from '../../db/schema/allocation';
import { invoices } from '../../db/schema/invoice';
import { payments } from '../../db/schema/payment';
import type { Clock } from '../../ports/clock';

/**
 * Pelepasan Alokasi: deleting one `allocations` row so its money becomes the Unit's Saldo Titipan
 * again — user story 22 of `docs/spec-iuran-v1.md`, the second of #30's three superuser
 * corrections, and the release `./allocation.ts` announced under "What deliberately is not here".
 *
 * `ACTION.correctDues` in `src/lib/server/authz.ts` is granted to `superuser` alone, so the one
 * guarded function below is, today, a superuser-only function; that is a fact about the permission
 * table, not something re-decided here.
 *
 * ## The deletion is the whole restoration
 *
 * Saldo titipan is *defined* as verified payments less their allocations less their refunds
 * (`./credit-balance.ts`), and a Tagihan's status is *defined* as its amount against its allocated
 * sum (`invoiceStatus` in `./queries.ts`). Deleting the row therefore restores the balance and
 * reopens the Tagihan in the same instant, with no second write that could be skipped and no
 * compensating column that could be wrong — the argument
 * `src/lib/server/db/schema/allocation.ts` records for why this is the one table in the iuran
 * schema whose rows are deleted on purpose. **No cash row is touched**: the money entered the buku
 * kas when its Pembayaran was verified and it has not left the complex, only its peruntukan
 * changed. The audit row is where the fact of the release lives, which is exactly what
 * `docs/spec-iuran-v1.md:171-172` asks ("pelepasan alokasi" is on its list), and why the row
 * carries everything the deleted Alokasi said.
 *
 * ## The locks, in the fixed order: payment first, invoice second
 *
 * `./allocation.ts` warned that a release "must take the same payment row lock every writer here
 * takes, or its read of 'what this payment still covers' races the writers above", and this module
 * is that warning honoured:
 *
 * - **The payment row, `for update`, first.** Every spender of this payment's remainder —
 *   verification, issuance's credit application, and #30's refund — holds this lock while it reads
 *   sums and writes rows. Holding it here means a release and a spend serialise: whichever runs
 *   second sees the other's committed rows, so a remainder is never computed from a half-changed
 *   set.
 * - **The Tagihan row, `for update`, second** — the same direction verification takes them
 *   (payment, then the Unit's invoices), so no pair of writers can wait on each other in a cycle.
 *   The invoice lock is what serialises a release against a void: `./invoice-void.ts` counts
 *   allocations under this same lock, so a void and a release of the same Tagihan cannot
 *   interleave into a voided Tagihan that still has a row here.
 *
 * The Alokasi itself is re-read by id in a fresh statement only after both locks are held: two
 * releases of the same row serialise on the payment lock, and the loser finds the row already
 * gone and answers `AllocationNotFoundError` instead of deleting nothing silently.
 */

/** The audit log's `action` for an Alokasi a superuser released. */
export const ALLOCATION_RELEASED_ACTION = 'allocation_released';

/**
 * Every rule this service refuses a request for, other than permission — one member today, shaped
 * like `VOID_RULE` so the finance screen maps it through the same exhaustive `Record`.
 */
export const RELEASE_RULE = {
	/** A release records why — the audit criterion "beserta alasannya" — so an empty reason is refused. */
	reasonMissing: 'reasonMissing'
} as const;

/** One of the rules above. */
export type ReleaseRule = (typeof RELEASE_RULE)[keyof typeof RELEASE_RULE];

/** Thrown when this service refuses a request by one of the rules in `RELEASE_RULE`. */
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
 * Thrown when `allocationId` names no Alokasi — an id no screen ever rendered, or a row a
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
export interface ReleaseAllocationRequest {
	/** The signed-in superuser. Checked against `ACTION.correctDues` before anything else. */
	readonly actorId: string;
	readonly allocationId: string;
	/** Why the money should answer nothing again. Required. */
	readonly reason: string;
}

/**
 * Releases one Alokasi: the row is deleted under the payment's and the Tagihan's row locks, the
 * money is saldo titipan again by definition, no cash row moves, and one audit row keeps
 * everything the deleted row said.
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
	const reason = request.reason.trim();

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.correctDues);
		if (reason === '') {
			throw new ReleaseRuleError(
				RELEASE_RULE.reasonMissing,
				'Releasing an allocation records why in the audit log, so an empty reason is refused.'
			);
		}

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

		// Under both locks, in a fresh statement: a concurrent release that won the payment lock has
		// already committed its deletion, and this read sees it.
		const [held] = await transaction
			.select()
			.from(allocations)
			.where(eq(allocations.id, request.allocationId))
			.limit(1);
		if (!held) {
			throw new AllocationNotFoundError(request.allocationId);
		}

		await transaction.delete(allocations).where(eq(allocations.id, held.id));

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: ALLOCATION_RELEASED_ACTION,
			targetId: held.id,
			// The deleted row's whole content: the audit log is the only place a released Alokasi
			// survives, which is the design `src/lib/server/db/schema/allocation.ts` records.
			before: {
				paymentId: held.paymentId,
				invoiceId: held.invoiceId,
				amount: held.amount,
				createdAt: held.createdAt.toISOString()
			},
			after: {
				// `unitId` is here for `./corrections-history.ts`, exactly as `invoice_voided` carries it.
				unitId,
				reason
			}
		});

		return held;
	});
}

/**
 * Takes `for update` on the Pembayaran whose money the Alokasi holds — the same lock every spender
 * of that payment's remainder takes — and answers the Unit it belongs to, which the audit row
 * needs anyway.
 */
async function lockSpentPayment(transaction: Transaction, paymentId: string): Promise<string> {
	const [row] = await transaction
		.select({ unitId: payments.unitId })
		.from(payments)
		.where(eq(payments.id, paymentId))
		.limit(1)
		.for('update');
	// Unreachable while the allocation exists: `allocations_payment_id_payments_id_fk` carries no
	// cascade, so a payment with an allocation cannot be deleted. Stated rather than asserted away.
	if (!row) {
		throw new Error(`Payment "${paymentId}" is gone although an allocation still points at it.`);
	}
	return row.unitId;
}

/** Takes `for update` on the Tagihan the Alokasi answers — the lock `voidInvoice` counts under. */
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
