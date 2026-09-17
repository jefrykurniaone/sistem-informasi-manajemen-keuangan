import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * The three roles a resident of this application can hold, and the table that records who holds
 * which. The decision of what each role is *allowed to do* lives one layer up, in
 * `src/lib/server/authz.ts` — this file only defines the shape of the set.
 *
 * Decisions settled here:
 *
 * - **A join table, not a column on `user`.** The spec asks for roles as a set a person can hold
 *   more than one of at once, and a single `role` column on `user` cannot represent someone who is
 *   both `admin` and `superuser`. `user_roles` has one row per role a person holds, with a unique
 *   pair on `(user_id, role)` so the same role cannot be granted twice.
 * - **`role` is text with a check constraint, not a PostgreSQL enum.** The same reasoning as
 *   `email_queue.status` in `./email.ts`: this set of three names might still grow, and a check
 *   constraint is one plain migration away while a `PostgreSQL` enum value can never be removed and
 *   is awkward to add inside a transaction.
 * - **Every new `user` row gets a `resident` row here, and that is enforced by a database trigger**
 *   added by hand in the migration that creates this table
 *   (`user_created_gets_resident_role_trigger`), not by application code. `src/lib/server/auth.ts`
 *   — the only place a sign-up actually happens today — is a *read* for this ticket, not a write, so
 *   the default cannot be wired in from a `databaseHooks` callback there without widening the
 *   surface this ticket was scoped to. A trigger fires no matter how the row was inserted — through
 *   better-auth's sign-up, through a script, through a future admin-created-account feature — so the
 *   invariant "a user always holds at least `resident`" holds regardless of which code path created
 *   the account, which a callback wired into one specific signup flow would not guarantee.
 * - **`createdAt` has no database default**, for the same reason `email_queue.createdAt` does not:
 *   every row the service layer writes is stamped by the `Clock` a test can control. The one
 *   exception is the trigger's own insert, which has no `Clock` to be handed and is stamped with the
 *   database's own `now()` instead — see the comment on the trigger itself in the migration SQL.
 * - **No foreign key from `role` to a lookup table.** Three literal values checked by a `CHECK`
 *   constraint is simpler than a table that would only ever hold three rows, and `ROLES` below is
 *   the one place the set is spelled out in TypeScript.
 */

export const ROLE = {
	resident: 'resident',
	admin: 'admin',
	superuser: 'superuser'
} as const;

/** One of the three roles a person can hold. */
export type Role = (typeof ROLE)[keyof typeof ROLE];

/** Every role there is, for a test — or a screen — that wants to walk them all. */
export const ROLES: readonly Role[] = Object.values(ROLE);

/** The SQL list of roles, built from `ROLE` so the two cannot drift apart. */
const ROLE_LIST = ROLES.map((role) => `'${role}'`).join(', ');

export const userRoles = pgTable(
	'user_roles',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The person who holds this role. */
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text().$type<Role>().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// The same role cannot be granted to the same person twice.
		uniqueIndex('user_roles_user_id_role_unique').on(table.userId, table.role),
		// Every permission check reads "which roles does this person hold" by userId.
		index('user_roles_user_id_idx').on(table.userId),
		check('user_roles_role_check', sql.raw(`role in (${ROLE_LIST})`))
	]
);

/** One row of `user_roles`: one role held by one person. */
export type UserRole = typeof userRoles.$inferSelect;

/** A row on its way into `user_roles`. */
export type NewUserRole = typeof userRoles.$inferInsert;
