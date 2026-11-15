/**
 * Errors the service layer throws that a route has to translate into something other than a
 * generic 500 — see `spec-fondasi-v1.md`'s success criterion that a page a resident has no right
 * to see answers with something readable, not an empty page or a crash.
 *
 * Every class below is a named, `instanceof`-checkable error, on purpose: a route tells one apart
 * from "something broke" by catching the specific class, not by pattern-matching a message string
 * that a later rewording would quietly break.
 *
 * ## How a domain error says how it is refused (#318)
 *
 * A route answers a refused request in one of three ways, and `ERROR_CATEGORY` names them. Which
 * one a given error gets is a fact about the error, so the error states it, and
 * `src/lib/server/route-action.ts` turns that statement into the route's answer:
 *
 * - **forbidden** is `PermissionDeniedError` and nothing else. Authorisation is decided in one
 *   place, `requirePermission` in `src/lib/server/authz.ts`, so there is no base class for a second
 *   kind of refusal by role.
 * - **notFound** is an error that extends `NotFoundError`: the request names something that does
 *   not exist, or an identifier that cannot name anything.
 * - **rule** is an error that extends `RuleViolationError`: the caller may do this kind of thing,
 *   and this particular request breaks a domain rule.
 *
 * An error class written before these two base classes existed extends `Error` directly. Those
 * classes are listed in `src/lib/server/route-action.ts` instead, which is the "registration in this
 * module" the ticket allows; a new error class extends one of the base classes here and needs no
 * entry anywhere. An error that is neither is a bug, and a route rethrows it rather than dressing it
 * up as a refusal.
 */

/** The three ways a route answers a refused request. See this module's doc comment. */
export const ERROR_CATEGORY = {
	/** A 403 page with the route's sentence. */
	forbidden: 'forbidden',
	/** A 404 page with the route's sentence, or the form's sentence when the form named it. */
	notFound: 'notFound',
	/** `fail(400)` with the form's sentence. */
	rule: 'rule'
} as const;

/** One of the categories above. */
export type ErrorCategory = (typeof ERROR_CATEGORY)[keyof typeof ERROR_CATEGORY];

/**
 * The base of every error meaning "the request names something that does not exist": a row id
 * nobody used, a token this application never issued, an identifier with a shape no row can have.
 * A route answers it with a 404 page, unless the form named the class and asked for its own
 * sentence instead. Abstract, because a route still tells one missing thing from another by its own
 * class.
 */
export abstract class NotFoundError extends Error {}

/**
 * The base of every error meaning "the caller may do this kind of thing, and this request breaks a
 * domain rule": a locked Periode, a name already taken, a reason left empty. A route answers it as
 * a rejected form, `fail(400, …)`, never as a 403. Abstract, for the reason `NotFoundError` is.
 */
export abstract class RuleViolationError extends Error {}

/**
 * Thrown by `requirePermission` in `src/lib/server/authz.ts` when the caller does not hold a role
 * that permits the action they asked for.
 *
 * A route that lets this escape uncaught gets SvelteKit's generic 500 page, because SvelteKit only
 * renders a chosen status for its own `HttpError` (built by `error()` from `@sveltejs/kit`).
 * Translating the refusal is the route's job, never the service's, exactly as
 * `spec-fondasi-v1.md`'s "Peran" section asks, and since #318 a route does it through
 * `src/lib/server/route-action.ts`, which answers this class with `error(403, …)` before it looks at
 * anything a route named, so no route can turn it into anything softer.
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
 * refuses. That is the definition of `RuleViolationError`, which this class extends.
 */
export class LastSuperuserError extends RuleViolationError {
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
