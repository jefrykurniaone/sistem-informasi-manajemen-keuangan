import { eq } from 'drizzle-orm';
import { recordAuditEntry } from '../../audit';
import { rolesOf } from '../../authz';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { ROLE, userRoles } from '../../db/schema/authz';
import type { Clock } from '../../ports/clock';
import { ROLE_CHANGE_ACTION } from './roles';

/**
 * The one way the first `superuser` comes into being.
 *
 * ## Why this module exists at all
 *
 * The authorization boundary closes over itself. `user_created_gets_resident_role_trigger` gives
 * every new `user` row the `resident` role and nothing more, and the only way to add a role —
 * `grantRole` in `./roles.ts` — begins with `requirePermission(…, ACTION.manageRoles)`, which
 * `src/lib/server/authz.ts` grants to `superuser` alone. On a freshly migrated database nobody holds
 * that role, so nobody can grant it, and `/admin/roles` answers 403 to everyone who opens it.
 *
 * This module is the way out, and it is deliberately **not** an exception inside the permission
 * table. Adding an entry to `PERMISSIONS` that let some other role manage roles would widen the
 * boundary permanently for every caller, including every HTTP one, to solve a problem that happens
 * exactly once per installation. The narrower answer is one function that is not reachable over
 * HTTP at all.
 *
 * ## Why it writes `user_roles` itself rather than calling `grantRole`
 *
 * `grantRole` cannot be used here by construction: it needs an `actorId` who already holds
 * `ACTION.manageRoles`, and the whole point of this module is the moment when no such person
 * exists. So this is the second writer of `user_roles` outside the trigger — the comment at the top
 * of `./roles.ts` was written when it was the only one — and it stays honest about being a
 * privileged path by taking no actor at all. **A function that takes no actor must never be called
 * from a route, a form action or an endpoint**, because there would be nobody to check; the only
 * caller is `scripts/grant-superuser.ts`, run from a shell on the machine that holds
 * `DATABASE_URL`.
 *
 * ## The audit row
 *
 * The first role change in a system's life is the one most worth recording, so this path leaves the
 * same `role_change` row every other role change leaves, written inside the same transaction as the
 * role itself — the rule `src/lib/server/audit.ts` states, so the row exists if and only if the
 * change did. It reuses `ROLE_CHANGE_ACTION` rather than inventing a second action name, so that a
 * reader asking "who ever changed a role" finds this one with the same query as all the others.
 */

/**
 * The `audit_log.actor_id` written for a change that came from an operator at a shell rather than
 * from a signed-in person.
 *
 * `audit_log.actor_id` is plain `text` with no foreign key to `user.id` — the decision recorded in
 * `src/lib/server/db/schema/audit.ts`, taken so that a historical row keeps meaning something when
 * the account it names is gone. That is what makes a value which is not an account id storable here
 * in the first place; this is not a column being abused.
 *
 * The value cannot collide with a real account. better-auth draws its identifiers from `a-zA-Z0-9`
 * (see `src/lib/server/db/schema/auth.ts`), and `src/lib/server/services/invitation/index.ts`
 * generates its own the same way, so no `user.id` ever contains a colon and nobody reading the
 * audit log by user id can match this row by accident.
 *
 * Writing the target's own id instead was rejected: it would record that the person granted
 * themselves the role, which is false, and the one change in the system that had no human actor is
 * precisely the one a reader most needs to be able to tell apart from the rest. `system:` is a
 * namespace rather than a name, so a later machine-driven change writes `system:<what>` here
 * instead of inventing a second convention.
 */
export const MACHINE_OPERATOR_ACTOR_ID = 'system:bootstrap';

/** What happened, in the three shapes the command has to report differently. */
export type BootstrapSuperuserOutcome =
	/** The role was added, and one audit row was written. */
	| { readonly kind: 'granted'; readonly email: string; readonly userId: string }
	/** The account already held `superuser`. Nothing was written, including no audit row. */
	| { readonly kind: 'alreadySuperuser'; readonly email: string; readonly userId: string }
	/** No account is registered with that address. Nothing was written. */
	| { readonly kind: 'noSuchUser'; readonly email: string };

/**
 * Grants `superuser` to the account registered with `email`, with no permission check and no actor.
 *
 * Running it twice is the normal case, not an error: an operator who is unsure whether the first
 * run took effect must be able to run it again. Idempotence rests on the
 * `user_roles_user_id_role_unique` index rather than on reading first and inserting after — two
 * runs at once would both pass a read-then-insert check, and one of them would then write a second
 * audit row for a role change that did not happen. The insert below does nothing on conflict, and
 * the audit row is written only when the insert really inserted, so the second run reports
 * `alreadySuperuser` and leaves both tables exactly as the first run left them.
 *
 * Running it on a system that already has a superuser grants a second one, and that is deliberate.
 * Refusing would buy no safety — whoever can run this already reaches the database directly — while
 * removing the only way back when the sole superuser account is lost, which is the situation this
 * command exists for. More than one superuser is a state the rest of the application already
 * expects; `revokeRole`'s last-superuser rule is written around it.
 *
 * @param email the address as the operator typed it. Trimmed and lower-cased before the lookup, the
 *   same normalization better-auth applies at sign-up — see `normalizeRecipients` in
 *   `src/lib/server/services/invitation/index.ts` — so the address that reached the sign-up form is
 *   the address that matches here whatever case it is typed in.
 */
export async function bootstrapSuperuser(
	db: Database,
	clock: Clock,
	email: string
): Promise<BootstrapSuperuserOutcome> {
	const address = email.trim().toLowerCase();

	return db.transaction(async (transaction): Promise<BootstrapSuperuserOutcome> => {
		const [account] = await transaction
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, address))
			.limit(1);
		if (!account) {
			return { kind: 'noSuchUser', email: address };
		}

		const before = await rolesOf(transaction, account.id);

		const inserted = await transaction
			.insert(userRoles)
			.values({ userId: account.id, role: ROLE.superuser, createdAt: clock.now() })
			.onConflictDoNothing({ target: [userRoles.userId, userRoles.role] })
			.returning({ id: userRoles.id });
		if (inserted.length === 0) {
			return { kind: 'alreadySuperuser', email: address, userId: account.id };
		}

		await recordAuditEntry(transaction, clock, {
			actorId: MACHINE_OPERATOR_ACTOR_ID,
			action: ROLE_CHANGE_ACTION,
			targetId: account.id,
			before: [...before],
			after: [...before, ROLE.superuser]
		});

		return { kind: 'granted', email: address, userId: account.id };
	});
}
