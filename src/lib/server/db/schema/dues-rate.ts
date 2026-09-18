import { sql } from 'drizzle-orm';
import { bigint, check, date, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';

/**
 * `dues_rates`: the Tarif — the monthly iuran amount, versioned by the date it starts applying.
 * `docs/spec-iuran-v1.md`'s "Implementation decisions" section is explicit about why this is
 * versioned rather than a single row that gets edited: "menaikkan iuran tidak boleh mengubah angka
 * tagihan yang sudah terbit dan sudah dibayar."
 *
 * Decisions settled here:
 *
 * - **No column here points at, or is pointed at by, `invoices`.** The same spec paragraph settles
 *   this: `invoices.amount` freezes its own value at issue time rather than referencing a rate, so
 *   that a later rate change never edits a report or a bill that has already gone out. This table
 *   has no relationship to `invoices` in either direction — it is read by the issuance job that
 *   #26 builds, at the moment a fresh invoice is created, and never again.
 * - **Nothing here enforces "a rate that has already been used to bill cannot be changed."** The
 *   spec asks for that rule, but it is not a rule this table can state as a constraint: because no
 *   invoice references a rate, "has this rate been used" is not a fact this table's own columns or
 *   indexes can see — it can only be answered by asking whether any invoice's period falls in the
 *   window this rate was the active one, which is a query across `invoices`, not a property of one
 *   row here. That question, and the immutability rule built on its answer, belongs to the service
 *   layer #26 or a later ticket builds, the same way `posts`'s doc comment leaves "which columns an
 *   announcement may not fill in" to a service that does not exist yet.
 * - **`effectiveFrom` is a unique `date`, not a `timestamp`.** A rate takes effect from a calendar
 *   day, the same kind of value `occupancies.startedOn` already models; nothing about "the rate
 *   that applies this month" needs a time of day. The acceptance criteria's "dua tarif dengan
 *   tanggal mulai berlaku yang sama ditolak" is the unique index below, enforced by the database
 *   rather than trusted to a service that reads before it writes.
 * - **`amount` is `bigint` with `mode: 'number'` and `.$type<Rupiah>()`, never `integer`.** See
 *   `src/lib/money.ts`. `dues_rates_amount_check` refuses a negative value; it does not refuse
 *   zero, because nothing in the spec says a rate can never be zero and inventing that limit here
 *   would be a rule this ticket was not asked for.
 * - **No `isActive` or "current rate" flag.** "The rate in force on date X" is always a computed
 *   read — the row with the latest `effectiveFrom` that is not after X — never a column that could
 *   fall out of step with the rows it is supposed to summarise. The same reasoning
 *   `docs/spec-iuran-v1.md` gives for leaving `invoices.status` uncomputed applies here in reverse:
 *   a flag would be one more thing that could drift from the truth the timestamps already hold.
 */

export const duesRates = pgTable(
	'dues_rates',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The monthly iuran amount this rate sets, in whole rupiah. */
		amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
		/** The first day this rate applies. Never edited once a later rate exists after it. */
		effectiveFrom: date({ mode: 'string' }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// "Dua tarif dengan tanggal mulai berlaku yang sama ditolak" — one rate per start date.
		uniqueIndex('dues_rates_effective_from_unique').on(table.effectiveFrom),
		check('dues_rates_amount_check', sql`amount >= 0`)
	]
);

/** One row of `dues_rates`: one Tarif, in force from one date onward. */
export type DuesRate = typeof duesRates.$inferSelect;

/** A row on its way into `dues_rates`. */
export type NewDuesRate = typeof duesRates.$inferInsert;
