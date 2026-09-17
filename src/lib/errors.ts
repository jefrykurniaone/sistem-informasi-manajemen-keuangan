/**
 * Errors the service layer throws that a route has to translate into something other than a
 * generic 500 — see `spec-fondasi-v1.md`'s success criterion that a page a resident has no right
 * to see answers with something readable, not an empty page or a crash.
 *
 * Both classes below are named, `instanceof`-checkable errors, on purpose: a route tells one apart
 * from "something broke" by catching the specific class, not by pattern-matching a message string
 * that a later rewording would quietly break.
 */

/**
 * Thrown by `requirePermission` in `src/lib/server/authz.ts` when the caller does not hold a role
 * that permits the action they asked for.
 *
 * A route that lets this escape uncaught gets SvelteKit's generic 500 page, because SvelteKit only
 * renders a chosen status for its own `HttpError` (built by `error()` from `@sveltejs/kit`). Every
 * route that calls into a service therefore has to catch this and call `error(403, …)` itself —
 * translating the refusal is the route's job, never the service's, exactly as
 * `spec-fondasi-v1.md`'s "Peran" section asks.
 */
export class PermissionDeniedError extends Error {
	override readonly name = 'PermissionDeniedError';

	/** The user who was refused. */
	readonly callerId: string;

	/** The action they were refused, one of `src/lib/server/authz.ts`'s `Action` values. */
	readonly action: string;

	constructor(callerId: string, action: string) {
		super(`User "${callerId}" does not hold a role that permits "${action}".`);
		this.callerId = callerId;
		this.action = action;
	}
}

/**
 * Thrown by `revokeRole` in `src/lib/server/services/user/roles.ts` when a change would leave the
 * system with no `superuser` at all.
 *
 * Unlike `PermissionDeniedError`, the caller here *is* allowed to manage roles — the guard already
 * let them through — so a route answers this as a rejected form submission (`fail(400, …)`), not
 * as a 403: the actor did nothing outside their rights, the specific change is what the system
 * refuses.
 */
export class LastSuperuserError extends Error {
	override readonly name = 'LastSuperuserError';

	/** The user whose `superuser` role could not be revoked. */
	readonly targetUserId: string;

	constructor(targetUserId: string) {
		super(
			`Cannot revoke the "superuser" role from user "${targetUserId}": the system would be left with no superuser at all.`
		);
		this.targetUserId = targetUserId;
	}
}
