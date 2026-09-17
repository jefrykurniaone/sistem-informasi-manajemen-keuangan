import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * `residents`: the domain's record of a person — a Warga. One row per account, holding what the
 * domain knows about that person and better-auth does not.
 *
 * Decisions settled here:
 *
 * - **A table of its own, referencing `user.id` rather than replacing it.** This is the shape
 *   `src/lib/server/db/schema/auth.ts` already promised ("the domain table for a Warga is
 *   `residents`, it does not exist yet, and when it arrives it references `user.id` rather than
 *   replacing it") and the one `CONTEXT.md` names. The alternative considered was no table at all,
 *   with `occupancies.residentId` pointing straight at `user.id`. It was rejected for a concrete
 *   reason, not for tidiness: the spec asks a resident to be able to correct their own name *and
 *   phone number*, `user` has no phone number, and `user` belongs to better-auth — its columns are
 *   the library's, and growing one would be editing a file this ticket may not touch and that the
 *   library would not know about. A phone number needs somewhere to live, and this is it.
 * - **The primary key is a uuid, and `userId` is the only column that carries a better-auth
 *   identifier.** Every later domain table that names a person — a payment, a complaint, a
 *   subscription — references `residents.id`, so the authentication library's identifier space
 *   stops at this one column instead of spreading across the schema. It also matches `user_roles`,
 *   the other table that hangs off an account: uuid key, `text` foreign key to `user.id`.
 * - **`userId` is unique.** One account is one person. The unique index is what makes the
 *   one-to-one real rather than a convention the service layer is trusted to keep.
 * - **Nothing here creates the row.** No trigger, unlike the `resident` *role*, which
 *   `user_created_gets_resident_role_trigger` grants to every new account. A role says what an
 *   account may do and every account may do the resident-level things; a row here says the complex
 *   has a record of this person, which is true only once they have been admitted — by a CSV import,
 *   by accepting an invitation, or by a superuser approving a self-registration. The spec depends on
 *   that difference: a self-registrant "bisa masuk, tetapi hanya melihat halaman yang mengatakan
 *   pendaftarannya sedang ditinjau", so an account with no row here is a real and expected state.
 * - **The name stays on `user`, and is not copied here.** better-auth writes `user.name` at sign-up
 *   and the account screen edits it; a second copy would be two answers to one question. A screen
 *   that shows a resident joins the two.
 * - **No `onDelete` on the foreign key**, so PostgreSQL's `no action` applies and an account that
 *   has a row here cannot be deleted. That is deliberate. `session` and `account` cascade because a
 *   credential outliving its owner is a way back in; occupancy history is the opposite kind of
 *   thing — it is the record of who lived where, the financial specs point at it, and a cascade
 *   would make deleting one account quietly erase it. Nothing in this application deletes a `user`
 *   today; when something does, it has to decide what happens to the history rather than discover
 *   the answer afterwards. Same reasoning as the missing foreign key on `audit_log.actorId`,
 *   reached from the other side.
 */

export const residents = pgTable(
	'residents',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The account this person signs in with. Their name and email live on that row. */
		userId: text()
			.notNull()
			.references(() => user.id),
		/** A phone number, as the resident typed it. Null until they fill it in. */
		phone: text(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// One account is one person.
		uniqueIndex('residents_user_id_unique').on(table.userId)
	]
);

/** One row of `residents`: one person the complex has a record of. */
export type Resident = typeof residents.$inferSelect;

/** A row on its way into `residents`. */
export type NewResident = typeof residents.$inferInsert;
