import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { residents } from './resident';
import { units } from './unit';

/**
 * `exemptions`: the Pembebasan — a stretch of time during which one Unit is not issued a Tagihan.
 * `docs/spec-iuran-v1.md` is explicit that this is "periode, bukan saklar": a house that its owner
 * has left is exempt *from a date*, not exempt in general, so that the months before and after are
 * still billed and still explicable.
 *
 * Decisions settled here:
 *
 * - **`startedOn` and `endedOn` are `date` read as strings, named the way `occupancies` names
 *   them.** This is the same kind of value that table already models — a dated period attached to a
 *   Unit — and giving it a second spelling would make two tables that answer "is this house covered
 *   on 3 March" look like two different questions. `mode: 'string'` keeps them as `YYYY-MM-DD`
 *   rather than turning a calendar day into an instant at midnight in whichever time zone read it
 *   back, for the reason `occupancy.ts` sets out at length.
 * - **`endedOn` is nullable and means "no end yet".** The acceptance criteria asks for a "tanggal
 *   selesai yang boleh kosong", and user story 19 asks for an exemption "sampai tanggal tertentu
 *   atau tanpa batas". An open-ended exemption is the normal case for an abandoned house.
 * - **`exemptions_date_order_check` refuses an end date earlier than the start date, and allows the
 *   same day.** The acceptance criteria says "lebih awal dari", not "sama dengan": an exemption
 *   covering exactly one day is a real thing to want to record. Identical wording and identical
 *   constraint to `occupancies_date_order_check`.
 * - **Nothing forbids two exemptions on one Unit from overlapping.** Neither the spec nor this
 *   ticket asks for it, and it is the kind of rule that cannot be added cheaply here: the only
 *   database-level form is an exclusion constraint over a `daterange`, which needs the `btree_gist`
 *   extension, and `occupancy.ts` already records why this repository rejects that — an extension is
 *   database-wide while the test harness migrates inside a schema of its own, so the constraint
 *   would hold or not depending on which test file happened to run first. It is also a rule with
 *   nothing behind it: issuance skips a Unit when *any* exemption covers the period, so two
 *   overlapping rows and one merged row produce exactly the same invoices.
 * - **`reason` is `notNull`.** An exemption is one house not being asked for money while its
 *   neighbours are, and user story 19's whole premise is that there is a reason worth naming. There
 *   is no path that creates one without one.
 * - **`createdBy` names who granted it, and pairs with `createdAt`.** Not `grantedBy`: the row's
 *   creation *is* the granting, there is no other way one comes into being, and a separate verb
 *   would suggest there is. The acceptance criteria's "pelakunya" is this column. It references
 *   `residents.id` — a Superuser, per `CONTEXT.md`'s role entry — and carries no `onDelete`, the
 *   same reasoning `complaints.reporterId` settles: who exempted a house from paying is attributed
 *   history that must keep meaning something even if that account is ever removed.
 * - **No "cancelled" or "revoked" marker.** Shortening an exemption is writing an `endedOn`, which
 *   is what a superuser changing their mind actually means; a second way to end one would be a
 *   second answer to "is this house covered today".
 * - **A backdated exemption changes nothing that already exists.** `docs/spec-iuran-v1.md:124-129`
 *   is explicit: it does not void invoices that have already been issued, because some of them have
 *   been paid and voiding those would erase money that is already in the cash book. Nothing in this
 *   table reaches back — it is read forward by the issuance job #26 builds, and the superuser voids
 *   past invoices one at a time through `invoices.voidedAt`.
 */

export const exemptions = pgTable(
	'exemptions',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The house that is not billed while this Pembebasan runs. */
		unitId: uuid()
			.notNull()
			.references(() => units.id),
		/** The first day the house is exempt. */
		startedOn: date({ mode: 'string' }).notNull(),
		/** The last day of it, or null when the exemption has no end yet. */
		endedOn: date({ mode: 'string' }),
		/** Why this house is not being billed. */
		reason: text().notNull(),
		/** The Superuser who granted it. */
		createdBy: uuid()
			.notNull()
			.references(() => residents.id),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// "Is this house exempt for the period being issued" is the issuance job's read, and "every
		// exemption this house has had" is the admin screen's.
		index('exemptions_unit_id_idx').on(table.unitId),
		check('exemptions_date_order_check', sql`ended_on is null or ended_on >= started_on`)
	]
);

/** One row of `exemptions`: one Unit exempt from Tagihan for one stretch of time. */
export type Exemption = typeof exemptions.$inferSelect;

/** A row on its way into `exemptions`. */
export type NewExemption = typeof exemptions.$inferInsert;
