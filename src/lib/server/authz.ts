import { eq } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import type { Database } from './db';
import { ROLE, userRoles, type Role } from './db/schema/authz';

/**
 * The one guard every service calls before doing anything, and the one place "who is allowed to do
 * what" is decided — see `spec-fondasi-v1.md`'s "Peran" section. A service function that does not
 * take a caller and call `requirePermission` with it is not following this ticket's contract.
 *
 * ## Shape of the decision
 *
 * An action is permitted to a *set* of roles, not to a rank on a single scale: `PERMISSIONS` below
 * maps each known action to every role that may perform it, and a caller is let through the moment
 * any one role they hold appears in that set. `ACTION.manageRoles` was the first, because the
 * ticket that wrote this file was the first thing in the run that needed a decision at all — every
 * later spec adds its own actions to `ACTION` and `PERMISSIONS` in this same file, rather than
 * inventing a second place a permission could be decided. `ACTION.manageJobs` is the first of
 * those.
 *
 * ## Where a caller's roles come from
 *
 * `rolesOf` reads `user_roles` directly. It never falls back to treating an empty result as
 * `resident`: the migration in `drizzle/0003_authz_audit.sql` adds a trigger that inserts a
 * `resident` row for every `user` row the moment it exists, so an empty result here means the
 * trigger did not run — which is a broken migration, not a normal state this function should paper
 * over silently.
 */

/** A database, or a transaction on one — whatever this module is handed, it never opens its own. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything this module, or a caller of it, can run a query against. */
export type DatabaseWriter = Database | Transaction;

/** Every action this application currently knows how to permit. */
export const ACTION = {
	/** Granting or revoking a role. See `src/lib/server/services/user/roles.ts`. */
	manageRoles: 'manageRoles',
	/**
	 * Seeing the scheduled jobs and running one by hand. See `src/lib/server/scheduler/index.ts`.
	 * One action covers both halves because they are one screen: the list is only useful to whoever
	 * may press the button on it, and the button issues real work — a month's invoices, a batch of
	 * emails — so it is held to the same role as anything else that changes what has already
	 * happened.
	 */
	manageJobs: 'manageJobs',
	/**
	 * Seeing the admin list of Unit, adding a new one, and deactivating or reactivating one. See
	 * `src/lib/server/services/unit/index.ts`. One action for the read and the writes, same
	 * reasoning as `manageJobs`: the list is only useful to whoever may act on it, and every write
	 * here changes the house register the rest of the application anchors invoices and cash
	 * transactions to.
	 */
	manageUnits: 'manageUnits',
	/**
	 * Seeing the admin list of Post, writing one, editing it, previewing it, publishing it and
	 * archiving it. See `src/lib/server/services/post/index.ts`. One action for the read and the
	 * writes, the same reasoning as `manageJobs` and `manageUnits`.
	 *
	 * **The first action in this table that is not `superuser`'s.** See `PERMISSIONS` below.
	 */
	managePosts: 'managePosts'
} as const;

/** One of the actions above. */
export type Action = (typeof ACTION)[keyof typeof ACTION];

/**
 * Which roles may perform which action. The one table this whole guard is built around.
 *
 * A later spec adds its own entry here when it adds its own action — this object, not a second map
 * somewhere closer to that feature, is "the one place" `spec-fondasi-v1.md` asks for.
 *
 * ## `managePosts` belongs to `admin`, and to `admin` alone
 *
 * Every other entry here is `superuser`'s, which made it easy to read this table as a ladder. It is
 * not one. `spec-fondasi-v1.md`'s "Peran" section is explicit — "Tiga peran sebagai himpunan, bukan
 * tingkatan tunggal" — and `isAllowed` below has no inheritance in it, so a role that is not named
 * on an action does not hold it, whatever else that role can do.
 *
 * `CONTEXT.md` then says which set this action belongs to. Admin is "peran pengurus harian", and the
 * very first thing it lists is "mengelola Post". Superuser is "peran yang memegang setiap tindakan
 * yang mengubah masa lalu atau mengubah siapa boleh apa", and its list — residents and roles, Unit
 * and Masa Huni, Tarif, Pembebasan, cancelling a Tagihan, unlocking a Periode — does not contain
 * Post, because writing an announcement changes nothing that already happened and nobody's rights.
 * The three actions above all do fall under that sentence, which is why they read the way they do.
 *
 * So a superuser who is not also an admin cannot write a Post. That is the intended reading of a set
 * rather than a rank, and it costs nothing to undo: whoever needs both grants both roles, which is
 * what `user_roles` is for. The binding acceptance criterion — that `resident` cannot call a single
 * write operation on a Post — holds either way, and it holds here because `resident` is not named.
 */
const PERMISSIONS: Readonly<Record<Action, ReadonlySet<Role>>> = {
	[ACTION.manageRoles]: new Set([ROLE.superuser]),
	[ACTION.manageJobs]: new Set([ROLE.superuser]),
	[ACTION.manageUnits]: new Set([ROLE.superuser]),
	[ACTION.managePosts]: new Set([ROLE.admin])
};

/**
 * Whether any role in `roles` permits `action`, decided purely from the table above — no database
 * access, so a test can walk every combination of role and action without a connection.
 */
export function isAllowed(roles: Iterable<Role>, action: Action): boolean {
	const permitted = PERMISSIONS[action];
	for (const role of roles) {
		if (permitted.has(role)) {
			return true;
		}
	}
	return false;
}

/** Every role `userId` currently holds, read from `user_roles`. */
export async function rolesOf(db: DatabaseWriter, userId: string): Promise<ReadonlySet<Role>> {
	const rows = await db
		.select({ role: userRoles.role })
		.from(userRoles)
		.where(eq(userRoles.userId, userId));
	return new Set(rows.map((row) => row.role));
}

/**
 * Reads `callerId`'s roles and throws when none of them permit `action`.
 *
 * Every mutating function in this application's service layer starts with this call, given the
 * identity of whoever is asking — a service that skips it is not deciding permission anywhere, and
 * one that checks a role by hand instead of calling this is deciding it in a second place.
 *
 * @throws {PermissionDeniedError} naming `callerId` and `action`, when the caller's roles do not
 *   include one this action permits. A route catches this and answers with `error(403, …)` — see
 *   `src/lib/errors.ts`.
 */
export async function requirePermission(
	db: DatabaseWriter,
	callerId: string,
	action: Action
): Promise<void> {
	const roles = await rolesOf(db, callerId);
	if (!isAllowed(roles, action)) {
		throw new PermissionDeniedError(callerId, action);
	}
}
