import { createHmac, timingSafeEqual } from 'node:crypto';
import { readAuthSecret } from '../../auth';

/**
 * The one-click unsubscribe token: what an email's "berhenti berlangganan" link carries, and the
 * only thing that authorizes switching one Langganan off for someone who has no session.
 *
 * ## Why the token holds no state
 *
 * A link that works out of an inbox has to identify a resident and a notification kind without a
 * cookie. The obvious shape — a random token stored in a table — needs a migration and a row per
 * email, and this ticket has neither a migration nor a new secret to spend. A token whose whole
 * content is signed needs no storage at all: the resident and the kind travel inside it, and the
 * signature is what nobody without the key can produce. The same argument, and very nearly the same
 * code, as `buildSignedLink`/`verifySignedLink` in `../../ports/file-store.ts`.
 *
 * Decisions settled here:
 *
 * 1. **The key is derived from `BETTER_AUTH_SECRET`, never used raw.** Of the two secrets this
 *    application already has, `BETTER_AUTH_SECRET` is the one that signs every token authorizing an
 *    action on an *account* without a session — the verification link and the password reset link
 *    both come out of it (see `../../auth.ts`). An unsubscribe link is exactly that kind of token,
 *    so it belongs to the same secret. `FILE_STORE_SECRET` was rejected because it is a property of
 *    wherever uploaded bytes live: moving the file store to S3 is a perfectly ordinary reason to
 *    rotate it, and that has nothing to do with whether the links already sitting in two hundred
 *    inboxes should keep working.
 * 2. **Domain separation, so this key is not that key.** The signing key is
 *    `HMAC-SHA256(BETTER_AUTH_SECRET, "<label>")` rather than the secret itself — the extract step
 *    of HKDF, with a label naming this use and its version. A signature produced here is therefore
 *    worthless anywhere else that signs with `BETTER_AUTH_SECRET`, and a signature produced there
 *    is worthless here, even though there is one secret in `.env`. Bumping the label's version is
 *    also how every outstanding token would be invalidated, if that were ever needed.
 * 3. **Both the resident and the kind are inside the signed message.** Signing only the resident
 *    would let the holder of their own link edit which kind it switches off; signing only the kind
 *    would let one link point at any resident. The message is `<residentId>\n<kind>`, and `\n`
 *    cannot occur in either half — both are checked when the token is built — so no pair of values
 *    can be rearranged into another pair's message.
 * 4. **The signature is compared with `timingSafeEqual`.** A `===` over two strings returns as soon
 *    as it finds a difference, which leaks how many leading bytes of a guess were right; enough
 *    guesses recover a valid signature without ever learning the key. Lengths are compared first,
 *    because `timingSafeEqual` throws on buffers of different lengths and a length is not a secret.
 * 5. **The signature covers the encoded subject, not the decoded values.** Base64url has more than
 *    one encoding for the same bytes, so a token whose subject was re-padded or re-cased would
 *    decode to the same resident. Signing the text that actually travels means any such variant is
 *    a different message and is refused, rather than quietly being a second token for one resident.
 * 6. **No expiry, and no revocation.** Both are deliberate. An unsubscribe link has to work the day
 *    a resident finally gets round to clicking it, however long that is, and an expired one would
 *    send them to a page telling them to sign in — which is the whole thing this link exists to
 *    avoid. Nothing needs revoking either, because replaying a token is idempotent: it disables the
 *    same kind for the same resident a second time, which is already true, and it can never enable
 *    anything. The worst a leaked link does is stop one person's monthly report email — which that
 *    person can turn back on from `/profile/notifications`.
 *
 * The verifier answers a verdict rather than throwing, the shape `verifySignedLink` already uses:
 * telling a malformed token apart from a forged one is useful in a log and must never be shown to
 * whoever is holding it.
 */

/**
 * The label that separates this key from every other use of `BETTER_AUTH_SECRET`. It carries a
 * version so that a later change of token shape can be made to invalidate the old ones on purpose.
 */
const KEY_DERIVATION_LABEL = 'komplek/unsubscribe-token/v1';

/** What separates the two halves of the signed message. Neither half may contain it. */
const MESSAGE_SEPARATOR = '\n';

/** What separates the subject from its signature inside the token. Base64url never contains it. */
const TOKEN_SEPARATOR = '.';

/** The path the unsubscribe page is served at, so a link and its route cannot drift apart. */
export const UNSUBSCRIBE_BASE_PATH = '/unsubscribe';

/** Why a token was refused. Useful in a log; never shown to whoever presented the token. */
export type UnsubscribeTokenRejection = 'malformed' | 'signature';

/** The verdict on a token. */
export type UnsubscribeTokenVerification =
	| { readonly valid: true; readonly residentId: string; readonly kind: string }
	| { readonly valid: false; readonly reason: UnsubscribeTokenRejection };

/** Which resident is being unsubscribed from which kind. */
export interface UnsubscribeSubject {
	/** A `residents.id`. */
	readonly residentId: string;
	/** A notification kind, as `./kinds.ts` names it. */
	readonly kind: string;
}

/**
 * Builds the token an unsubscribe link carries.
 *
 * @param secret the raw `BETTER_AUTH_SECRET`; the signing key is derived from it here.
 * @throws {TypeError} when either value is blank or contains the message separator, which would
 *   make one pair of values indistinguishable from another.
 */
export function buildUnsubscribeToken(
	subject: UnsubscribeSubject,
	secret: string = unsubscribeTokenSecret()
): string {
	assertSignable(subject.residentId, 'residentId');
	assertSignable(subject.kind, 'kind');
	const encoded = encodeSubject(subject);
	return `${encoded}${TOKEN_SEPARATOR}${sign(encoded, secret)}`;
}

/**
 * Checks a token against the secret, and answers who it is for.
 *
 * @param secret the raw `BETTER_AUTH_SECRET`, exactly as `buildUnsubscribeToken` was given it.
 */
export function verifyUnsubscribeToken(
	token: string,
	secret: string = unsubscribeTokenSecret()
): UnsubscribeTokenVerification {
	const parts = token.split(TOKEN_SEPARATOR);
	if (parts.length !== 2) {
		return { valid: false, reason: 'malformed' };
	}
	const [encoded, signature] = parts;
	if (encoded === '' || signature === '') {
		return { valid: false, reason: 'malformed' };
	}
	if (!signaturesMatch(sign(encoded, secret), signature)) {
		return { valid: false, reason: 'signature' };
	}
	const subject = decodeSubject(encoded);
	if (!subject) {
		// Unreachable in practice: a subject that does not decode could not have been signed by this
		// key. It is refused rather than trusted, because the alternative is reading a resident id
		// out of bytes nothing ever put there.
		return { valid: false, reason: 'malformed' };
	}
	return { valid: true, residentId: subject.residentId, kind: subject.kind };
}

/** The absolute address of the unsubscribe page for one resident and one kind. */
export function unsubscribeLink(
	origin: string,
	subject: UnsubscribeSubject,
	secret: string = unsubscribeTokenSecret()
): string {
	return `${origin.replace(/\/+$/, '')}${UNSUBSCRIBE_BASE_PATH}/${buildUnsubscribeToken(subject, secret)}`;
}

/**
 * The secret unsubscribe tokens are signed with, read the same way every other part of this
 * application reads it — including its minimum length, which a forgeable token depends on.
 */
export function unsubscribeTokenSecret(environment: NodeJS.ProcessEnv = process.env): string {
	return readAuthSecret(environment);
}

/** The signing key: `BETTER_AUTH_SECRET` put through one HMAC under this module's own label. */
function derivedKey(secret: string): Buffer {
	return createHmac('sha256', secret).update(KEY_DERIVATION_LABEL).digest();
}

/** The signature over the encoded subject — the one part of a token nobody else can produce. */
function sign(encodedSubject: string, secret: string): string {
	return createHmac('sha256', derivedKey(secret)).update(encodedSubject).digest('base64url');
}

/** The subject as the text that travels in the link. */
function encodeSubject(subject: UnsubscribeSubject): string {
	return Buffer.from(`${subject.residentId}${MESSAGE_SEPARATOR}${subject.kind}`, 'utf8').toString(
		'base64url'
	);
}

/** The subject back out of the token, or `undefined` when those bytes are not one. */
function decodeSubject(encoded: string): UnsubscribeSubject | undefined {
	const message = Buffer.from(encoded, 'base64url').toString('utf8');
	const parts = message.split(MESSAGE_SEPARATOR);
	if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
		return undefined;
	}
	return { residentId: parts[0], kind: parts[1] };
}

/**
 * Compares two signatures without leaking, through how long the comparison took, how many leading
 * bytes of the candidate were right.
 */
function signaturesMatch(expected: string, candidate: string): boolean {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const candidateBytes = Buffer.from(candidate, 'utf8');
	if (expectedBytes.length !== candidateBytes.length) {
		return false;
	}
	return timingSafeEqual(expectedBytes, candidateBytes);
}

/**
 * Checks one half of the message before it is signed.
 *
 * @throws {TypeError} naming the half, because a blank or separator-carrying value is a mistake in
 *   calling code rather than something a resident should read a sentence about.
 */
function assertSignable(value: string, name: string): void {
	if (value.trim() === '' || value.includes(MESSAGE_SEPARATOR)) {
		throw new TypeError(
			`An unsubscribe token's ${name} must not be blank and must not contain a line break; received "${value}".`
		);
	}
}
