import { eq } from 'drizzle-orm';
import type { Rupiah } from '$lib/money';
import { recordAuditEntry } from '../../audit';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { allocations } from '../../db/schema/allocation';
import { invoices, type Invoice } from '../../db/schema/invoice';
import { residents } from '../../db/schema/resident';
import type { Clock } from '../../ports/clock';

/**
 * Pembatalan Tagihan: marking one Tagihan `void` with a reason and an actor, never deleting it —
 * user story 20 of `docs/spec-iuran-v1.md`, and the first of the three superuser corrections #30
 * lands (`./allocation-release.ts` and `./credit-refund.ts` are the other two, and
 * `./corrections-history.ts` reads all three back).
 *
 * `ACTION.correctDues` in `src/lib/server/authz.ts` is granted to `superuser` alone, so every
 * guarded function below is, today, a superuser-only function; that is a fact about the permission
 * table, not something re-decided here.
 *
 * ## Why a void moves no money, and what that buys
 *
 * A void writes `voidedAt`, `voidReason` and `voidedBy` — one `update`, all three together, which
 * is the only combination `invoices_void_check` accepts — and touches nothing else: no cash row,
 * no Periode consulted, no allocation. It may only do that because of the rule it enforces first:
 * **a Tagihan that has absorbed money cannot be voided.** `docs/spec-iuran-v1.md:156-161` gives
 * the reason — cancelling an allocated Tagihan makes money vanish from the Tagihan's side without
 * a trace — and the refusal here names every Alokasi that has to be released first, which is the
 * spec's "pesan yang menyebut langkah yang harus dilakukan lebih dulu".
 *
 * ## The lock, and why it is only the invoice's
 *
 * The Tagihan row is taken `for update` before its allocations are counted, and that one lock is
 * sufficient because every writer that can grow this invoice's allocated sum already holds it:
 *
 * - **Verification** locks the Unit's open Tagihan through `lockOpenInvoicesOfUnit` before it
 *   plans. If verification holds the lock first, this void waits, then counts under a fresh
 *   snapshot and sees the new Alokasi — refused. If this void commits first, verification's
 *   locking read re-evaluates its `voidedAt is null` filter on the committed row and **excludes
 *   it**, so a voided Tagihan can never absorb new money.
 * - **Issuance's credit application** allocates only onto the Tagihan its own transaction just
 *   inserted, which this void cannot even see until that transaction commits — and after it
 *   commits, the count here reads the allocation.
 *
 * So "no allocations at the moment of voiding" is checked and made permanent in one critical
 * section, and the pair of invariants — a void Tagihan has no Alokasi, an Alokasi's Tagihan is
 * never void — holds in both directions. Payment rows are deliberately not locked: a void neither
 * reads nor changes any payment's remainder, and taking locks it does not need would only widen
 * the surface a deadlock analysis has to cover. The lock order stays one-way regardless: this
 * module takes an invoice lock and nothing after it.
 */

/** The audit log's `action` for a Tagihan a superuser cancelled. */
export const INVOICE_VOIDED_ACTION = 'invoice_voided';

/**
 * Every rule this service refuses a request for, other than permission. The same shape
 * `VERIFICATION_RULE` has and for the same reason: the finance screen maps each of these to a
 * sentence through an exhaustive `Record`, so a rule added later is a type error there until
 * somebody writes its message. These are refusals of a request, never of the caller, so a route
 * answers them with `fail(400, …)` rather than a 403.
 */
export const VOID_RULE = {
	/** A cancellation records why — "dengan alasan wajib" — so an empty reason is refused. */
	reasonMissing: 'reasonMissing',
	/** The Tagihan is already void. There is no second cancellation and no un-cancellation here. */
	alreadyVoided: 'alreadyVoided',
	/**
	 * The cancelling superuser has no `residents` row. `invoices.voidedBy` references
	 * `residents.id`, so there is nowhere to attribute the cancellation — the same shape
	 * `actorNotRegistered` has in `./verification.ts`.
	 */
	actorNotRegistered: 'actorNotRegistered'
} as const;

/** One of the rules above. */
export type VoidRule = (typeof VOID_RULE)[keyof typeof VOID_RULE];

/**
 * Thrown when this service refuses a request by one of the rules in `VOID_RULE`. Named and
 * `instanceof`-checkable for the reason `VerificationRuleError` is; it lives here rather than in
 * `src/lib/errors.ts` because that file is outside this ticket's surface.
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
	/** The Pembayaran whose money the Alokasi holds — where a release will send it back. */
	readonly paymentId: string;
	readonly amount: Rupiah;
}

/**
 * Thrown when the Tagihan still has Alokasi — the acceptance criteria's named refusal, carrying
 * every allocation that has to be released first so the screen can say exactly which, not merely
 * that some exist. A class of its own rather than a `VOID_RULE` member because it carries data no
 * other rule has; a route answers it with `fail(400, …)` like the rules.
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
 * Thrown when `invoiceId` names no Tagihan at all — an id no screen ever rendered. The same named
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
export interface VoidInvoiceRequest {
	/** The signed-in superuser. Checked against `ACTION.correctDues` before anything else. */
	readonly actorId: string;
	readonly invoiceId: string;
	/** Why the Tagihan should never have stood. Required. */
	readonly reason: string;
}

/**
 * Cancels one Tagihan: `voidedAt`, `voidReason` and `voidedBy` filled together in one `update`,
 * the row never deleted, one audit row — or the named refusal that says why not.
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
	const reason = request.reason.trim();

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.correctDues);
		if (reason === '') {
			throw new VoidRuleError(
				VOID_RULE.reasonMissing,
				'Cancelling an invoice records why it should never have stood, so an empty reason is refused.'
			);
		}
		const actorResidentId = await requireActorResidentId(transaction, request.actorId);

		const invoice = await lockStandingInvoice(transaction, request.invoiceId);

		// A fresh statement under the invoice lock: every writer that could add a row here either
		// holds this same lock or is invisible until it commits — see this module's doc comment.
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

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: INVOICE_VOIDED_ACTION,
			targetId: invoice.id,
			before: { voidedAt: null },
			after: {
				// `unitId` is here so `./corrections-history.ts` can gather one Unit's corrections
				// with a single audit query — the released Alokasi has no surviving domain row, so
				// the audit log is the one read that covers all three actions the same way.
				unitId: invoice.unitId,
				period: invoice.period,
				amount: invoice.amount,
				reason
			}
		});

		return voided;
	});
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

/**
 * The `residents.id` behind the cancelling superuser, or the refusal that says there is none —
 * the same helper `./verification.ts` carries, copied because that module's exported surface is
 * #29's and this ticket only reads it.
 *
 * @throws {VoidRuleError} `actorNotRegistered`.
 */
async function requireActorResidentId(transaction: Transaction, actorId: string): Promise<string> {
	const [row] = await transaction
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, actorId))
		.limit(1);
	if (!row) {
		throw new VoidRuleError(
			VOID_RULE.actorNotRegistered,
			`User "${actorId}" has no residents row, and invoices.voidedBy references residents.id.`
		);
	}
	return row.id;
}
