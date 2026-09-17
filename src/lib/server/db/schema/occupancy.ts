import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { residents } from './resident';
import { units } from './unit';

/**
 * `occupancies`: who lives in which house, for which stretch of time. This is the table that
 * answers "siapa yang tinggal di C-12 pada Maret lalu", and — through the `isPrimaryOccupant` flag
 * — "ke mana tagihan rumah itu dikirim".
 *
 * Decisions settled here:
 *
 * - **A unit may have several occupancies running at once, and a resident may have several.** A
 *   husband and a wife both live in the same house; an owner who rents their house out stays
 *   attached to it while a tenant lives there. So there is no unique pair on `(unit_id,
 *   resident_id)` and none on either column alone. The only uniqueness here is the one below, on
 *   the primary occupant.
 * - **The primary occupant is a flag on this row, not a column on `units` and not a table of its
 *   own.** A column on `units` pointing at a resident could name someone who never lived there, and
 *   a table of its own would hold the same pair of values as the occupancy it belongs to and would
 *   then have to be kept in step with it. The flag cannot disagree with the occupancy it is part
 *   of, because it *is* part of it. This is the same argument `job_runs` makes for keeping the lock
 *   in the history row.
 * - **At most one running occupancy per unit may carry the flag, and the database is what refuses
 *   the second.** `occupancies_primary_occupant_unique` is a unique index on `unit_id` restricted
 *   to the rows where `is_primary_occupant` is true and `ended_on` is null. It is the whole
 *   mechanism: no read happens first, so two requests arriving at the same instant cannot both find
 *   the unit free and both write. `tests/unit/schema-resident-unit.test.ts` proves it by inserting
 *   the second row directly, with no service layer anywhere near it, and asserting on PostgreSQL's
 *   own `23505` and the index's name.
 *
 *   The index is partial rather than a plain unique on `(unit_id)` for the same reason `job_runs`
 *   made its claim index partial: the flag has to survive the end of the occupancy. The spec
 *   publishes "the primary occupant of a Unit on a date" as a contract for the later specs, and a
 *   design that cleared the flag when the occupancy ended would have no answer for a date in the
 *   past. A row that has ended keeps its flag as history and leaves the index, which frees the
 *   slot for the next resident in the same statement that ends the old occupancy — no second write
 *   that could be skipped, and no unit left permanently unassignable.
 *
 *   **What this index does not cover, deliberately:** it reads "still running" as `ended_on is
 *   null`, so writing an end date that is still in the future frees the slot before that date
 *   arrives, and a second primary occupant can then be marked for the overlapping days. Closing
 *   that would take an exclusion constraint over a `daterange` — `EXCLUDE USING gist (unit_id WITH
 *   =, daterange(started_on, ended_on) WITH &&) WHERE (is_primary_occupant)` — which needs the
 *   `btree_gist` extension. That extension is rejected here, not overlooked: the test harness
 *   migrates inside a schema of its own with `search_path` pinned to it, Vitest runs those files in
 *   parallel, and an extension is database-wide rather than schema-wide, so `create extension if
 *   not exists` would be a no-op for the second file and its operator class would then vanish when
 *   the first file drops its schema. A correctness rule that only holds when the test files happen
 *   to run in the right order is worse than a narrower rule that always holds. The service layer
 *   that ends an occupancy therefore owns the future-dated case, and this comment is where it is
 *   written down.
 * - **`startedOn` and `endedOn` are `date`, read as strings.** They are calendar days, not
 *   instants: someone moves in on the 3rd, not at 00:00 in some time zone. `mode: 'string'` keeps
 *   them as `YYYY-MM-DD` all the way through, because turning a calendar day into a JavaScript
 *   `Date` makes it an instant at midnight somewhere, and reading it back anywhere else can move it
 *   a day. `endedOn` is null while the occupancy is still running.
 * - **`occupancies_date_order_check` refuses an end date earlier than the start date.** Same day is
 *   allowed — someone can move in and out on the 3rd, and the spec says "lebih awal dari", not
 *   "sama dengan".
 * - **`role` is text with a check constraint**, the same choice `email_queue.status`,
 *   `user_roles.role` and `job_runs.status` make, and for the same reason: a check constraint is
 *   one plain migration away from changing, while a PostgreSQL enum value can never be removed.
 *   `owner` and `tenant` are the English for the "pemilik atau penyewa" the glossary already names
 *   in its Masa Huni entry; they are not a new concept and so have no row of their own in
 *   `CONTEXT.md`.
 * - **The foreign keys have no `onDelete`.** A unit is never deleted and a resident cannot be while
 *   a row here points at them — see the note on `residents.userId`. This history is what the later
 *   specs read; nothing may quietly erase it.
 */

/**
 * The two ways a person can be attached to a house.
 *
 * - `owner`: the house is theirs. They stay attached while it is rented out.
 * - `tenant`: they rent it.
 */
export const OCCUPANCY_ROLE = {
	owner: 'owner',
	tenant: 'tenant'
} as const;

/** How one person is attached to one house. */
export type OccupancyRole = (typeof OCCUPANCY_ROLE)[keyof typeof OCCUPANCY_ROLE];

/** Every occupancy role there is, for a test — or a screen — that wants to walk them. */
export const OCCUPANCY_ROLES: readonly OccupancyRole[] = Object.values(OCCUPANCY_ROLE);

/** The SQL list of roles, built from the one object above so the two cannot drift apart. */
const OCCUPANCY_ROLE_LIST = OCCUPANCY_ROLES.map((role) => `'${role}'`).join(', ');

export const occupancies = pgTable(
	'occupancies',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The house. */
		unitId: uuid()
			.notNull()
			.references(() => units.id),
		/** The person living in it. */
		residentId: uuid()
			.notNull()
			.references(() => residents.id),
		role: text().$type<OccupancyRole>().notNull(),
		/** The first day of the occupancy. */
		startedOn: date({ mode: 'string' }).notNull(),
		/** The last day of it, or null while it is still running. */
		endedOn: date({ mode: 'string' }),
		/** Whether this is the occupancy the house's invoice emails are addressed to. */
		isPrimaryOccupant: boolean().notNull().default(false),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// One primary occupant per house among the occupancies that are still running. This index is
		// the rule; nothing reads before writing, so two requests at the same instant cannot both
		// find the house free. See the argument above for why the predicate is `ended_on is null`
		// and what that does not cover.
		uniqueIndex('occupancies_primary_occupant_unique')
			.on(table.unitId)
			.where(sql`is_primary_occupant and ended_on is null`),
		// "Every occupancy of this house, newest first" is the admin screen's read, and "every
		// house this person has lived in" is the resident's.
		index('occupancies_unit_id_idx').on(table.unitId),
		index('occupancies_resident_id_idx').on(table.residentId),
		check('occupancies_role_check', sql.raw(`role in (${OCCUPANCY_ROLE_LIST})`)),
		check('occupancies_date_order_check', sql`ended_on is null or ended_on >= started_on`)
	]
);

/** One row of `occupancies`: one person in one house for one stretch of time. */
export type Occupancy = typeof occupancies.$inferSelect;

/** A row on its way into `occupancies`. */
export type NewOccupancy = typeof occupancies.$inferInsert;
