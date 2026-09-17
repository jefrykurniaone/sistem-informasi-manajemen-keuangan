import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The four tables better-auth keeps: the person who signs in, their sessions, the credentials
 * behind each sign-in method, and the short-lived tokens the library stores.
 *
 * Decisions settled here:
 *
 * - **These keep better-auth's own names, singular and unprefixed: `user`, `session`, `account`,
 *   `verification`.** They are not domain concepts, so the glossary in `CONTEXT.md` has no entry
 *   for them and inventing one would be claiming a meaning they do not have. A reader who sees
 *   `user` here should think "this belongs to the authentication library", not "this is a Warga".
 *   The domain table for a Warga is `residents`, it does not exist yet, and when it arrives it
 *   references `user.id` rather than replacing it. Keeping the library's names also keeps the
 *   adapter configuration honest: the schema object handed to `drizzleAdapter` maps a better-auth
 *   model name to a table, and every name on both sides of that map being the same word is one
 *   fewer thing to get wrong.
 * - **`user` is a reserved word in SQL, and that is fine.** Drizzle quotes every identifier it
 *   emits, so the table is created and queried as `"user"`. Hand-written SQL against it has to
 *   quote it too; there is none, and a test that adds some will find out immediately.
 * - **Primary keys are `text`, not `uuid`.** better-auth generates the values itself — 32
 *   characters drawn from `a-zA-Z0-9` by `crypto.getRandomValues`, around 190 bits — and every
 *   plugin that ever adds a row generates them the same way. Pinning the column to the `uuid` SQL
 *   type would make the database reject any identifier that is not shaped like a UUID, which is a
 *   failure that only shows up at run time and only for whichever code path was not thought about.
 *   The rule in `./index.ts` asks for keys that cannot be guessed from a neighbour's address; a
 *   190-bit random string clears that bar with more room than a version 4 UUID's 122 bits.
 * - **Column names are written once.** The TypeScript property names are the field names
 *   better-auth looks up (`emailVerified`, `expiresAt`, `userId`), and `casing: 'snake_case'`
 *   turns them into `email_verified`, `expires_at`, `user_id` in SQL. Renaming a property here
 *   therefore breaks the adapter, not just the column.
 * - **No column has a database default for its time.** better-auth writes `createdAt` and
 *   `updatedAt` itself on every insert and update, so a `now()` default would be dead weight that
 *   also hides a missing value. This matches the rule the email queue follows for its own reason.
 * - **Timestamps are `withTimezone`**, as everywhere else in this schema.
 * - **Deleting a user deletes their sessions and accounts.** `on delete cascade` on both foreign
 *   keys: a session or a credential that outlives the person it belongs to is a way back in.
 */

/** A person who can sign in. */
export const user = pgTable('user', {
	id: text().primaryKey(),
	name: text().notNull(),
	email: text().notNull().unique(),
	/** Whether the address has been proven by clicking the link sent to it. */
	emailVerified: boolean().notNull().default(false),
	image: text(),
	createdAt: timestamp({ withTimezone: true }).notNull(),
	updatedAt: timestamp({ withTimezone: true }).notNull()
});

/**
 * One signed-in browser. The session cookie carries `token` and nothing else; everything the
 * application knows about the session is read from this row on the request that presents it.
 */
export const session = pgTable(
	'session',
	{
		id: text().primaryKey(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		token: text().notNull().unique(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull(),
		ipAddress: text(),
		userAgent: text(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' })
	},
	(table) => [index('session_user_id_idx').on(table.userId)]
);

/**
 * One way a user can sign in. For an email and password sign-in there is exactly one row, with
 * `providerId` of `credential` and the scrypt hash in `password`. The remaining columns belong to
 * the OAuth providers this application does not use yet and are left in place so that adding one
 * needs no migration.
 */
export const account = pgTable(
	'account',
	{
		id: text().primaryKey(),
		accountId: text().notNull(),
		providerId: text().notNull(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: timestamp({ withTimezone: true }),
		refreshTokenExpiresAt: timestamp({ withTimezone: true }),
		scope: text(),
		/** The scrypt hash, as `salt:key` in hexadecimal. Never the password itself. */
		password: text(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [index('account_user_id_idx').on(table.userId)]
);

/**
 * The short-lived tokens better-auth stores rather than signs. A password reset link lives here,
 * as `identifier` of `reset-password:<token>` and `value` of the user's id, and the row is deleted
 * the moment the link is used — which is what makes such a link single use.
 *
 * The email verification link is deliberately *not* here: it is a signed JWT carrying the address
 * and an expiry, so verifying it needs no row at all.
 */
export const verification = pgTable(
	'verification',
	{
		id: text().primaryKey(),
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [index('verification_identifier_idx').on(table.identifier)]
);
