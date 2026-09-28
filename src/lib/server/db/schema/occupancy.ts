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
 * — "ke mana tagihan rumah itu dikirim sekarang".
 *
 * Decisions settled here:
 *
 * - **A unit may have several occupancies running at once, and a resident may have several.** A
 *   husband and a wife both live in the same house; an owner who rents their house out stays
 *   attached to it while a tenant lives there. So there is no unique pair on `(unit_id,
 *   resident_id)` and none on either column alone. The only uniqueness here is the one below, on
 *   the primary occupant.
 * - **The primary occupant — the Penanggung Jawab — is a flag on this row, not a column on `units`
 *   and not a table of its own.** A column on `units` pointing at a resident could name someone who
 *   never lived there, and a table of its own would hold the same pair of values as the occupancy it
 *   belongs to and would then have to be kept in step with it. The flag cannot disagree with the
 *   occupancy it is part of, because it *is* part of it. This is the same argument `job_runs` makes
 *   for keeping the lock in the history row.
 * - **The flag means "the house's invoice emails go here now", and it moves.**
 *   `docs/adr/0001-penanggung-jawab-berpindah.md` settles it. Marking another running occupancy of
 *   the same house takes the flag off the previous holder and puts it on the new one, effective at
 *   once; the previous holder keeps living there for as long as their own stay runs. The flag only
 *   lands on an occupancy that is running today, and the Penanggung Jawab is the flagged occupancy
 *   running today. Who held it before is recorded in the audit log, not here: a flag left on an
 *   occupancy whose last day has passed is not history, nothing reads it, and ending an occupancy
 *   does not clear it. This withdraws `docs/spec-warga-unit-v1.md`'s promise that this table could
 *   answer "the Penanggung Jawab of a Unit on a date" — that question is the audit log's.
 * - **At most one flagged row per unit among the occupancies whose last day has not passed or has
 *   not been written — and the service keeps that, not this table.**
 *   `src/lib/server/services/occupancy/index.ts` takes the unit's row lock before every write that
 *   sets the flag, and takes the flag off every such row of the unit in the same transaction; its
 *   doc comment holds the whole argument. No constraint here can state the rule, because "has not
 *   passed" is a question about today.
 * - **`occupancies_primary_occupant_unique` is the last line of defence, not the rule.** It is a
 *   unique index on `unit_id` restricted to the rows where `is_primary_occupant` is true and
 *   `ended_on` is null. `tests/unit/schema-resident-unit.test.ts` proves it on its own, by inserting a
 *   second such row directly and asserting on PostgreSQL's `23505` and the index's name. It still
 *   refuses the commonest mistake — two open-ended flagged occupancies in one house, written by
 *   something that went round the service — and costs nothing, so it stays.
 *
 *   **What it does not cover:** a flagged row whose last day has been written but has not arrived
 *   is outside the index while it is still inside the rule above. That is why the lock, not the
 *   index, keeps the rule. An exclusion constraint over a `daterange` — `EXCLUDE USING gist (unit_id
 *   WITH =, daterange(started_on, ended_on) WITH &&) WHERE (is_primary_occupant)` — would not close
 *   it either: it states "no two flagged occupancies overlap", which is the date-clash model ADR 0001
 *   rejected, since it makes a housemate who has lived there all along impossible to mark. It is
 *   also refused for a reason of its own: it needs the `btree_gist` extension, the test harness
 *   migrates inside a schema of its own with `search_path` pinned to it, Vitest runs those files in
 *   parallel, and an extension is database-wide rather than schema-wide, so `create extension if not
 *   exists` would be a no-op for the second file and its operator class would then vanish when the
 *   first file drops its schema.
 *
 *   The index is partial rather than a plain unique on `(unit_id)` so that a flag left on a finished
 *   occupancy never blocks anything: a row with a last day written leaves the index.
 * - **`startedOn` and `endedOn` are `date`, read as strings.** They are calendar days, not
 *   instants: someone moves in on the 3rd, not at 00:00 in some time zone. `mode: 'string'` keeps
 *   them as `YYYY-MM-DD` all the way through, because turning a calendar day into a JavaScript
 *   `Date` makes it an instant at midnight somewhere, and reading it back anywhere else can move it
 *   a day. `endedOn` is the last day lived in, not the first day after it (`CONTEXT.md`, Masa
 *   Huni), and is null until one is written — which is not the same as "still running": an
 *   occupancy is running on a day when it has started and its last day has not passed, see
 *   `isStillRunningOn` in `src/lib/server/services/occupancy/visibility.ts`.
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
		/** The last day of it, a day still lived in, or null while none has been written. */
		endedOn: date({ mode: 'string' }),
		/**
		 * The Penanggung Jawab flag: whether the house's invoice emails go to this occupancy while it is
		 * running. It moves between occupancies — see ADR 0001 and the decisions above.
		 */
		isPrimaryOccupant: boolean().notNull().default(false),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// At most one flagged occupancy per house among those with no last day written. The last line
		// of defence, not the rule: the Occupancy service keeps one flag per house among the
		// occupancies that have not passed, under the unit's row lock. See the decisions above for
		// what this index does not cover and why ADR 0001 leaves it that way.
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
