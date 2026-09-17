import { and, asc, eq } from 'drizzle-orm';
import { LastSuperuserError } from '$lib/errors';
import { ACTION, requirePermission, rolesOf, type Transaction } from '../../authz';
import { recordAuditEntry } from '../../audit';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { ROLE, userRoles, type Role } from '../../db/schema/authz';
import type { Clock } from '../../ports/clock';

/**
 * Managing who holds which role. The only place `user_roles` is written outside the database
 * trigger that gives every new `user` row its default `resident` role — see
 * `src/lib/server/db/schema/authz.ts`.
 *
 * Every function here takes `actorId` and calls `requirePermission` with it before touching
 * anything, exactly as `spec-fondasi-v1.md`'s "Peran" section asks: a service cannot be called
 * without saying who is calling. `ACTION.manageRoles` is granted to `superuser` alone in
 * `src/lib/server/authz.ts`, so every function below is, today, a superuser-only function; that is
 * a fact about the permission table, not something re-decided here.
 */

/** The audit log's `action` for every row this module writes. */
export const ROLE_CHANGE_ACTION = 'role_change';

/** Who is asking, and what they are asking to change. */
export interface RoleChangeRequest {
	/** The user making the change. Checked against `ACTION.manageRoles` before anything else. */
	readonly actorId: string;
	/** The user whose roles are being changed. */
	readonly targetUserId: string;
	readonly role: Role;
}

/** One user, and the roles they currently hold, as the admin screen needs to show it. */
export interface UserWithRoles {
	readonly userId: string;
	readonly name: string;
	readonly email: string;
	readonly roles: readonly Role[];
}

/**
 * Every user together with the roles each one holds, sorted by name.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listUsersWithRoles(
	db: Database,
	actorId: string
): Promise<readonly UserWithRoles[]> {
	await requirePermission(db, actorId, ACTION.manageRoles);

	const rows = await db
		.select({ userId: user.id, name: user.name, email: user.email, role: userRoles.role })
		.from(user)
		.leftJoin(userRoles, eq(userRoles.userId, user.id))
		.orderBy(asc(user.name));

	return groupByUser(rows);
}

/**
 * Grants `role` to `targetUserId`. A no-op, with no audit row, when they already hold it.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function grantRole(
	db: Database,
	clock: Clock,
	request: RoleChangeRequest
): Promise<void> {
	await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageRoles);

		const before = await rolesOf(transaction, request.targetUserId);
		if (before.has(request.role)) {
			return;
		}

		await transaction
			.insert(userRoles)
			.values({ userId: request.targetUserId, role: request.role, createdAt: clock.now() });

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: ROLE_CHANGE_ACTION,
			targetId: request.targetUserId,
			before: [...before],
			after: [...before, request.role]
		});
	});
}

/**
 * Revokes `role` from `targetUserId`. A no-op, with no audit row, when they do not hold it.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {LastSuperuserError} when this would leave the system with no `superuser` at all.
 */
export async function revokeRole(
	db: Database,
	clock: Clock,
	request: RoleChangeRequest
): Promise<void> {
	await db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageRoles);

		const before = await rolesOf(transaction, request.targetUserId);
		if (!before.has(request.role)) {
			return;
		}
		if (request.role === ROLE.superuser) {
			await assertNotLastSuperuser(transaction, request.targetUserId);
		}

		await transaction
			.delete(userRoles)
			.where(and(eq(userRoles.userId, request.targetUserId), eq(userRoles.role, request.role)));

		const after = new Set(before);
		after.delete(request.role);
		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: ROLE_CHANGE_ACTION,
			targetId: request.targetUserId,
			before: [...before],
			after: [...after]
		});
	});
}

/**
 * Refuses to let `targetUserId`'s `superuser` role be the one that gets revoked when nobody else
 * holds it.
 *
 * **Being inside the caller's transaction is not what makes this safe — the `.for('update')` row
 * lock is.** `db.transaction` runs at PostgreSQL's default READ COMMITTED, where a plain `SELECT`
 * never blocks on another transaction's uncommitted row lock; it just reads the latest *committed*
 * row. Without the lock, two concurrent revokes of two different superusers each read "the other
 * one is still here", each pass this check, and each commit — leaving none, a state nothing in
 * this application can recover from, since `ACTION.manageRoles` is superuser-only. The
 * `.for('update')` below locks every `superuser` row before deciding, so a second concurrent call
 * blocks here until the first one's transaction ends, then re-reads — seeing the first call's
 * committed delete rather than the stale row it started with — and only then decides.
 *
 * Locking every `superuser` row rather than only `targetUserId`'s is deliberate: two concurrent
 * revokes of two *different* superusers must still contend for an overlapping lock, or neither
 * would ever wait for the other.
 */
async function assertNotLastSuperuser(
	transaction: Transaction,
	targetUserId: string
): Promise<void> {
	const superusers = await transaction
		.select({ userId: userRoles.userId })
		.from(userRoles)
		.where(eq(userRoles.role, ROLE.superuser))
		.for('update');

	const remaining = superusers.filter((row) => row.userId !== targetUserId);
	if (remaining.length === 0) {
		throw new LastSuperuserError(targetUserId);
	}
}

/** One row per (user, role) pair from a left join, folded into one entry per user. */
function groupByUser(
	rows: readonly { userId: string; name: string; email: string; role: Role | null }[]
): readonly UserWithRoles[] {
	const byUser = new Map<string, UserWithRoles & { roles: Role[] }>();
	for (const row of rows) {
		let entry = byUser.get(row.userId);
		if (!entry) {
			entry = { userId: row.userId, name: row.name, email: row.email, roles: [] };
			byUser.set(row.userId, entry);
		}
		if (row.role) {
			entry.roles.push(row.role);
		}
	}
	return [...byUser.values()];
}
