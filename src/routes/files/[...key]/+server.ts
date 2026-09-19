import { systemClock } from '$lib/server/ports/clock';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { RequestHandler } from './$types';

/**
 * The serving side of a signed link — the route `FileStore.signedLink`'s output points at.
 *
 * `src/lib/server/ports/file-store.ts` already settled what a signed link *is*: the signature is
 * `HMAC-SHA256(secret, "<key>\n<expiry>")` over both the key and the expiry, compared with
 * `timingSafeEqual`, checked before the expiry, with the key taken verbatim and never
 * percent-decoded. This route adds none of that logic and must not: it hands the incoming path and
 * query, exactly as they arrived, to `ServedFileStore.verifySignedLink` and obeys the verdict.
 *
 * ## Why a forged link cannot reach a file
 *
 * The only branch that touches the filesystem is behind `verdict.valid`, and `verdict.valid` is
 * only ever true when the HMAC over the requested key and expiry matches one minted with
 * `FILE_STORE_SECRET` — a value that never leaves the server. Editing the key re-points the signed
 * message, editing the expiry re-dates it, and either way the recomputed HMAC no longer matches,
 * so the request is refused before `read` is called. Nothing here reads a file, checks a file's
 * existence, or leaks how far verification got, until the signature has passed.
 *
 * ## Why a traversal cannot escape `FILE_STORE_ROOT`, three times over
 *
 * 1. A raw `..` never arrives: the URL parser collapses dot segments (`/files/../x` becomes `/x`),
 *    which in real serving no longer matches this route at all.
 * 2. An encoded `..` (`%2e%2e%2f` and friends) survives parsing but is refused by `isStorageKey`
 *    inside `verifySignedLink`, because the key is taken verbatim and a percent sign is outside
 *    the key charset. That check runs before the signature is even computed, so a traversal is
 *    refused even if it were somehow correctly signed.
 * 3. `LocalFileStore.read` re-validates the key and re-checks the resolved path against its root —
 *    the belt-and-braces layer whose cost of failure is handing out `/etc/passwd`.
 *
 * ## Status mapping
 *
 * Every rejection — `malformed`, `signature`, `expired` — answers an identical, empty 403. The
 * reason stays server-side on purpose: telling the holder of an edited link that only its expiry
 * was wrong tells them the rest was right (`verifySignedLink`'s own doc comment makes the same
 * argument for its check order). A valid link whose file is gone answers 404, which leaks nothing:
 * whoever holds a validly signed link was already entitled to know whether the file exists.
 *
 * ## Why there is no session or role check
 *
 * The signature is the authorization. A signed link is a bearer credential handed out by a page
 * the recipient already reached through a permission check (see `FileStore.signedLink`'s doc
 * comment), and it expires within minutes. Checking a session here would break the one thing a
 * cover image's `og:image` exists for — a link-preview fetcher has no session — and would add no
 * protection: without the secret there is no valid link, and whoever holds a valid link was
 * already granted this one file by the page that minted it.
 *
 * ## `Content-Type` comes from the key's extension, never from the bytes
 *
 * The store keeps bytes and deliberately no metadata (see `local-file-store.ts`). The extension,
 * though, is part of the key: it was chosen by the *storing* service from a content type it
 * validated (`setPostCoverImage` derives `cover.jpg|png|webp` from `COVER_IMAGE_EXTENSIONS` after
 * checking magic bytes, never from the uploader's file name), and the key is covered by the HMAC,
 * so by the time this route reads the extension it is server-attested twice. Sniffing the stored
 * bytes instead would let whoever crafted an upload choose what the response claims to be, which
 * is how an image becomes a script. Extensions outside the map fall back to
 * `application/octet-stream` served as an attachment — a later spec that stores a new format
 * (payment proofs, complaint attachments) extends `CONTENT_TYPES_BY_EXTENSION` here.
 * `X-Content-Type-Options: nosniff` forbids a browser from second-guessing either way, and
 * `Cache-Control: no-store` keeps bytes that were guarded by a short-lived link — a transfer proof
 * carries a bank account number — out of disk caches that outlive the link.
 */

/**
 * The media type each stored extension is served as. Every entry mirrors an extension a storing
 * service actually writes today; an extension not listed is served as a download, not guessed at.
 */
const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp'
};

/** What an extension outside the map is served as: opaque bytes, downloaded rather than rendered. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

export const GET: RequestHandler = async ({ url }) => {
	const store = localFileStoreFromEnvironment(systemClock);

	// The path and query exactly as they arrived — never the decoded route parameter, which would
	// hand `verifySignedLink` a percent-decoded key and re-open the door `%2e%2e%2f` knocks on.
	const verdict = store.verifySignedLink(url.pathname + url.search);
	if (!verdict.valid) {
		return refusal();
	}

	const content = await store.read(verdict.key);
	if (content === undefined) {
		return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
	}

	const contentType = contentTypeOf(verdict.key);
	const fileName = verdict.key.slice(verdict.key.lastIndexOf('/') + 1);
	// A key's charset (letters, digits, ".", "-", "_") cannot break out of a quoted string, so the
	// file name needs no escaping here.
	const disposition = contentType === FALLBACK_CONTENT_TYPE ? 'attachment' : 'inline';

	// `read` returns a view over an `ArrayBufferLike`; `Response` wants one over an `ArrayBuffer`.
	// A copy settles that honestly instead of casting, and every stored file is small — uploads are
	// capped far below a megabyte by `BODY_SIZE_LIMIT` and `MAXIMUM_COVER_IMAGE_BYTES`.
	const body = Uint8Array.from(content);

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': contentType,
			'Content-Length': String(body.byteLength),
			'Content-Disposition': `${disposition}; filename="${fileName}"`,
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'no-store'
		}
	});
};

/**
 * The one answer every refused link gets, whatever the reason. `FileLinkRejection` is "useful in a
 * log; never show it to the holder of the link" — and this repository has no request logger, so it
 * is not recorded anywhere either rather than half-leaked through a header.
 */
function refusal(): Response {
	return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

/** The media type `key`'s extension maps to, or the opaque fallback when it maps to nothing. */
function contentTypeOf(key: string): string {
	const fileName = key.slice(key.lastIndexOf('/') + 1);
	const dotAt = fileName.lastIndexOf('.');
	if (dotAt <= 0) {
		return FALLBACK_CONTENT_TYPE;
	}
	const extension = fileName.slice(dotAt + 1).toLowerCase();
	return CONTENT_TYPES_BY_EXTENSION[extension] ?? FALLBACK_CONTENT_TYPE;
}
