import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * `units`: every house in the complex, one row each. This is the list the whole application is
 * anchored to — an invoice, a cash transaction and a complaint all name a unit, and they name it
 * forever.
 *
 * Decisions settled here:
 *
 * - **A house is identified by the pair `(block, number)`, and that pair is unique.** The
 *   `units_block_number_unique` index is what makes "C-12" mean one house rather than two, and it
 *   is also what a CSV import runs into when the file lists the same house twice. The primary key
 *   is a uuid all the same: the pair is the identity a resident reads and writes, and a resident
 *   can be wrong about it, so a row that has to be corrected must keep the identity every invoice
 *   already points at.
 * - **`block` and `number` are both `text`.** A house number is not a quantity: `12A`, `12 B` and
 *   `08` all occur, and storing `08` as an integer loses the leading zero that the sign on the
 *   gate has. Nothing ever adds two house numbers together, so the only thing an integer column
 *   would buy is a sort order that is wrong for `2` against `10` anyway. Normalising the spelling —
 *   trimming, case — is the import service's job, because it is the layer that can report which
 *   line of the file it rejected.
 * - **`isActive`, never a delete.** A house that no longer exists is switched off, because the
 *   invoices, payments and cash transactions that point at it have to keep meaning something. The
 *   default is `true`: a house that has just been added exists.
 * - **`createdAt` has no database default**, the rule every table in this schema follows except
 *   `scaffold_probe`: every instant is written by code that was handed a `Clock`, so a test decides
 *   what time it is rather than waiting for it.
 */

export const units = pgTable(
	'units',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The block the house stands in, spelled as the sign on it spells it. */
		block: text().notNull(),
		/** The house number inside that block. */
		number: text().notNull(),
		/** False once the house no longer exists. A row is never deleted. */
		isActive: boolean().notNull().default(true),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// "C-12" is one house. This is also the check a CSV import listing a house twice fails.
		uniqueIndex('units_block_number_unique').on(table.block, table.number)
	]
);

/** One row of `units`: one house. */
export type Unit = typeof units.$inferSelect;

/** A row on its way into `units`. */
export type NewUnit = typeof units.$inferInsert;
