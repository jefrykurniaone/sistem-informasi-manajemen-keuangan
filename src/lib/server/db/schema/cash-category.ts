import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * `cash_categories`: the Kategori Kas — the classification of one Transaksi Kas, typed masuk
 * (`income`) or keluar (`expense`). Master data managed by a superuser, with two rows that are not:
 * the system categories "Iuran warga" and "Saldo awal", which the migration itself seeds.
 *
 * Decisions settled here:
 *
 * - **`type` is text with a check constraint, not a PostgreSQL enum**, the choice
 *   `payments.method`, `posts.type` and `occupancies.role` all make, for the reason those files
 *   give: a check constraint is one plain migration away from changing, while an enum value can
 *   never be removed. The two values are the glossary's ("tipe Kategori Kas masuk dan keluar" in
 *   `CONTEXT.md`), set by the orchestrator's wave-11 correction, not chosen here.
 * - **`systemKey` is a nullable free-text key, unique when present — not an enum and not a
 *   boolean flag.** It follows `email_queue.kind` and `subscriptions.kind`: kebab-case, known to
 *   the code that needs it, unconstrained by the database. The reason it exists at all: #29
 *   (payment verification) and #33 (opening balance) must find their system category without
 *   depending on the display name, which a superuser may rename — "Iuran warga" and "Saldo awal"
 *   are data, like a Post's category, and stay Indonesian. A boolean `isSystem` could not tell the
 *   two system categories apart; the key can, and `SYSTEM_CATEGORY_KEY` below is the registry of
 *   the values that exist. The unique index needs no `WHERE` clause: PostgreSQL's default
 *   `NULLS DISTINCT` already lets every ordinary category carry null at once while refusing two
 *   rows claiming the same key.
 * - **The two system rows are seeded by the migration (`drizzle/0009_cash_report.sql`), never by
 *   application startup code.** The acceptance criteria demands it, and the reason is the same as
 *   for every other schema fact in this directory: a row the application inserts "if missing" at
 *   boot is a fact with no single owner — every deployment races to create it, a test database has
 *   it or not depending on what booted first, and nothing proves it exists before the first
 *   request needs it. A migration runs exactly once, in order, everywhere.
 * - **What the database does not enforce, deliberately.** `docs/spec-kas-laporan-v1.md` demands
 *   that a system category cannot be deleted, cannot change type, and — for "Iuran warga" — never
 *   accepts a manual entry (its only writer is #29's payment verification). All three are rules
 *   about an *operation*, not about the shape of one row, and a `CHECK` sees only its own row; they
 *   belong to the service layer (#33, #34, #35), and the tests there assert them as the absence of
 *   a path. What the schema does contribute: `cash_transactions.categoryId` carries no `onDelete`,
 *   so any category that has ever been used cannot be deleted no matter what the service forgets.
 * - **`isActive` with a database default of `true`, exactly like `units.isActive`.** User story 2:
 *   a category that is no longer used is deactivated, never deleted, so old transactions keep
 *   their category. Deactivation hides it from the recording form (a service concern); it does not
 *   stop old rows pointing here.
 * - **`name` is unique across both types.** The acceptance criteria says "nama unik" without
 *   scoping it per type, and two categories called "Perbaikan" where one is income would be a trap
 *   for the admin picking from a list anyway.
 * - **`createdAt` has no database default**, like every domain table here: the service writes it
 *   through the injected `Clock`, so tests decide what time it is. The migration's seed rows use
 *   `now()` because the migration itself is their recorder.
 */

/**
 * The two directions money can move. Set by the orchestrator's glossary correction on this ticket
 * — see the "kata yang bukan benda dan tidak punya tabel" table in `CONTEXT.md`.
 *
 * - `income`: money coming in (masuk).
 * - `expense`: money going out (keluar).
 *
 * `cash_transactions.type` uses the same two values: a transaction's direction and its category's
 * type are the same concept, and a Koreksi is precisely a transaction whose direction opposes its
 * category's type. See `cash-transaction.ts`.
 */
export const CASH_CATEGORY_TYPE = {
	income: 'income',
	expense: 'expense'
} as const;

/** The direction of one Kategori Kas — or of one Transaksi Kas. */
export type CashCategoryType = (typeof CASH_CATEGORY_TYPE)[keyof typeof CASH_CATEGORY_TYPE];

/** Every category type there is, for a test — or a screen — that wants to walk them. */
export const CASH_CATEGORY_TYPES: readonly CashCategoryType[] = Object.values(CASH_CATEGORY_TYPE);

/** The SQL list of types, built from the one object above so the two cannot drift apart. */
const TYPE_LIST = CASH_CATEGORY_TYPES.map((type) => `'${type}'`).join(', ');

/**
 * The stable keys of the system categories the migration seeds. Set by the orchestrator's glossary
 * correction on this ticket. #29 (payment verification) and #33 (opening balance) look their
 * category up by these, never by the display name.
 *
 * - `dues`: "Iuran warga" — the income category only payment verification may write to.
 * - `opening-balance`: "Saldo awal" — the income category of the single opening-balance
 *   transaction a superuser records once.
 */
export const SYSTEM_CATEGORY_KEY = {
	dues: 'dues',
	openingBalance: 'opening-balance'
} as const;

/** The stable key of one system category. */
export type SystemCategoryKey = (typeof SYSTEM_CATEGORY_KEY)[keyof typeof SYSTEM_CATEGORY_KEY];

export const cashCategories = pgTable(
	'cash_categories',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The display name an admin picks from a list. Unique, editable, Indonesian in the seed rows. */
		name: text().notNull(),
		type: text().$type<CashCategoryType>().notNull(),
		/** False once a superuser retires the category. Old transactions keep pointing here. */
		isActive: boolean().notNull().default(true),
		/** The stable key of a system category, or null for the ordinary ones. See the doc comment. */
		systemKey: text(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// "Nama unik" — the acceptance criteria's own words, enforced by the database.
		uniqueIndex('cash_categories_name_unique').on(table.name),
		// One row per system key. Ordinary categories all carry null, which NULLS DISTINCT allows.
		uniqueIndex('cash_categories_system_key_unique').on(table.systemKey),
		check('cash_categories_type_check', sql.raw(`type in (${TYPE_LIST})`))
	]
);

/** One row of `cash_categories`: one Kategori Kas. */
export type CashCategory = typeof cashCategories.$inferSelect;

/** A row on its way into `cash_categories`. */
export type NewCashCategory = typeof cashCategories.$inferInsert;
