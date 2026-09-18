import { eq } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import type { Database } from '../../db';
import type { DatabaseWriter } from '../../authz';
import { user } from '../../db/schema/auth';
import { residents } from '../../db/schema/resident';
import type { Clock } from '../../ports/clock';

/**
 * A resident reading and correcting their own name and phone number — `spec-warga-unit-v1.md`'s
 * "Sebagai warga, saya ingin melihat dan memperbaiki data diri saya sendiri".
 *
 * **The name lives on `user`, the phone number on `residents`.** `src/lib/server/db/schema/resident.ts`
 * settled this: better-auth owns `user.name`, and copying it onto `residents` would be a second
 * answer to the same question. Correcting a name here therefore writes the `user` row directly, not
 * through better-auth's own API — this module is not a sign-up flow — and stamps `user.updatedAt`
 * itself, because that column has no database default; see `src/lib/server/db/schema/auth.ts`.
 *
 * **The guard is row ownership, not a `PERMISSIONS` action**, for the same reason
 * `src/lib/server/services/subscription/index.ts` gives: every resident may correct their own row,
 * and none may touch another's. `assertOwnResident` throws `PermissionDeniedError`, the same class
 * `requirePermission` throws, so a route still answers with `error(403, …)` for it.
 *
 * **A signed-in account with no `residents` row is an expected state, not a bug.** Nothing in this
 * ticket's `writes:` creates that row — see the ticket body's own note that `residents` is only
 * populated by #20 (undangan) and #21 (persetujuan pendaftaran), neither landed yet. Every function
 * here that looks a resident up by `userId` therefore returns `undefined` rather than throwing, and
 * the route decides what a resident with no row sees.
 */

/** What a resident sees and can edit about themself. */
export interface ResidentProfile {
	readonly residentId: string;
	readonly name: string;
	readonly phone: string | null;
}

/** `userId`'s resident profile, or `undefined` when this account has no `residents` row yet. */
export async function residentProfileForUser(
	db: DatabaseWriter,
	userId: string
): Promise<ResidentProfile | undefined> {
	const [row] = await db
		.select({ residentId: residents.id, name: user.name, phone: residents.phone })
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.where(eq(residents.userId, userId))
		.limit(1);
	return row;
}

/** Who is asking, and what they are asking to change it to. */
export interface UpdateOwnProfileRequest {
	/** The signed-in account making the request. Checked against `residentId`'s owner before anything else. */
	readonly callerUserId: string;
	readonly residentId: string;
	readonly name: string;
	/** `null` clears the phone number. */
	readonly phone: string | null;
}

/**
 * Updates `residentId`'s name and phone number.
 *
 * @throws {PermissionDeniedError} when `callerUserId` does not own the `residents` row `residentId`
 *   names.
 */
export async function updateOwnProfile(
	db: Database,
	clock: Clock,
	request: UpdateOwnProfileRequest
): Promise<void> {
	await db.transaction(async (transaction) => {
		const [row] = await transaction
			.select({ userId: residents.userId })
			.from(residents)
			.where(eq(residents.id, request.residentId))
			.limit(1);
		if (!row || row.userId !== request.callerUserId) {
			throw new PermissionDeniedError(request.callerUserId, 'residents.updateOwnProfile');
		}

		await transaction
			.update(user)
			.set({ name: request.name, updatedAt: clock.now() })
			.where(eq(user.id, request.callerUserId));

		await transaction
			.update(residents)
			.set({ phone: request.phone })
			.where(eq(residents.id, request.residentId));
	});
}
