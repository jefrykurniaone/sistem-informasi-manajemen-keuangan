import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `FileStore` — the port that keeps uploaded files, and the definition of what a signed link is.
 *
 * Decisions settled here and used by every later spec:
 *
 * 1. **Three operations: store, signed link, delete.** Reading bytes back is deliberately not one
 *    of them. A cloud store's signed link is served by the cloud and never passes through this
 *    application, so `read` would be a method two thirds of the implementations only have because
 *    the local one needs it. Stores whose links point back at this application implement
 *    `ServedFileStore` instead, which adds exactly the two operations the route serving those
 *    links needs.
 * 2. **The caller chooses the key.** A domain module knows that a payment's proof belongs at
 *    `payments/<paymentId>/proof.jpg`, and a key it can rebuild is a key it can delete without
 *    storing anything extra. The price is that a caller can collide with itself, so keys carry an
 *    identifier, and `store` overwrites rather than failing — a retried upload must not leave two
 *    half-written files behind.
 * 3. **Every key is validated, at the port rather than in one implementation.** A key is a
 *    caller-supplied string that becomes part of a filesystem path and part of a URL. It is
 *    restricted to a charset that cannot escape either: no backslash, no `..`, no leading slash,
 *    no empty segment. `LocalFileStore` checks the resolved path against its root as well, which
 *    is the same rule enforced a second time at the layer where getting it wrong hands out
 *    `/etc/passwd`.
 * 4. **A signed link covers both the key and the expiry.** The signature is
 *    `HMAC-SHA256(secret, "<key>\n<expiry in epoch seconds>")`. Signing only the key would give
 *    out a link that never expires, because the expiry would be a number the recipient may edit;
 *    signing only the expiry would let one link be repointed at another resident's file. Both
 *    values are in the signed message, and the expiry is compared as an absolute instant read
 *    from the injected `Clock`, never from `Date.now()`, so that a test can prove an expired link
 *    is refused by moving a fake clock rather than by waiting.
 * 5. **The signature is compared with `timingSafeEqual`.** A `===` on two strings returns as soon
 *    as it finds a difference, which measurably leaks how many leading bytes of a guess were
 *    right; enough guesses recover a valid signature without ever knowing the secret.
 * 6. **The secret comes from `FILE_STORE_SECRET`, and stays server-side.** This module lives
 *    under `src/lib/server/`, which SvelteKit refuses to import into client code, so the secret
 *    cannot reach a browser bundle by accident.
 * 7. **Every operation is asynchronous, including `signedLink`.** Signing an HMAC needs no `await`
 *    at all, but an S3-compatible adapter's presigning does, and a port that has to change from
 *    synchronous to asynchronous later changes every call site in five specs. The `await` is paid
 *    once now instead.
 *
 * The real implementation is `LocalFileStore` in `../storage/local-file-store.ts`. The fake is
 * `FakeFileStore` in `./fakes.ts`; it keeps bytes in a `Map` and signs links with the same
 * functions below, so a link that a test mints behaves exactly like one from the real store.
 */

/** Keeps uploaded files. */
export interface FileStore {
	/**
	 * Writes `content` at `key`, replacing whatever was there.
	 *
	 * @throws {TypeError} when the key is not a valid storage key.
	 */
	store(key: string, content: Uint8Array): Promise<void>;

	/**
	 * Builds a link that gives its holder the file at `key` until it expires. The link is a bearer
	 * credential: anyone who has it can read that one file until then, so it belongs in a page a
	 * recipient already reached through a permission check, and never in a log.
	 *
	 * @param expiresInMilliseconds how long the link stays valid, counted from the store's clock.
	 * @throws {TypeError} when the key is not a valid storage key, or the lifetime is not positive.
	 */
	signedLink(key: string, expiresInMilliseconds?: number): Promise<string>;

	/**
	 * Removes the file at `key`. Removing a key that is not there is not an error: the caller's
	 * intent is that the file is gone, and it is.
	 *
	 * @throws {TypeError} when the key is not a valid storage key.
	 */
	delete(key: string): Promise<void>;
}

/**
 * A store whose signed links point back at this application, and which therefore also has to
 * answer the request those links make. A cloud store does not implement this: its links are
 * verified and served by the cloud.
 */
export interface ServedFileStore extends FileStore {
	/** The bytes at `key`, or `undefined` when there is no such file. */
	read(key: string): Promise<Uint8Array | undefined>;

	/**
	 * Checks a link produced by `signedLink`.
	 *
	 * @param link the path and query of the incoming request, exactly as `signedLink` produced it.
	 */
	verifySignedLink(link: string): FileLinkVerification;
}

/** Why a signed link was refused. Useful in a log; never show it to the holder of the link. */
export type FileLinkRejection = 'malformed' | 'signature' | 'expired';

/** The verdict on a signed link. */
export type FileLinkVerification =
	| { readonly valid: true; readonly key: string; readonly expiresAt: Date }
	| { readonly valid: false; readonly reason: FileLinkRejection };

/** The path every signed link of a locally served store starts with. */
export const SIGNED_LINK_BASE_PATH = '/files';

/** The query parameter carrying the expiry, in epoch seconds. */
const EXPIRES_PARAMETER = 'expires';

/** The query parameter carrying the signature. */
const SIGNATURE_PARAMETER = 'signature';

/**
 * How long a signed link lasts when the caller does not say. Ten minutes is long enough to open a
 * page and click through to the file, and short enough that a link pasted into a chat group is
 * dead by the time anyone else reads it.
 */
export const DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS = 10 * 60 * 1000;

/** The shortest secret that may sign a link: 32 characters, the length of a 256-bit random value. */
export const MINIMUM_FILE_STORE_SECRET_LENGTH = 32;

/** The longest a storage key may be, so that it stays inside every filesystem's path limit. */
const MAXIMUM_KEY_LENGTH = 255;

/**
 * The shape of a valid storage key: it starts with a letter or a digit, and continues with
 * letters, digits, dot, dash, underscore and the forward slash that separates its segments. The
 * character class has no nesting and no optional group, so there is nothing for a regular
 * expression engine to backtrack over.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The shape of the expiry parameter: digits only, and few enough to fit a `number` exactly. */
const EPOCH_SECONDS_PATTERN = /^[0-9]{1,15}$/;

/**
 * The origin a link is resolved against while it is parsed. A signed link is a path and a query
 * with no origin of its own, and `URL` needs one; a link that arrives carrying a different origin
 * is refused rather than trusted.
 */
const PARSING_ORIGIN = 'https://file-store.invalid';

/** Milliseconds in a second, for converting between an instant and the expiry in a link. */
const MILLISECONDS_PER_SECOND = 1000;

/** Whether `key` is a storage key this application will accept. */
export function isStorageKey(key: string): boolean {
	return (
		key.length > 0 &&
		key.length <= MAXIMUM_KEY_LENGTH &&
		KEY_PATTERN.test(key) &&
		!key.includes('..') &&
		!key.includes('//') &&
		!key.endsWith('/')
	);
}

/**
 * Checks a storage key before it becomes part of a path or a URL.
 *
 * @throws {TypeError} naming the key, because a key that does not have this shape is a mistake in
 *   the calling code or an attempt to walk out of the storage root, and neither should be
 *   answered with a file.
 */
export function assertStorageKey(key: string): void {
	if (!isStorageKey(key)) {
		throw new TypeError(
			`"${key}" is not a valid storage key. A key starts with a letter or a digit, contains only letters, digits, ".", "-", "_" and "/" as a separator, has no ".." or empty segment, and is at most ${MAXIMUM_KEY_LENGTH} characters long.`
		);
	}
}

/**
 * Builds the path and query of a signed link.
 *
 * @param expiresAt the instant the link stops working, kept to whole seconds because that is what
 *   the link carries and what the signature therefore covers.
 */
export function buildSignedLink(options: {
	readonly key: string;
	readonly expiresAt: Date;
	readonly secret: string;
}): string {
	assertStorageKey(options.key);
	const expiresAtSeconds = toEpochSeconds(options.expiresAt);
	const signature = signLink(options.key, expiresAtSeconds, options.secret);
	const query = new URLSearchParams({
		[EXPIRES_PARAMETER]: String(expiresAtSeconds),
		[SIGNATURE_PARAMETER]: signature
	});
	// The key needs no percent-encoding: every character a key may contain is already safe in a
	// URL path, which is exactly why the key charset is as narrow as it is.
	return `${SIGNED_LINK_BASE_PATH}/${options.key}?${query.toString()}`;
}

/**
 * Checks a signed link against a secret and an instant.
 *
 * The signature is checked before the expiry on purpose. Reporting "expired" for a link whose
 * signature does not match would tell whoever edited the expiry that the rest of their link was
 * otherwise acceptable.
 */
export function verifySignedLink(options: {
	readonly link: string;
	readonly secret: string;
	readonly now: Date;
}): FileLinkVerification {
	const parts = parseSignedLink(options.link);
	if (!parts) {
		return { valid: false, reason: 'malformed' };
	}
	const expected = signLink(parts.key, parts.expiresAtSeconds, options.secret);
	if (!signaturesMatch(expected, parts.signature)) {
		return { valid: false, reason: 'signature' };
	}
	const expiresAt = new Date(parts.expiresAtSeconds * MILLISECONDS_PER_SECOND);
	if (expiresAt.getTime() <= options.now.getTime()) {
		return { valid: false, reason: 'expired' };
	}
	return { valid: true, key: parts.key, expiresAt };
}

/** The three values a signed link carries, once it has been taken apart and checked for shape. */
interface SignedLinkParts {
	readonly key: string;
	readonly expiresAtSeconds: number;
	readonly signature: string;
}

/** Takes a link apart, or returns `undefined` when it is not shaped like one of ours. */
function parseSignedLink(link: string): SignedLinkParts | undefined {
	const url = parseUrl(link);
	if (!url || url.origin !== PARSING_ORIGIN) {
		return undefined;
	}
	const prefix = `${SIGNED_LINK_BASE_PATH}/`;
	if (!url.pathname.startsWith(prefix)) {
		return undefined;
	}
	// Taken verbatim, not percent-decoded: a valid key never needs encoding, so anything that
	// arrives encoded — `%2e%2e%2f` for `../` being the interesting one — keeps its percent signs
	// here and is refused by the key check below.
	const key = url.pathname.slice(prefix.length);
	const expires = url.searchParams.get(EXPIRES_PARAMETER) ?? '';
	const signature = url.searchParams.get(SIGNATURE_PARAMETER) ?? '';
	if (!isStorageKey(key) || !EPOCH_SECONDS_PATTERN.test(expires) || signature === '') {
		return undefined;
	}
	// The expiry is signed in its canonical form, so a padded number such as "0012345" rebuilds a
	// different message here and fails the signature check rather than being quietly accepted.
	return { key, expiresAtSeconds: Number(expires), signature };
}

/** Resolves a link against the parsing origin, or returns `undefined` when it cannot be a URL. */
function parseUrl(link: string): URL | undefined {
	try {
		return new URL(link, PARSING_ORIGIN);
	} catch {
		return undefined;
	}
}

/** The signature over a key and an expiry: the only thing a link's holder cannot produce. */
function signLink(key: string, expiresAtSeconds: number, secret: string): string {
	return createHmac('sha256', secret).update(`${key}\n${expiresAtSeconds}`).digest('base64url');
}

/**
 * Compares two signatures without leaking, through how long the comparison took, how many leading
 * bytes of the candidate were right. Lengths are compared first because `timingSafeEqual` throws
 * on buffers of different lengths, and a length is not a secret.
 */
function signaturesMatch(expected: string, candidate: string): boolean {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const candidateBytes = Buffer.from(candidate, 'utf8');
	if (expectedBytes.length !== candidateBytes.length) {
		return false;
	}
	return timingSafeEqual(expectedBytes, candidateBytes);
}

/** An instant as whole epoch seconds, rounded down, which is the resolution a link carries. */
function toEpochSeconds(instant: Date): number {
	return Math.floor(instant.getTime() / MILLISECONDS_PER_SECOND);
}

/**
 * Works out when a link minted now should expire.
 *
 * @throws {TypeError} when the lifetime is not a positive number of milliseconds, which would
 *   mint a link that is already dead.
 */
export function signedLinkExpiry(now: Date, expiresInMilliseconds: number): Date {
	if (!Number.isFinite(expiresInMilliseconds) || expiresInMilliseconds <= 0) {
		throw new TypeError(
			`A signed link's lifetime must be a positive number of milliseconds, not ${expiresInMilliseconds}.`
		);
	}
	return new Date(now.getTime() + expiresInMilliseconds);
}

/**
 * Reads the link-signing secret.
 *
 * @throws {Error} naming the variable when it is missing or too short. A short secret is rejected
 *   rather than accepted, because a link signed with a guessable secret is a link anyone can mint
 *   for any key.
 */
export function readFileStoreSecret(environment: NodeJS.ProcessEnv = process.env): string {
	const secret = environment.FILE_STORE_SECRET?.trim();
	if (!secret) {
		throw new Error(
			'Environment variable FILE_STORE_SECRET is not set. Copy .env.example to .env, then set it to a random value, for example the output of `openssl rand -base64 32`.'
		);
	}
	if (secret.length < MINIMUM_FILE_STORE_SECRET_LENGTH) {
		throw new Error(
			`Environment variable FILE_STORE_SECRET is ${secret.length} characters long; it must be at least ${MINIMUM_FILE_STORE_SECRET_LENGTH}. Generate one with \`openssl rand -base64 32\`.`
		);
	}
	return secret;
}
