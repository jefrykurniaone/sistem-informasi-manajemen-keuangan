import { createHash, randomBytes } from 'node:crypto';

/**
 * The invitation token: the secret in the link, and the digest of it the database keeps.
 *
 * Two functions and nothing else, because everything about the token that needs deciding is decided
 * here, once:
 *
 * - **256 bits from `crypto.randomBytes`, never `Math.random`.** The token is the whole credential —
 *   whoever presents it becomes a resident of the invited house — so it has to be impossible to
 *   guess, not merely unlikely. 2^256 is beyond enumeration whatever the request rate; the schema in
 *   `src/lib/server/db/schema/invitation.ts` asks for exactly this source.
 * - **base64url, so the token survives being a URL.** No `+`, `/` or `=` to be mangled by an email
 *   client or double-encoded by a proxy: the 43 characters that come out are already URL-safe and go
 *   into the link as they are.
 * - **The database sees only the SHA-256 digest.** `hashInvitationToken` is what the service stores
 *   and what it looks a presented token up by, so a copy of the table, a backup or a log line is not
 *   a set of working links. The digest is unsalted on purpose — the schema records why: this is a
 *   256-bit random value, not a human secret, so there is nothing to guess, and the lookup "find the
 *   row for this token" needs one deterministic digest per token. Equality is decided by the
 *   database's unique index on the digest, never by comparing a user-supplied string against a
 *   stored one in application code.
 */

/** How many random bytes a token is drawn from: 32, which is 256 bits. */
export const INVITATION_TOKEN_BYTES = 32;

/** Draws a fresh invitation token: 256 random bits, base64url-encoded, URL-safe as it stands. */
export function createInvitationToken(): string {
	return randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
}

/**
 * The SHA-256 digest of a token, hex-encoded — the only form of the token the database ever holds,
 * and the value every lookup is keyed by.
 */
export function hashInvitationToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}
