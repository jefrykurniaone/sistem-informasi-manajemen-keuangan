import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { residents } from './resident';

/**
 * `subscriptions`: whether one resident wants one kind of notification. One row per resident per
 * kind — the spec's "preferensi notifikasi adalah data, bukan kolom boolean yang bertambah".
 *
 * Decisions settled here:
 *
 * - **A row per pair, not a column per kind.** Every later spec brings notifications of its own.
 *   With a column each, adding one would mean a migration, a wider table for every resident who
 *   never touches it, and a screen that has to know the column list at compile time. With a row
 *   each, adding a kind is a row, and the screen is a loop.
 * - **`subscriptions_resident_id_kind_unique` is the rule the spec asks for.** Two rows for the
 *   same resident and the same kind would be two answers to one question, and the one the sender
 *   reads would depend on the order rows came back in.
 * - **`kind` is free text with no check constraint and no list in TypeScript here.** This is the
 *   same choice `email_queue.kind` makes and for the same reason, which the spec states outright:
 *   "Jenis notifikasi yang dikenal ditetapkan di sini; spec lain menambah jenisnya sendiri." A
 *   check constraint would make every spec that adds one notification ship a migration to widen
 *   it. The set of kinds that really exist is the registry the notification service is given, and
 *   this ticket builds no service — a row naming a kind that is not in that registry is a row
 *   nothing ever reads, not a corrupt database.
 * - **Which kinds cannot be switched off is not enforced here.** The spec keeps invoice and
 *   payment emails mandatory while the monthly report and new posts are opt-in, and that rule
 *   belongs with the registry that knows which kind is which, one layer up: expressing it in SQL
 *   would mean naming every mandatory kind in a check constraint, which is exactly the migration
 *   per notification the free-text column was chosen to avoid. The spec agrees on where it is
 *   proven — "pembuktian bahwa jenis yang wajib tidak bisa dimatikan" is listed under what is
 *   tested through the service layer.
 * - **`enabled` has no default.** The spec gives each kind a default of its own, decided when the
 *   account is created, so a column default here could only ever be right for some of them. A
 *   writer has to say what it means.
 * - **No `updatedAt`.** Flipping a preference is a change like any other, and the one place this
 *   application answers "who changed what, when" is `audit_log`. A second, partial answer on this
 *   row would be one more thing to keep true.
 * - **`onDelete: 'cascade'` from `residents`, unlike everywhere else in this spec.** A preference
 *   is not history: it says what someone wants to receive, and it means nothing once there is
 *   nobody to receive it. There is nothing here a later spec reads back about the past, so nothing
 *   is lost by letting it go with the person. (In practice a resident cannot be deleted while any
 *   occupancy names them — see `residents.userId`.)
 */

export const subscriptions = pgTable(
	'subscriptions',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Whose preference this is. */
		residentId: uuid()
			.notNull()
			.references(() => residents.id, { onDelete: 'cascade' }),
		/** Which notification it is about, as the notification registry spells it. */
		kind: text().notNull(),
		/** Whether they want to receive it. */
		enabled: boolean().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// One answer per resident per kind.
		uniqueIndex('subscriptions_resident_id_kind_unique').on(table.residentId, table.kind)
	]
);

/** One row of `subscriptions`: one resident's answer about one kind of notification. */
export type Subscription = typeof subscriptions.$inferSelect;

/** A row on its way into `subscriptions`. */
export type NewSubscription = typeof subscriptions.$inferInsert;
