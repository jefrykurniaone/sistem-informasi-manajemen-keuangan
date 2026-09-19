import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import type { Rupiah } from '$lib/money';
import { recordAuditEntry } from '../../audit';
import type { DatabaseWriter, Transaction } from '../../authz';
import type { Database } from '../../db';
import { invoices } from '../../db/schema/invoice';
import {
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	type Payment,
	type PaymentStatus
} from '../../db/schema/payment';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import type { FileStore } from '../../ports/file-store';
import { occupiedUnitsForUser } from '../occupancy';
import {
	currentDay,
	isVisibleOn,
	unitVisibilityFor,
	type UnitVisibility
} from '../occupancy/visibility';
import { firstDayOfPeriod } from './invoice';

/**
 * A Warga telling the pengurus that they have transferred money: the amount, the day it left their
 * account, and a photograph of the transfer receipt. `docs/spec-iuran-v1.md` user stories 8 through
 * 11 and 13.
 *
 * ## The boundary this module exists to draw: recorded is not received
 *
 * Nothing here moves money. A Pembayaran written by this module is `pending`, and until an admin
 * verifies it there is **no Transaksi Kas and no Alokasi** — the spec's "sampai diverifikasi, belum
 * ada uang yang masuk ke kas mana pun". Three things follow, and each is an absence somebody could
 * mistake for an oversight:
 *
 * - **`requireOpenPeriodFor` is not called.** A Periode guards the day money is *written into the
 *   cash book*, and that day arrives at verification (#29), dated on `receivedOn`. Asking the
 *   question here would refuse a resident's honest record of a transfer they really made, on the
 *   grounds that a pengurus had closed the month's books — a refusal aimed at the wrong person.
 * - **No row is written into `allocations`.** Which Tagihan the money answers is decided by the
 *   verification transaction, not by the person paying.
 * - **The "Iuran warga" cash category is never touched.** `src/lib/server/services/cash/transaction.ts`
 *   refuses a manual entry into it precisely so that verification stays the only door.
 *
 * ## The payload handed to #29 — the contract, stated exactly
 *
 * When verification runs, **the `payments` row is the whole of what this ticket recorded**. Nothing
 * else exists anywhere that describes the payment. Concretely, #29 will find:
 *
 * | Column | What it holds when verification starts |
 * | --- | --- |
 * | `id` | minted here, and already part of `proofFileKey` |
 * | `unitId` | a house the payer was **living in on the day they recorded it** — `isStillRunningOn`'s definition, checked here and never again |
 * | `recordedBy` | the payer's `residents.id`. For a resident-recorded payment this is also the payer; an admin recording a cash payment for somebody else (user story 17) is a different flow |
 * | `amount` | strictly positive whole rupiah. Zero is refused here, not by the database — `payments_amount_check` permits it |
 * | `receivedOn` | a real calendar day, not later than tomorrow in UTC. **This is the day the cash transaction must be dated on**, never the day the row was typed. Bounded above only: see the note below |
 * | `method` | always `transfer`. A resident cannot record `cash`; that is user story 17's admin flow |
 * | `proofFileKey` | always non-null and always present in the `FileStore` — `payments/<id>/proof.<jpg\|png\|webp>`, whose extension was chosen from bytes this module verified |
 * | `status` | always `pending` |
 * | `rejectionReason`, `verifiedBy`, `verifiedAt` | always null |
 * | `createdAt` | the clock's instant when the row was written |
 *
 * And, just as precisely, **what is not there**:
 *
 * - **No record of which Tagihan the resident ticked.** The form has an invoice picker, and it
 *   fills the amount in for them; it stores nothing. There is nowhere for it to be stored. The only
 *   table that could hold "this payment is meant for that invoice" is `allocations`, and writing one
 *   is exactly what "no money has moved yet" forbids — an allocation is money answering an
 *   obligation, and `src/lib/server/db/schema/allocation.ts` derives both a Tagihan's status and a
 *   Unit's saldo titipan from those rows. A pending payment with allocations would make a Tagihan
 *   read as paid before anybody had checked that the money arrived. Storing the choice somewhere
 *   else needs a column or a table that does not exist, which is a migration, which is outside this
 *   ticket's surface.
 *
 *   So #29 allocates by the spec's own rule — "alokasi otomatis, tertua lebih dulu" — with the admin
 *   free to override it at verification, and the resident's ticking is what makes the amount land on
 *   the months they meant.
 * - **No Periode row, open or otherwise.** See above.
 * - **No email.** "Pembayaran diverifikasi" is the notification the spec names, and verification is
 *   where it is sent from.
 * - **No lower bound on `receivedOn`, and that is a decision rather than an omission.** The day is
 *   refused when it has not arrived (see `assertReceiptDay`) and never for being old. Every floor
 *   that suggested itself is wrong for a case that really happens: "not before the payer moved in"
 *   refuses somebody who transfers the first month before they collect the keys, and a fixed system
 *   start day is a policy number `docs/spec-iuran-v1.md` does not give. So a mistyped year reaches
 *   #29 as an old `receivedOn`, where it meets the Periode check that dates the cash transaction —
 *   which is the layer that already has to answer "this month's books are closed" and is therefore
 *   the right place for it to be caught.
 *
 * Two orderings #29 has to keep, both of them consequences of rows this module leaves behind:
 *
 * 1. `payments_verification_check` means `status`, `verifiedBy` and `verifiedAt` move in **one**
 *    `update`. `src/lib/server/db/schema/payment.ts` spells this out.
 * 2. `cancelOwnPayment` below takes `for update` on the row before it reads its status.
 *    Verification must take the same lock, or a resident pressing "batalkan" in the same instant an
 *    admin presses "verifikasi" can delete a row that a cash transaction is about to point at.
 *
 * ## Cancelling: the row is deleted, and there is no fourth status
 *
 * `CONTEXT.md` lists exactly three Pembayaran statuses — `pending`, `verified`, `rejected` — so a
 * `cancelled` marker would be a concept this ticket invented, and `src/lib/server/db/schema/payment.ts`
 * reaches the same conclusion from the table's side. A `pending` row has no allocations and no cash
 * transaction pointing at it, so deleting it restores the state exactly; the audit entry written
 * immediately before the delete is what keeps the fact that it happened. `audit_log.targetId` is
 * plain `text` with no foreign key, so that entry outlives the row it names.
 *
 * ## Permission is row ownership, and it is not an `ACTION`
 *
 * "Only their own payment", and "only a house they live in", are not rights some residents hold and
 * others do not, so neither is an entry in `PERMISSIONS`. They are guarded the way
 * `src/lib/server/services/resident/profile.ts` and `occupiedUnitsForUser` settled: the row is
 * checked against the running session and refused with `PermissionDeniedError`, the same class
 * `requirePermission` throws, so a route answers it with `error(403, …)` without knowing the
 * difference. Nothing here reads or writes `src/lib/server/authz.ts`.
 *
 * A payment id that names no row is refused with the same `PermissionDeniedError` as one belonging
 * to somebody else. Telling the two apart would turn this into an oracle for whether a given id is
 * a real payment.
 */

/** The audit log's `action` for a Pembayaran a resident recorded. */
export const PAYMENT_RECORDED_ACTION = 'payment_recorded';

/** The audit log's `action` for a pending Pembayaran its payer withdrew. */
export const PAYMENT_CANCELLED_ACTION = 'payment_cancelled';

/**
 * The largest proof photo this application accepts: 5 MiB.
 *
 * The figure is derived from `BODY_SIZE_LIMIT=16M`, which #98 sets in the deployment environment in
 * the same wave as this ticket and on another branch. This constant is written here rather than
 * imported or copied from that branch's files: a limit the service enforces has to be readable in
 * the service, and the two numbers answer different questions — the body limit covers the whole
 * multipart envelope for any request, while this covers one image.
 *
 * Five MiB is what an unedited photograph off a mid-range phone camera actually weighs, which is the
 * file a resident will reach for, and it leaves the envelope three times the room it needs. It is
 * deliberately far above `MAXIMUM_COVER_IMAGE_BYTES` (256 KiB) in
 * `src/lib/server/services/post/index.ts`: that one is an admin exporting a share card from a
 * machine, this one is a warga photographing a bank receipt in a hurry.
 *
 * `vite dev` enforces no body limit at all, so nothing about this changes between developing and
 * production except which of the two refusals a very large upload meets first.
 */
export const MAXIMUM_PROOF_BYTES = 5 * 1024 * 1024;

/** Bytes in a mebibyte, so the limit can also be stated in the unit a person reads. */
const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * `MAXIMUM_PROOF_BYTES` in the unit the messages state it in.
 *
 * Exported so that the sentence a resident reads interpolates the same constant the service
 * enforces. Writing "5 MB" into the message catalogues instead would leave both of them lying the
 * first time the limit moved.
 */
export const MAXIMUM_PROOF_MEBIBYTES = MAXIMUM_PROOF_BYTES / BYTES_PER_MEBIBYTE;

/**
 * The image formats a proof may be in, and the file extension each is stored under.
 *
 * The extension comes from here, never from the uploaded file's name: that name arrives from a
 * browser and would become part of a storage key, and a storage key is a path.
 *
 * ## A `Map`, deliberately not an object literal
 *
 * `contentType` is `File.type` read off a multipart form, so it is a claim under the sender's
 * control exactly as the bytes are. Looked up in an object literal, `'constructor'` answers with
 * `Object` and `'__proto__'` with `Object.prototype` — both truthy, so both sail past the
 * `if (!extension)` guard below and past the `?? []` in `hasSignatureOf`, and the second of those
 * then throws `TypeError: signature.every is not a function`: a 500 where this module's contract
 * says a named `proofNotAnImage` refusal, reachable from a forged upload. `Map.get` has no prototype
 * chain behind it. **Do not turn either of these two maps back into an object literal**;
 * `tests/unit/payment-proof.test.ts` holds the refusal for those names.
 *
 * The three extensions are all already served with an image `Content-Type` by
 * `src/routes/files/[...key]/+server.ts`, which is the one route that serves a stored file.
 */
const PROOF_EXTENSIONS: ReadonlyMap<string, string> = new Map([
	['image/jpeg', 'jpg'],
	['image/png', 'png'],
	['image/webp', 'webp']
]);

/** Every content type a proof may be uploaded as, for a screen that builds an `accept` list. */
export const PROOF_CONTENT_TYPES: readonly string[] = [...PROOF_EXTENSIONS.keys()];

/** Where a magic-number check looks in a file, and the bytes it expects to find there. */
interface ByteSignature {
	readonly offset: number;
	readonly bytes: readonly number[];
}

/**
 * How a file of each accepted type really begins.
 *
 * The content type on an upload is whatever the sender chose to put there, so it is a claim rather
 * than a fact, and a proof of transfer is read back by an admin through a link this application
 * hands out. A file that is not an image but says it is one is the shape of an upload that becomes a
 * script the moment anything downstream sniffs its bytes instead of believing the extension.
 * `WEBP` is checked at offset 8, after the `RIFF` container header and the four-byte length.
 *
 * A `Map` for the reason `PROOF_EXTENSIONS` is one, and the two have to agree: a content type that
 * got an extension but no signature would be accepted unchecked, because `every` over an empty list
 * is `true`.
 *
 * A near-copy of `RECEIPT_SIGNATURES` in `src/lib/server/services/cash/transaction.ts` and of
 * `COVER_IMAGE_SIGNATURES` in `src/lib/server/services/post/index.ts`, and deliberately a copy for
 * the reason the first of those records: importing one spec's accepted formats into another makes
 * each free to change only in lockstep with a neighbour it has nothing to do with.
 */
const PROOF_SIGNATURES: ReadonlyMap<string, readonly ByteSignature[]> = new Map<
	string,
	readonly ByteSignature[]
>([
	['image/jpeg', [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
	['image/png', [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
	[
		'image/webp',
		[
			{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
			{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }
		]
	]
]);

/** The shape `receivedOn` has to arrive in: a calendar day, as PostgreSQL's `date` writes one. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** How many characters that shape has, which is also where an ISO instant's day part ends. */
const DAY_LENGTH = 10;

/** Milliseconds in a day, for working out the latest `receivedOn` this module will accept. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The pseudo-action name carried by the refusal a caller gets for a house they do not live in.
 *
 * It is a string on the error, never an entry in `ACTION`: see this module's doc comment.
 */
const RECORD_FOR_OCCUPIED_UNIT = 'payments.recordForOccupiedUnit';

/** The pseudo-action name carried by the refusal a caller gets for somebody else's payment. */
const CANCEL_OWN_PAYMENT = 'payments.cancelOwnPayment';

/**
 * Every rule this service refuses a request for, other than permission.
 *
 * These are named refusals of a specific request, not of the caller: the resident was inside their
 * rights and the request itself is what is wrong, so a route answers them with `fail(400, …)` rather
 * than with a 403 — the split `CASH_RULE` and `POST_RULE` already draw. A route maps every one of
 * them through an exhaustive `Record`, so a rule added later is a type error at each screen until
 * somebody writes the sentence a resident reads.
 */
export const PAYMENT_RULE = {
	/** The amount is zero or negative. A payment is a movement of money. */
	amountNotPositive: 'amountNotPositive',
	/** The date is not a real calendar day written as `YYYY-MM-DD`. */
	notACalendarDay: 'notACalendarDay',
	/** The money is claimed to have changed hands on a day that has not arrived. */
	receivedInTheFuture: 'receivedInTheFuture',
	/** No proof was attached. A transfer a resident records always carries one. */
	proofMissing: 'proofMissing',
	/** The uploaded proof is larger than `MAXIMUM_PROOF_BYTES`. */
	proofTooLarge: 'proofTooLarge',
	/** The uploaded proof is not one of the accepted image formats. */
	proofNotAnImage: 'proofNotAnImage',
	/** The payment has already been verified or rejected, so it is no longer the payer's to withdraw. */
	alreadyDecided: 'alreadyDecided'
} as const;

/** One of the rules above. */
export type PaymentRule = (typeof PAYMENT_RULE)[keyof typeof PAYMENT_RULE];

/**
 * Thrown when this service refuses a request by one of the rules in `PAYMENT_RULE`.
 *
 * Named and `instanceof`-checkable for the reason `PermissionDeniedError` is: a route tells this
 * apart from "something broke" by catching the class and reading `rule`, never by matching a
 * message. It lives here rather than in `src/lib/errors.ts` because that file is outside this
 * ticket's surface — the same note `CashRuleError` carries.
 */
export class PaymentRuleError extends Error {
	override readonly name = 'PaymentRuleError';

	/** Which rule refused the request. */
	readonly rule: PaymentRule;

	constructor(rule: PaymentRule, detail: string) {
		super(`A Pembayaran request was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** A proof photo on its way in, as a route reads it off a multipart form. */
export interface PaymentProofUpload {
	/** What the upload claims the file is. Checked against the bytes, not believed. */
	readonly contentType: string;
	readonly content: Uint8Array;
}

/** Who is paying, for which house, how much, and the proof of it. */
export interface RecordPaymentRequest {
	/** The signed-in account. Checked against the houses it is living in before anything else. */
	readonly actorUserId: string;
	/** The house the money is for. Must be one the actor is living in today. */
	readonly unitId: string;
	/** How much changed hands, in whole rupiah. Strictly positive. */
	readonly amount: Rupiah;
	/** The day the money left the payer's account, as `YYYY-MM-DD`. Not the day this row is typed. */
	readonly receivedOn: string;
	/** The photograph of the transfer receipt. Required — see this module's doc comment. */
	readonly proof: PaymentProofUpload;
}

/** One house the signed-in resident may record a payment for, with the Tagihan it carries. */
export interface PayableUnit {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	/**
	 * Its Tagihan that have not been cancelled **and that were issued inside the viewer's own Masa
	 * Huni**, oldest period first. See `payableInvoicesOf` for why the second half is a privacy rule
	 * rather than a convenience.
	 */
	readonly invoices: readonly PayableInvoice[];
}

/**
 * One Tagihan the payment form offers.
 *
 * There is no "lunas", "sebagian" or "menunggak" on it, and there must not be: working out what a
 * Tagihan still owes is #27's job, and a second counter living here would be a second answer to a
 * question `docs/spec-iuran-v1.md` says has exactly one ("status tagihan dihitung, bukan disimpan").
 */
export interface PayableInvoice {
	readonly invoiceId: string;
	/** The calendar month it is for, as `YYYY-MM`. */
	readonly period: string;
	readonly amount: Rupiah;
	/** The day it falls due, as `YYYY-MM-DD`. */
	readonly dueDate: string;
}

/** One of the signed-in resident's own payments, as their list screen shows it. */
export interface OwnPayment {
	readonly paymentId: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly amount: Rupiah;
	readonly receivedOn: string;
	readonly status: PaymentStatus;
	/** Why it was turned down. Null unless it was. */
	readonly rejectionReason: string | null;
	/**
	 * The `FileStore` key of the proof. The key, never a URL: a signed link is minted by the page
	 * that renders it, so that it is a few minutes old when a resident clicks it rather than as old
	 * as the query that built the list.
	 */
	readonly proofFileKey: string | null;
	readonly recordedAt: Date;
	/** Whether the payer may still withdraw it — true exactly while it is `pending`. */
	readonly canCancel: boolean;
}

/** Who is withdrawing, and which payment of theirs. */
export interface CancelPaymentRequest {
	/** The signed-in account. Checked against the payment's `recordedBy` before anything else. */
	readonly actorUserId: string;
	readonly paymentId: string;
}

/**
 * Every house `actorUserId` is living in today, each with the Tagihan a payment could be meant for
 * — the whole load of the "catat pembayaran" screen.
 *
 * **Which Tagihan those are is a privacy decision, not a convenience one.** Only the ones issued
 * inside this viewer's own Masa Huni are offered: a Tagihan from before they moved in is the
 * previous occupant's obligation, and listing it would disclose its period and its amount. The rule
 * and the reason are in `payableInvoicesOf` below.
 *
 * "Living in today" is `isStillRunningOn`'s definition and is not re-derived here: this reads
 * `occupiedUnitsForUser` and keeps the stays it reports as running. An account with no `residents`
 * row, or one whose stays have all ended, gets an empty list rather than an error — the screen says
 * so, which is a different thing from refusing them.
 *
 * **One entry per house, not per stay.** `occupiedUnitsForUser` answers with occupancies, and
 * `src/lib/server/db/schema/occupancy.ts` deliberately has no unique pair on unit and resident:
 * the same person can hold two running stays in one house, an owner row beside a tenant row or a
 * plain duplicate a superuser recorded. Two rows for one house would put a duplicate key into the
 * form's `{#each}` and list every Tagihan of that house twice, so the stays are folded by `unitId`
 * here rather than left for each screen to notice.
 */
export async function payableUnitsForUser(
	db: DatabaseWriter,
	clock: Clock,
	actorUserId: string
): Promise<readonly PayableUnit[]> {
	const houses = new Map<string, { readonly block: string; readonly number: string }>();
	for (const stay of await occupiedUnitsForUser(db, clock, actorUserId)) {
		if (stay.isRunning) {
			houses.set(stay.unitId, { block: stay.block, number: stay.number });
		}
	}
	if (houses.size === 0) {
		return [];
	}

	const invoicesByUnit = await payableInvoicesOf(db, actorUserId, [...houses.keys()]);

	return [...houses].map(([unitId, house]) => ({
		unitId,
		block: house.block,
		number: house.number,
		invoices: invoicesByUnit.get(unitId) ?? []
	}));
}

/**
 * Every payment `actorUserId` recorded, newest first — user story 11, "status pembayaran saya …
 * beserta alasannya".
 *
 * Keyed by the caller's own account and by nothing else, so there is no id a caller could swap for
 * somebody else's. A payment an admin recorded on a resident's behalf belongs to that admin's
 * `recordedBy` and is not on this list; what a resident is shown about their house's obligations is
 * #27's screen.
 */
export async function ownPayments(
	db: DatabaseWriter,
	actorUserId: string
): Promise<readonly OwnPayment[]> {
	const rows = await db
		.select({
			paymentId: payments.id,
			unitId: payments.unitId,
			block: units.block,
			number: units.number,
			amount: payments.amount,
			receivedOn: payments.receivedOn,
			status: payments.status,
			rejectionReason: payments.rejectionReason,
			proofFileKey: payments.proofFileKey,
			recordedAt: payments.createdAt
		})
		.from(payments)
		.innerJoin(residents, eq(residents.id, payments.recordedBy))
		.innerJoin(units, eq(units.id, payments.unitId))
		.where(eq(residents.userId, actorUserId))
		// `id` breaks the tie so that two payments recorded in the same instant keep one order.
		.orderBy(desc(payments.createdAt), desc(payments.id));

	return rows.map((row) => ({ ...row, canCancel: row.status === PAYMENT_STATUS.pending }));
}

/**
 * Records one Pembayaran, `pending`, with its proof stored through the `FileStore` port. No cash
 * transaction and no allocation are created — see this module's doc comment for why that is the
 * whole point of it.
 *
 * @throws {PermissionDeniedError} when `actorUserId` has no `residents` row, or is not living in
 *   `unitId` today.
 * @throws {PaymentRuleError} `amountNotPositive` for zero or less, `notACalendarDay` for a date that
 *   is not one, `receivedInTheFuture` for a day that has not arrived, and `proofMissing`,
 *   `proofTooLarge` or `proofNotAnImage` for the photograph.
 */
export async function recordPayment(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	request: RecordPaymentRequest
): Promise<Payment> {
	// Minted here rather than left to the column default so that the proof's storage key can be
	// derived from the row's own id *before* the row exists. That is what lets `proofFileKey` be
	// written on the insert instead of by an update afterwards — the move
	// `recordCashTransaction` makes, for the same reason.
	const id = randomUUID();

	return db.transaction(async (transaction) => {
		const residentId = await requireOccupyingResident(
			transaction,
			clock,
			request.actorUserId,
			request.unitId
		);

		assertPositiveAmount(request.amount);
		assertReceiptDay(request.receivedOn, clock);
		const key = proofKeyFor(id, request.proof);

		// Stored inside the transaction, after every check and immediately before the insert — the
		// order `recordCashTransaction` settled and for its reasons. Storing before the checks would
		// write a file for a request about to be refused, and storing after the commit would leave a
		// committed row pointing at a file that is not there yet. What this order can leave behind is
		// an unreferenced blob, when the insert or the audit row fails after the upload succeeded:
		// nobody can reach it, because the only key that names it is on a row that was rolled back.
		await fileStore.store(key, request.proof.content);

		const [row] = await transaction
			.insert(payments)
			.values({
				id,
				unitId: request.unitId,
				recordedBy: residentId,
				amount: request.amount,
				receivedOn: request.receivedOn,
				// Always a transfer. A resident has nobody to hand cash to through a web form; user
				// story 17's tunai is an admin recording a deposit made in person.
				method: PAYMENT_METHOD.transfer,
				proofFileKey: key,
				status: PAYMENT_STATUS.pending,
				rejectionReason: null,
				verifiedBy: null,
				verifiedAt: null,
				createdAt: clock.now()
			})
			.returning();

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorUserId,
			action: PAYMENT_RECORDED_ACTION,
			targetId: row.id,
			after: {
				unitId: row.unitId,
				amount: row.amount,
				receivedOn: row.receivedOn,
				method: row.method,
				status: row.status
			}
		});

		return row;
	});
}

/**
 * Withdraws a payment the caller recorded and nobody has decided on yet: the row is deleted, and an
 * audit entry written first is what remains of it.
 *
 * The row is locked with `for update` before its status is read, so that a cancellation arriving in
 * the same instant as a verification is serialised behind it and then refused by `alreadyDecided`
 * rather than deleting a row the verification is about to point a cash transaction at. #29 has to
 * take the same lock; see this module's doc comment.
 *
 * The stored proof is deleted after the transaction commits, never inside it: a delete that ran
 * first would destroy the file of a payment that then stayed, because the transaction rolled back.
 * The cost of this order is at worst an unreferenced blob nobody can reach, and
 * `FileStore.delete` treats a key that is already gone as success.
 *
 * @returns the row as it was immediately before it was deleted.
 * @throws {PermissionDeniedError} when `paymentId` names no payment, or one the caller did not
 *   record. The two are deliberately indistinguishable.
 * @throws {PaymentRuleError} `alreadyDecided` when it has been verified or rejected.
 */
export async function cancelOwnPayment(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	request: CancelPaymentRequest
): Promise<Payment> {
	const cancelled = await db.transaction(async (transaction) => {
		const [existing] = await transaction
			.select()
			.from(payments)
			.where(eq(payments.id, request.paymentId))
			.limit(1)
			.for('update');

		const residentId = await residentIdOf(transaction, request.actorUserId);
		if (!existing || !residentId || existing.recordedBy !== residentId) {
			throw new PermissionDeniedError(request.actorUserId, CANCEL_OWN_PAYMENT);
		}
		if (existing.status !== PAYMENT_STATUS.pending) {
			throw new PaymentRuleError(
				PAYMENT_RULE.alreadyDecided,
				`Payment "${existing.id}" is "${existing.status}", and only a pending payment is still its payer's to withdraw.`
			);
		}

		// Written before the delete, because it is the only trace that will be left. `audit_log`
		// carries no foreign key to the row it names, so the entry survives it.
		await recordAuditEntry(transaction, clock, {
			actorId: request.actorUserId,
			action: PAYMENT_CANCELLED_ACTION,
			targetId: existing.id,
			before: {
				unitId: existing.unitId,
				amount: existing.amount,
				receivedOn: existing.receivedOn,
				method: existing.method,
				status: existing.status,
				proofFileKey: existing.proofFileKey
			}
		});

		await transaction.delete(payments).where(eq(payments.id, existing.id));

		return existing;
	});

	if (cancelled.proofFileKey) {
		try {
			await fileStore.delete(cancelled.proofFileKey);
		} catch {
			// The withdrawal has already committed and the row is gone, so there is nothing left to
			// retry: answering the resident with an error would report a failure for something that
			// succeeded, and a second attempt would be refused because the payment no longer exists.
			// A file the store would not remove is an unreferenced blob, which is the same cost as the
			// orphan `recordPayment` can leave, and the audit entry still records the withdrawal.
			// Swallowed rather than logged because this repository has no logger — the same note
			// `src/routes/files/[...key]/+server.ts` makes about its own refusals.
		}
	}
	return cancelled;
}

/**
 * The `residents.id` behind `actorUserId`, having proved they are living in `unitId` today.
 *
 * @throws {PermissionDeniedError} when the account has no `residents` row, or no running stay in
 *   that house. Both are the same answer on purpose: "that is not your house" is all either one
 *   entitles the caller to know.
 */
async function requireOccupyingResident(
	transaction: Transaction,
	clock: Clock,
	actorUserId: string,
	unitId: string
): Promise<string> {
	const residentId = await residentIdOf(transaction, actorUserId);
	const stays = await occupiedUnitsForUser(transaction, clock, actorUserId);
	const occupies = stays.some((stay) => stay.isRunning && stay.unitId === unitId);
	if (!residentId || !occupies) {
		throw new PermissionDeniedError(actorUserId, RECORD_FOR_OCCUPIED_UNIT);
	}
	return residentId;
}

/** The `residents` row behind a signed-in account, or `undefined` when it has none yet. */
async function residentIdOf(
	writer: DatabaseWriter,
	actorUserId: string
): Promise<string | undefined> {
	const [row] = await writer
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, actorUserId))
		.limit(1);
	return row?.id;
}

/**
 * Every Tagihan of these units that `viewerUserId` may see and could still pay, oldest period first.
 *
 * ## The occupancy range is a privacy rule, and this is the second screen that has to obey it
 *
 * `docs/spec-iuran-v1.md` says "Warga hanya melihat tagihan yang terbit dalam rentang masa huninya",
 * and a Tagihan carries the period and the amount a *previous* occupant owed. Filtering only on
 * `unitId` would hand the payment form that row and disclose all three facts about somebody else's
 * debt, so this screen applies the same rule the Tagihan list applies, from the same contract rather
 * than from a second derivation of it:
 *
 * - `unitVisibilityFor` in `src/lib/server/services/occupancy/visibility.ts` answers what days this
 *   viewer may see of one house, and `isVisibleOn` decides one day against that answer. Its two
 *   cases are the whole vocabulary: `{ kind: 'all' }` for a caller holding `ACTION.manageOccupancies`
 *   and otherwise the days their own stays cover — where an **empty `ranges` means "sees nothing"**
 *   and never "no restriction". `isVisibleOn` answers `false` for every day of an empty `ranges`, so
 *   the safe reading is the one that falls out of the contract; a unit with no visibility answer at
 *   all is skipped for the same reason.
 * - `firstDayOfPeriod` in `./invoice.ts` is the day a Tagihan is issued on, and it is a pure function
 *   of the period. The Tagihan list compares the same day against the same ranges, so the two screens
 *   cannot come to different conclusions about one row.
 *
 * The visibility question is asked once per house rather than once per Tagihan, and there is one
 * house in the ordinary case.
 */
async function payableInvoicesOf(
	db: DatabaseWriter,
	viewerUserId: string,
	unitIds: readonly string[]
): Promise<ReadonlyMap<string, readonly PayableInvoice[]>> {
	const byUnit = new Map<string, PayableInvoice[]>();
	if (unitIds.length === 0) {
		return byUnit;
	}

	const visibilities = new Map<string, UnitVisibility>();
	for (const unitId of unitIds) {
		visibilities.set(unitId, await unitVisibilityFor(db, { viewerUserId, unitId }));
	}

	const rows = await db
		.select({
			unitId: invoices.unitId,
			invoiceId: invoices.id,
			period: invoices.period,
			amount: invoices.amount,
			dueDate: invoices.dueDate
		})
		.from(invoices)
		// A cancelled Tagihan is not an obligation any more, so it is not something to pay. This is
		// not a paid-or-unpaid calculation — that one is #27's, and there is none here.
		.where(and(inArray(invoices.unitId, unitIds), isNull(invoices.voidedAt)))
		.orderBy(asc(invoices.period));

	for (const { unitId, ...invoice } of rows) {
		const visibility = visibilities.get(unitId);
		if (!visibility || !isVisibleOn(visibility, firstDayOfPeriod(invoice.period))) {
			continue;
		}
		const existing = byUnit.get(unitId);
		if (existing) {
			existing.push(invoice);
			continue;
		}
		byUnit.set(unitId, [invoice]);
	}
	return byUnit;
}

/**
 * Refuses an amount `payments_amount_check` would let through.
 *
 * The constraint is `amount >= 0`, so zero reaches the database happily; the acceptance criterion
 * asks for zero and negative both to be refused at this layer, and this is that layer.
 */
function assertPositiveAmount(amount: Rupiah): void {
	if (amount <= 0) {
		throw new PaymentRuleError(
			PAYMENT_RULE.amountNotPositive,
			`A payment is a movement of money, so its amount is strictly positive, not ${amount}.`
		);
	}
}

/**
 * Refuses a `receivedOn` that is not a real calendar day, or one that has not arrived.
 *
 * The round trip through `Date` is what makes "real" true: `new Date('2026-02-31')` does not fail,
 * it rolls over to 3 March, so a day that does not exist would otherwise reach PostgreSQL and come
 * back as a driver error nobody named. The same check `recordCashTransaction` makes, copied rather
 * than shared because that module's exported surface is pinned by a test.
 *
 * **Tomorrow is allowed, today is not the bound.** `currentDay` reads the clock as a *UTC* day and
 * says why; the complex is at UTC+7, so between midnight and 07:00 local the UTC day is still
 * yesterday. Refusing anything after the UTC day would tell a resident transferring money at one in
 * the morning that the day they were standing in had not happened. One day of slack costs nothing —
 * the far side of this rule is a typo like `2126-03-04`, not a payment dated a few hours early.
 */
function assertReceiptDay(day: string, clock: Clock): void {
	const parsed = new Date(`${day}T00:00:00.000Z`);
	if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime())) {
		throw new PaymentRuleError(
			PAYMENT_RULE.notACalendarDay,
			`"${day}" is not a calendar day written as YYYY-MM-DD.`
		);
	}
	if (parsed.toISOString().slice(0, DAY_LENGTH) !== day) {
		throw new PaymentRuleError(
			PAYMENT_RULE.notACalendarDay,
			`"${day}" is not a day that exists on the calendar.`
		);
	}

	const latest = new Date(Date.parse(`${currentDay(clock)}T00:00:00.000Z`) + MILLISECONDS_PER_DAY)
		.toISOString()
		.slice(0, DAY_LENGTH);
	// ISO days compare correctly as plain strings, which is why no date arithmetic happens here.
	if (day > latest) {
		throw new PaymentRuleError(
			PAYMENT_RULE.receivedInTheFuture,
			`"${day}" has not arrived; the latest day money can already have changed hands is ${latest}.`
		);
	}
}

/**
 * Checks an uploaded proof and works out the storage key it belongs at:
 * `payments/<paymentId>/proof.<ext>`, the convention `src/lib/server/ports/file-store.ts` names.
 *
 * @throws {PaymentRuleError} `proofMissing`, `proofTooLarge` or `proofNotAnImage`.
 */
function proofKeyFor(paymentId: string, proof: PaymentProofUpload): string {
	if (proof.content.byteLength === 0) {
		throw new PaymentRuleError(
			PAYMENT_RULE.proofMissing,
			'A transfer a resident records carries a photograph of its receipt; no bytes were uploaded.'
		);
	}
	if (proof.content.byteLength > MAXIMUM_PROOF_BYTES) {
		throw new PaymentRuleError(
			PAYMENT_RULE.proofTooLarge,
			`The uploaded proof is ${proof.content.byteLength} bytes; the limit is ${MAXIMUM_PROOF_BYTES}.`
		);
	}

	const extension = PROOF_EXTENSIONS.get(proof.contentType);
	if (!extension) {
		throw new PaymentRuleError(
			PAYMENT_RULE.proofNotAnImage,
			`"${proof.contentType}" is not one of ${PROOF_CONTENT_TYPES.join(', ')}.`
		);
	}
	if (!hasSignatureOf(proof.content, proof.contentType)) {
		throw new PaymentRuleError(
			PAYMENT_RULE.proofNotAnImage,
			`The uploaded bytes do not start the way a "${proof.contentType}" file starts.`
		);
	}

	return `payments/${paymentId}/proof.${extension}`;
}

/** Whether `content` really begins the way a file of `contentType` begins. */
function hasSignatureOf(content: Uint8Array, contentType: string): boolean {
	const signature = PROOF_SIGNATURES.get(contentType) ?? [];
	return signature.every((part) =>
		part.bytes.every((byte, index) => content[part.offset + index] === byte)
	);
}
