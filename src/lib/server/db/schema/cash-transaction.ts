import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	date,
	index,
	pgTable,
	text,
	timestamp,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';
import { user } from './auth';
import { CASH_CATEGORY_TYPES, cashCategories, type CashCategoryType } from './cash-category';

/**
 * `cash_transactions`: the Transaksi Kas — one line of the complex's cash book, dated on the day
 * money actually moved. `docs/spec-kas-laporan-v1.md` makes this table append-only: no update, no
 * delete, and a mistake is fixed by a reversing row (a Koreksi) that points at what it corrects.
 *
 * Decisions settled here:
 *
 * - **Append-only is enforced as the absence of a path, plus every hold the database can add.**
 *   The spec is explicit that "tidak ada operasi ubah dan tidak ada operasi hapus di lapisan
 *   service" is tested as the absence of those operations, because no `CHECK` can forbid an
 *   `UPDATE`. What the schema does contribute: no foreign key in this file carries a cascade, so
 *   no deletion elsewhere can take a transaction with it; `correctionOf` is a self-referencing
 *   foreign key, so a transaction that has been corrected cannot be deleted without the database
 *   refusing; and `categoryId` with no `onDelete` means a category that has been used cannot be
 *   deleted at all.
 * - **`amount` refuses zero, not just negatives — stricter than every other money check in this
 *   schema.** `invoices`, `payments`, `dues_rates` and `allocations` all check `amount >= 0`; here
 *   the acceptance criteria says "menolak nilai nol dan negatif", and the reason holds on its own:
 *   a cash transaction *is* a movement of money, so a zero-rupiah row is a row that records
 *   nothing happening — where a zero-rupiah Tarif is merely a policy. Direction is carried by
 *   `type`, never by the sign of `amount`: with signed amounts a single flipped sign would
 *   silently invert a report, and the check would have to go.
 * - **`type` is stored on the row even though the category already has one, and nothing ties the
 *   two together.** A Koreksi is "Transaksi Kas bertipe berlawanan dengan nominal yang sama"
 *   (`docs/spec-kas-laporan-v1.md`) *in the same category*, so that per-category figures net out —
 *   which means `type = category.type` deliberately does not hold for correction rows, and a
 *   constraint demanding agreement would make corrections impossible. That ordinary rows agree
 *   with their category, and that a correction's type opposes and its amount equals the original's,
 *   are cross-row facts a `CHECK` cannot see; they are #34's service rules.
 * - **`correctionOf` is a nullable self-referencing foreign key — the glossary's "Koreksi:
 *   penanda pada `cash_transactions`".** Null for an ordinary row. The one row-local fact the
 *   database can state is stated: `cash_transactions_correction_self_check` refuses a row that
 *   claims to correct itself. Whether the original was already corrected once, and what the
 *   correction's reason is, are #34's questions.
 * - **`occurredOn` is a `date`, and it is not `createdAt`.** It is the day money actually changed
 *   hands — the acceptance criteria's "tanggal terima uang", which the spec widens to "diterima
 *   atau dikeluarkan" — and is routinely earlier than the day an admin typed the row, exactly like
 *   `payments.receivedOn`. Cash basis lives here: which Periode a transaction belongs to, and
 *   therefore whether a locked period must refuse it, is read off `occurredOn`, never `createdAt`.
 * - **Refusing a transaction dated inside a locked Periode is a service rule (#34), not a
 *   constraint.** Whether the period is locked is a fact about a row in `periods`, which a `CHECK`
 *   here cannot see, and reaching for a trigger would put the one rule with an explicit unlock
 *   escape hatch (user story 15) into the layer hardest to reason about. The same goes for
 *   "'Iuran warga' refuses manual entries": #29's payment verification is that category's only
 *   writer, which is a property of the service surface, not of a row.
 * - **`recordedBy` references `user.id`, not `residents.id`.** The orchestrator's landed decision,
 *   following `invitations.createdBy` and `audit_log.actorId`: who performed an action is an
 *   account, and an admin need not be a resident of the complex. No `onDelete` — who wrote a money
 *   row is attributed history.
 * - **`attachmentKey` is nullable text with no foreign key** — a `FileStore` key (see
 *   `src/lib/server/ports/file-store.ts`), the shape `posts.coverImageKey` and
 *   `payments.proofFileKey` use, opened through a short-lived signed link. One receipt photo per
 *   row; a gallery table like `complaint_attachments` would be capacity this spec never asks for.
 *   Nullable because the spec makes the receipt optional ("lampiran opsional"), while
 *   `description` is not: the criteria lists keterangan among the required facts.
 * - **Two single-column indexes.** The cash book is read in `occurredOn` order with running
 *   balance (user story 9) and filtered by period, which is a range over `occurredOn` (user story
 *   10); drill-down and filtering by category (user stories 10 and 20) read `categoryId`. The same
 *   reasoning as `posts`' single-column indexes: PostgreSQL combines them with a bitmap AND when a
 *   query filters on both, without committing to one guessed composite order.
 */

/** The SQL list of types, built from the one shared object so the two cannot drift apart. */
const TYPE_LIST = CASH_CATEGORY_TYPES.map((type) => `'${type}'`).join(', ');

export const cashTransactions = pgTable(
	'cash_transactions',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The day the money actually moved. Cash basis and period locking both read this. */
		occurredOn: date({ mode: 'string' }).notNull(),
		/** The direction of this row. Opposes the category's type exactly when this is a Koreksi. */
		type: text().$type<CashCategoryType>().notNull(),
		/** The Kategori Kas this row belongs to. */
		categoryId: uuid()
			.notNull()
			.references(() => cashCategories.id),
		/** How much money moved, in whole rupiah. Always positive; direction lives in `type`. */
		amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** What this money was for. Required — a cash book line with no story is unauditable. */
		description: text().notNull(),
		/** The `FileStore` key of the receipt photo. Null when there is none to attach. */
		attachmentKey: text(),
		/** The account that recorded the row — an admin, or #29's verification acting for one. */
		recordedBy: text()
			.notNull()
			.references(() => user.id),
		/** The transaction this row reverses, when this row is a Koreksi. Null for an ordinary row. */
		correctionOf: uuid().references((): AnyPgColumn => cashTransactions.id),
		/** When the row was typed in. The recording instant, not the money's date — see `occurredOn`. */
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// The cash book's reading order, and the range every period filter scans.
		index('cash_transactions_occurred_on_idx').on(table.occurredOn),
		// User story 20: open one category and see the transactions inside it.
		index('cash_transactions_category_id_idx').on(table.categoryId),
		// "Menolak nilai nol dan negatif" — strictly positive, unlike the >= 0 checks elsewhere.
		check('cash_transactions_amount_check', sql`amount > 0`),
		check('cash_transactions_type_check', sql.raw(`type in (${TYPE_LIST})`)),
		// The one row-local fact about corrections: nothing corrects itself.
		check(
			'cash_transactions_correction_self_check',
			sql`correction_of is null or correction_of <> id`
		)
	]
);

/** One row of `cash_transactions`: one line of the cash book. */
export type CashTransaction = typeof cashTransactions.$inferSelect;

/** A row on its way into `cash_transactions`. */
export type NewCashTransaction = typeof cashTransactions.$inferInsert;
