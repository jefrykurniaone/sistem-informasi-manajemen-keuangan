import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { units } from './unit';

/**
 * `invitations`: the time-limited, single-use link that lets a person set their own password and
 * start using the application. One row is one link sent to one address about one house.
 *
 * Decisions settled here:
 *
 * - **The token is stored hashed, and the value in the link is never written anywhere.** The
 *   service that creates an invitation draws the token from a cryptographically secure source —
 *   `crypto.randomBytes`, never `Math.random` — puts it in the email, and stores only its SHA-256
 *   digest here. Redeeming a link hashes what was presented and looks that digest up. The
 *   consequence is the point: a copy of this table, a database backup or a leaked log is not a set
 *   of working links, and nobody who can read the table can sign in as the invitee. The digest is
 *   unsalted on purpose, which is the opposite of the rule for passwords: the token is not a human
 *   secret with a few bits of entropy but a long random value, so there is nothing to guess, and a
 *   per-row salt would make "find the row for this token" impossible without reading every row.
 *   `tests/unit/schema-resident-unit.test.ts` reads the column list back out of
 *   `information_schema` and asserts there is no column a raw token could be written to.
 * - **The address is `text` and is not a foreign key to anything.** The whole point of an
 *   invitation is that the person does not have an account yet; there is nothing to point at. When
 *   they redeem it, `user`, `residents` and `occupancies` rows come into being together.
 * - **`expiresAt` is an instant on the row, not a rule in code.** The spec's seven days is the
 *   service's decision at the moment it creates the row; the database stores when this particular
 *   link stops working, so a link that was sent before the rule changed keeps the deadline it was
 *   sent with.
 * - **`usedAt`, not a boolean.** "Single use" needs the same column either way, and an instant also
 *   answers when it was redeemed, which a boolean throws away. Null means unused, which is also
 *   what the admin screen lists when it offers to send an invitation again.
 * - **`createdBy` references `user.id`, not `residents.id`.** This column records who performed an
 *   action, and in this schema an actor is identified by their account: `user_roles.userId` and
 *   `audit_log.actorId` both do the same. A superuser is not required to be a resident of the
 *   complex, so pointing at `residents` would make the table refuse a legitimate invitation.
 * - **No `onDelete` on either foreign key**, so a house and an account that an invitation names
 *   cannot be deleted out from under it. Houses are never deleted anyway; the account rule is the
 *   one stated on `residents.userId`.
 * - **Nothing here says one address may only hold one live invitation.** "Live" means unused and
 *   not yet expired, and an index cannot ask whether an instant has passed — `now()` is not
 *   something a predicate may call. Sending an invitation again is an explicit feature of the spec,
 *   so the service decides whether that replaces the previous one or joins it.
 */

export const invitations = pgTable(
	'invitations',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The SHA-256 digest of the token in the link. The token itself is never stored. */
		tokenHash: text().notNull(),
		/** Where the link was sent. */
		email: text().notNull(),
		/** The house the invitee will be recorded as living in. */
		unitId: uuid()
			.notNull()
			.references(() => units.id),
		/** After this instant the link no longer works. */
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		/** When the link was redeemed. Null while it is still unused. */
		usedAt: timestamp({ withTimezone: true }),
		/** The account that sent it. */
		createdBy: text()
			.notNull()
			.references(() => user.id),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// Redeeming a link is a lookup by digest, and two rows sharing one would make it ambiguous.
		uniqueIndex('invitations_token_hash_unique').on(table.tokenHash),
		// The admin screen's read: every invitation sent to one address.
		index('invitations_email_idx').on(table.email)
	]
);

/** One row of `invitations`: one link sent to one address about one house. */
export type Invitation = typeof invitations.$inferSelect;

/** A row on its way into `invitations`. */
export type NewInvitation = typeof invitations.$inferInsert;
