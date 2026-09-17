import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The audit log: an append-only record of who changed what, listing the actor, the target, the
 * values before and after, and when. `spec-fondasi-v1.md` requires it for every role change; later
 * specs append their own actions to this same table rather than growing one of their own, so that
 * "who changed what" is always answered from one place.
 *
 * Decisions settled here:
 *
 * - **No update, no delete, anywhere in the service layer.** `src/lib/server/audit.ts` exports
 *   exactly two functions — one that inserts a row and one that reads rows back — and neither of
 *   them, nor anything else in this codebase, is ever allowed to grow an `updateAuditEntry` or a
 *   `deleteAuditEntry`. That is enforced by review and by `tests/unit/audit.test.ts` asserting the
 *   module's exports, not by a database-level `REVOKE`: this application connects to PostgreSQL as
 *   one role for everything, and carving out a second, more restricted role for nothing but this one
 *   table is a bigger change than this ticket's surface, not a free extra layer of safety.
 * - **`actorId` and `targetId` are plain `text`, with no foreign key to `user.id`.** An audit row is
 *   a historical record, not a live relationship: it has to keep meaning something even if the
 *   account it names is ever removed, and a `references()` with `onDelete: 'cascade'` would erase
 *   exactly the rows this table exists to keep. Nothing in this application deletes a `user` row
 *   today, but the audit log must not become the reason one day it cannot.
 * - **`action` is free text**, the same choice `email_queue.kind` makes and for the same reason:
 *   every later spec adds its own action names, and a `CHECK` constraint enumerating every action
 *   that will ever exist would need a migration every time one more is added. `role_change` is the
 *   one this ticket writes; see `src/lib/server/services/user/roles.ts`.
 * - **`before` and `after` are both nullable `jsonb`.** A role change always fills both, but a later
 *   spec's "created" or "deleted" kind of action may only have one side to record.
 * - **`occurredAt` has no database default**, the same reasoning as `email_queue.createdAt`: it is
 *   stamped by whichever `Clock` the recording call was given, so a test can assert on it exactly.
 */

export const auditLog = pgTable(
	'audit_log',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Who made the change. */
		actorId: text().notNull(),
		/** What kind of change this is, e.g. `role_change`. */
		action: text().notNull(),
		/** Who or what the change was about. */
		targetId: text().notNull(),
		/** The value before the change, or `null` when this action has none. */
		before: jsonb(),
		/** The value after the change, or `null` when this action has none. */
		after: jsonb(),
		occurredAt: timestamp({ withTimezone: true }).notNull()
	},
	(table) => [
		// The admin screen's only read: every entry about one target, newest first.
		index('audit_log_target_id_idx').on(table.targetId),
		index('audit_log_occurred_at_idx').on(table.occurredAt)
	]
);

/** One row of the audit log. */
export type AuditEntry = typeof auditLog.$inferSelect;

/** A row on its way into the audit log. */
export type NewAuditEntry = typeof auditLog.$inferInsert;
