import { desc, eq } from 'drizzle-orm';
import type { DatabaseWriter } from './authz';
import { auditLog, type AuditEntry } from './db/schema/audit';
import type { Clock } from './ports/clock';

/**
 * Writing to, and reading from, the audit log. Nothing else in this codebase may touch the
 * `audit_log` table directly — see the decisions recorded in `src/lib/server/db/schema/audit.ts`.
 *
 * This module exports exactly two functions on purpose: one insert, one read. There is no
 * `updateAuditEntry` and no `deleteAuditEntry`, and there must never be one — `tests/unit/audit.test.ts`
 * asserts this module's exports for exactly that reason, so that adding one is a test failure
 * rather than a quiet possibility.
 */

/** What a service hands over to be recorded. */
export interface AuditEntryToRecord {
	/** Who made the change. */
	readonly actorId: string;
	/** What kind of change this is, e.g. `role_change`. */
	readonly action: string;
	/** Who or what the change was about. */
	readonly targetId: string;
	/** The value before the change, when this action has one. */
	readonly before?: unknown;
	/** The value after the change, when this action has one. */
	readonly after?: unknown;
}

/**
 * Writes one audit row.
 *
 * Called by the service layer, inside the same transaction as the change it records — never by
 * whoever asked the service to make that change. That is what makes the row true: it exists if and
 * only if the change it describes was really committed.
 *
 * @param writer the caller's transaction. Passing the database itself is only right when there is
 *   no surrounding transaction to share.
 * @param clock stamps `occurredAt`, so a test controls the instant exactly rather than reading it
 *   off the database's own clock.
 */
export async function recordAuditEntry(
	writer: DatabaseWriter,
	clock: Clock,
	entry: AuditEntryToRecord
): Promise<AuditEntry> {
	const [row] = await writer
		.insert(auditLog)
		.values({
			actorId: entry.actorId,
			action: entry.action,
			targetId: entry.targetId,
			before: entry.before ?? null,
			after: entry.after ?? null,
			occurredAt: clock.now()
		})
		.returning();
	return row;
}

/** Every audit row about `targetId`, newest first. */
export async function auditEntriesFor(
	db: DatabaseWriter,
	targetId: string
): Promise<readonly AuditEntry[]> {
	return db
		.select()
		.from(auditLog)
		.where(eq(auditLog.targetId, targetId))
		.orderBy(desc(auditLog.occurredAt));
}
