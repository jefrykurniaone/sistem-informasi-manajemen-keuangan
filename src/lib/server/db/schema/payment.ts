import { sql } from 'drizzle-orm';
import { bigint, check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';
import { residents } from './resident';
import { units } from './unit';

/**
 * `payments`: the Pembayaran — one deposit of money, with its proof and the decision made about it.
 * `docs/spec-iuran-v1.md:131-136` keeps this deliberately separate from `allocations`: a resident
 * hands over Rp300.000 for three months of which two have not been issued yet, so the money has to
 * have somewhere to sit before anything it pays for exists.
 *
 * Decisions settled here:
 *
 * - **`unitId`, not just `recordedBy`.** "Saldo titipan milik Unit, bukan orang"
 *   (`docs/spec-iuran-v1.md:138`) — the leftover of a payment belongs to the house, so the house is
 *   what the row names. `recordedBy` is a separate fact and is not a substitute for it: user story
 *   17 has an admin recording a cash payment on behalf of a resident who handed money over in
 *   person, so the person who typed the row is routinely not the person who lives there.
 * - **`recordedBy` references `residents.id`, like every other actor column in this schema.** It is
 *   the acceptance criteria's "pencatat". No `onDelete`, the same reasoning as
 *   `complaints.reporterId`: who entered a money row is attributed history.
 * - **`receivedOn` is a `date`, and it is not the same thing as `createdAt`.** It is the day the
 *   money actually changed hands, which is routinely earlier than the day anybody typed it in, and
 *   `docs/spec-iuran-v1.md:144-150` requires the cash transaction created at verification to be
 *   dated on it rather than on the verification. A calendar day, not an instant, the same choice
 *   `occupancies.startedOn` and `invoices.dueDate` make.
 * - **`method` and `status` are text with check constraints**, not PostgreSQL enums — the choice
 *   `registrations.status`, `occupancies.role`, `complaints.status` and `posts.status` all make,
 *   for the reason those files give: a check constraint is one plain migration away from changing,
 *   while an enum value can never be removed. The two value sets are the ones the orchestrator's
 *   glossary correction fixed in `CONTEXT.md`, not a choice made here.
 * - **`proofFileKey` is nullable text with no foreign key.** It is a `FileStore` key (see
 *   `src/lib/server/ports/file-store.ts`), the same shape `posts.coverImageKey` and
 *   `complaint_attachments.fileKey` use, opened only through a short-lived signed link per
 *   `docs/spec-iuran-v1.md:167-169` — "bukti transfer memuat nomor rekening dan nama pemiliknya",
 *   so nothing here stores a public URL. Nullable because user story 17's cash payment is money
 *   handed over in person: there is no transfer receipt to photograph, and a constraint tying proof
 *   to `method` would make the honest recording of that payment impossible. The spec's "pembayaran
 *   selalu punya bukti" is a rule about the resident-facing form, which is the layer that knows
 *   which of the two ways a payment arrived.
 * - **`payments_rejection_reason_check` follows `registrations_rejection_reason_check` and
 *   `complaints_rejection_reason_check` exactly** — a reason is forbidden unless the row was
 *   rejected, and is not required when it was. This is the third table in this schema with a
 *   `rejectionReason` hanging off a status that already stands on its own without it, and the two
 *   that came first both hand "must the admin type one" to the form. Note that this is *not* the
 *   shape `invoices_void_check` uses; `invoice.ts` sets out why that one is stricter, and the
 *   difference is that a void marker is three columns that mean nothing apart, while a rejection is
 *   explanation attached to a `status` that is already a complete fact.
 * - **`verifiedBy` and `verifiedAt` appear together or not at all, and only on a verified row.**
 *   This is stricter than `registrations`, which leaves `reviewedBy`/`reviewedAt` unconstrained,
 *   and the reason is what the columns are for: `registrations.reviewedBy` records either decision,
 *   while the acceptance criteria here names "pemverifikasi, dan waktu verifikasi" specifically.
 *   A pending payment displaying "verified by Budi at 10:00" is a lie told to a resident about
 *   their own money, and it is the one combination a `CHECK` can rule out outright. Who *rejected*
 *   a payment is not lost by leaving it out: `docs/spec-iuran-v1.md:171-172` routes verification
 *   and rejection alike into the audit log.
 *
 *   One ordering follows, and #28 has to know it: the verification does one `update` setting
 *   `status`, `verifiedBy` and `verifiedAt` together. Writing `verifiedAt` in a statement of its own
 *   and the status in a second is refused — which is the constraint doing its job, since between
 *   those two statements the row would claim a verification that had not been decided.
 * - **No marker for the payment a resident cancels before it is verified.** User story 13 asks for
 *   that action and `CONTEXT.md`'s value set has exactly three statuses, so a fourth one is a
 *   concept this ticket may not invent — the glossary is the authority and it says `pending`,
 *   `verified`, `rejected`. A pending payment has no allocations and no cash transaction pointing
 *   at it, so deleting the row is available to the ticket that builds that action; if it wants a
 *   marker instead, it needs a `CONTEXT.md` row first.
 * - **No `updatedAt`.** `verifiedAt` already answers "when was this decided", and `createdAt` never
 *   changes; a third timestamp would be a looser second answer to the same question.
 */

/**
 * How the money arrived. Set by the orchestrator's glossary correction on ticket #23 — see the
 * "kata yang bukan benda dan tidak punya tabel" table in `CONTEXT.md`.
 *
 * - `transfer`: a bank transfer, normally with a photographed receipt.
 * - `cash`: handed over in person and recorded by an admin.
 *
 * There is no third value: `docs/spec-iuran-v1.md`'s non-goals rule out a payment gateway.
 */
export const PAYMENT_METHOD = {
	transfer: 'transfer',
	cash: 'cash'
} as const;

/** How one Pembayaran arrived. */
export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

/** Every payment method there is, for a test — or a screen — that wants to walk them. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = Object.values(PAYMENT_METHOD);

/** The SQL list of methods, built from the one object above so the two cannot drift apart. */
const METHOD_LIST = PAYMENT_METHODS.map((method) => `'${method}'`).join(', ');

/**
 * What can be true of a Pembayaran. Set by the orchestrator's glossary correction on ticket #23.
 *
 * - `pending`: recorded, waiting for an admin to look at it. No money has reached the cash book.
 * - `verified`: accepted. `docs/spec-iuran-v1.md:144-150` makes this one transaction with the cash
 *   transaction and the allocations — all three happen or none do.
 * - `rejected`: turned down. `rejectionReason` says why.
 */
export const PAYMENT_STATUS = {
	pending: 'pending',
	verified: 'verified',
	rejected: 'rejected'
} as const;

/** The status of one Pembayaran. */
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/** Every payment status there is, for a test — or a screen — that wants to walk them. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.values(PAYMENT_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = PAYMENT_STATUSES.map((status) => `'${status}'`).join(', ');

export const payments = pgTable(
	'payments',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The house whose obligation and saldo titipan this money belongs to. */
		unitId: uuid()
			.notNull()
			.references(() => units.id),
		/** Who entered the row — the Warga paying, or an admin recording a cash payment for them. */
		recordedBy: uuid()
			.notNull()
			.references(() => residents.id),
		/** How much money changed hands, in whole rupiah. */
		amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** The day the money changed hands. The cash transaction created at verification uses it. */
		receivedOn: date({ mode: 'string' }).notNull(),
		method: text().$type<PaymentMethod>().notNull(),
		/** The `FileStore` key of the proof of transfer. Null when there is none to upload. */
		proofFileKey: text(),
		status: text().$type<PaymentStatus>().notNull(),
		/** Why the payment was turned down. Null unless it was. */
		rejectionReason: text(),
		/** The admin who verified it. Set exactly when `verifiedAt` is, and only once verified. */
		verifiedBy: uuid().references(() => residents.id),
		/** When it was verified. Set exactly when `verifiedBy` is, and only once verified. */
		verifiedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// A Unit's saldo titipan is the sum of its verified payments less its allocations, and
		// `docs/spec-iuran-v1.md` recomputes it on every read rather than storing it.
		index('payments_unit_id_idx').on(table.unitId),
		// The admin's verification queue: everything still waiting. Same read, and same single-column
		// index, as `complaints_status_idx`.
		index('payments_status_idx').on(table.status),
		check('payments_amount_check', sql`amount >= 0`),
		check('payments_method_check', sql.raw(`method in (${METHOD_LIST})`)),
		check('payments_status_check', sql.raw(`status in (${STATUS_LIST})`)),
		check(
			'payments_rejection_reason_check',
			sql.raw(`rejection_reason is null or status = '${PAYMENT_STATUS.rejected}'`)
		),
		// A verifier and a verification instant appear together, and only on a verified row.
		check(
			'payments_verification_check',
			sql.raw(
				`(verified_at is null and verified_by is null) or (verified_at is not null and verified_by is not null and status = '${PAYMENT_STATUS.verified}')`
			)
		)
	]
);

/** One row of `payments`: one Pembayaran. */
export type Payment = typeof payments.$inferSelect;

/** A row on its way into `payments`. */
export type NewPayment = typeof payments.$inferInsert;
