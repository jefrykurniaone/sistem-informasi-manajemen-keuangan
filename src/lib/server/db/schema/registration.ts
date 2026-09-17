import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * `registrations`: someone who signed themselves up and is waiting for a superuser to decide. One
 * row is one request to be let into the complex, together with what was claimed and what was
 * decided about it.
 *
 * Decisions settled here:
 *
 * - **`claimedBlock` and `claimedNumber` are plain text with no foreign key to `units`.** This is
 *   the whole point of the table rather than an oversight: the pair is what the registrant *says*
 *   their house is, and an unchecked claim is exactly what a superuser is being asked to check. A
 *   foreign key would make the form refuse a house that does not exist, which sounds helpful and is
 *   not — it would turn the sign-up form into a way of asking the application which houses exist,
 *   and it would leave a registrant who mistyped one character with no way to explain themselves.
 *   The spec also lets the superuser attach an approved registration to a *different* unit than the
 *   one claimed, so the claim was never a reference in the first place.
 * - **The row records a request, not an account.** It carries a name and an address of its own
 *   rather than pointing at `user`, so a registration can be read and decided before anything is
 *   created. What happens on approval — an account, a `residents` row, an `occupancies` row — is
 *   the service's business, and this table keeps no foreign key to any of it.
 * - **`status` is text with a check constraint**, the same choice `email_queue.status`,
 *   `user_roles.role` and `job_runs.status` make: a check constraint changes in one plain
 *   migration, while a PostgreSQL enum value can never be removed.
 * - **`registrations_rejection_reason_check` ties the reason to the decision.** A reason on an
 *   approved or a waiting row would be a sentence nobody wrote about a rejection that never
 *   happened. The constraint only forbids that combination; it does not require a rejected row to
 *   carry a reason, because whether the superuser must type one is a rule about the form, and the
 *   form is not this table.
 * - **`registrations_pending_email_unique` allows one waiting registration per address, and any
 *   number of decided ones.** Submitting the form twice would otherwise leave two waiting rows for
 *   one person, and a superuser approving both would attach that person to a house twice. Rejected
 *   and approved rows are outside the index, so someone who was turned down can apply again. The
 *   service that writes a registration has to handle the conflict this raises, which is the point:
 *   it is a real case, and it is better met at the insert than discovered in the approval queue.
 * - **Nothing forces `reviewedBy` and `reviewedAt` to appear together, or to appear at all on a
 *   decided row.** Where the state machine is tightened is the ticket that implements the approval
 *   screen; a constraint written here on a guess would be one that ticket has to migrate away.
 * - **The address is stored as it was typed.** Lower-casing and trimming it, and deciding whether
 *   two spellings are the same person, is the service's job — the same division `units` makes for
 *   block and number.
 */

/**
 * What can be true of a registration.
 *
 * - `pending`: waiting for a superuser. The registrant may sign in but sees only the page saying so.
 * - `approved`: let in, and attached to a house.
 * - `rejected`: turned down. `rejectionReason` says why.
 */
export const REGISTRATION_STATUS = {
	pending: 'pending',
	approved: 'approved',
	rejected: 'rejected'
} as const;

/** The status of one registration. */
export type RegistrationStatus = (typeof REGISTRATION_STATUS)[keyof typeof REGISTRATION_STATUS];

/** Every status there is, for a test — or a screen — that wants to walk them. */
export const REGISTRATION_STATUSES: readonly RegistrationStatus[] =
	Object.values(REGISTRATION_STATUS);

/** The SQL list of statuses, built from the one object above so the two cannot drift apart. */
const STATUS_LIST = REGISTRATION_STATUSES.map((status) => `'${status}'`).join(', ');

export const registrations = pgTable(
	'registrations',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** The registrant's name, as they typed it. */
		name: text().notNull(),
		/** The registrant's email address, as they typed it. */
		email: text().notNull(),
		/** The block they say they live in. Unchecked. */
		claimedBlock: text().notNull(),
		/** The house number they say they live at. Unchecked. */
		claimedNumber: text().notNull(),
		status: text().$type<RegistrationStatus>().notNull(),
		/** Why the registration was turned down. Null unless it was. */
		rejectionReason: text(),
		/** The account that decided. Null while the registration is still waiting. */
		reviewedBy: text().references(() => user.id),
		/** When it was decided. Null while it is still waiting. */
		reviewedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// One waiting registration per address; a decided one leaves the index, so someone who was
		// turned down can apply again.
		uniqueIndex('registrations_pending_email_unique')
			.on(table.email)
			.where(sql.raw(`status = '${REGISTRATION_STATUS.pending}'`)),
		// The superuser's screen: everything still waiting, oldest first.
		index('registrations_status_created_at_idx').on(table.status, table.createdAt),
		check('registrations_status_check', sql.raw(`status in (${STATUS_LIST})`)),
		check(
			'registrations_rejection_reason_check',
			sql.raw(`rejection_reason is null or status = '${REGISTRATION_STATUS.rejected}'`)
		)
	]
);

/** One row of `registrations`: one request to be let in. */
export type Registration = typeof registrations.$inferSelect;

/** A row on its way into `registrations`. */
export type NewRegistration = typeof registrations.$inferInsert;
