import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSignedLink, SIGNED_LINK_BASE_PATH } from '$lib/server/ports/file-store';
import { systemClock } from '$lib/server/ports/clock';
import { LocalFileStore } from '$lib/server/storage/local-file-store';
import { GET } from '../../src/routes/files/[...key]/+server';

/**
 * The route that serves signed links, called directly as SvelteKit would call it.
 *
 * The route builds its store from `FILE_STORE_ROOT` and `FILE_STORE_SECRET`, so this file points
 * those at a directory and a secret of its own for its duration and restores them afterwards. The
 * directory lives beneath `storage/`, the real storage root, which is already in `.gitignore` —
 * the same arrangement as `tests/unit/ports-file-store.test.ts`. What a signed link is worth is
 * proven there, against the port; what is proven here is that the route obeys the verdict: which
 * status each answer gets, which headers a served file carries, and that no request without a
 * valid signature ever reaches a file.
 */

/** The secret the route signs and verifies with while this file runs. Used by this file only. */
const SECRET = randomUUID() + randomUUID();

/** A lifetime long enough that no test below races the real clock. */
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** The bytes served by most of the tests below. */
const CONTENT = new TextEncoder().encode('gambar sampul');

/** A root inside `storage/`, removed when the file finishes. */
const root = path.resolve(process.cwd(), 'storage', `test-serving-${randomUUID()}`);

/**
 * A file OUTSIDE the storage root — the thing every traversal below is trying to read. It sits in
 * `storage/` itself, one level above `root`, so `../` from a key is exactly one step short of it.
 */
const outsideFileName = `escaped-${randomUUID()}.txt`;
const outsideFile = path.resolve(root, '..', outsideFileName);

/** What the outside file holds; no response below may ever contain it. */
const OUTSIDE_SECRET = `nomor rekening rahasia ${randomUUID()}`;

/** The store the tests mint genuine links with — same root, same secret, same clock as the route. */
const minting = new LocalFileStore({ root, secret: SECRET, clock: systemClock });

const originalEnvironment = {
	root: process.env.FILE_STORE_ROOT,
	secret: process.env.FILE_STORE_SECRET
};

beforeAll(async () => {
	process.env.FILE_STORE_ROOT = root;
	process.env.FILE_STORE_SECRET = SECRET;
	await mkdir(root, { recursive: true });
	await writeFile(outsideFile, OUTSIDE_SECRET);
});

afterAll(async () => {
	restore('FILE_STORE_ROOT', originalEnvironment.root);
	restore('FILE_STORE_SECRET', originalEnvironment.secret);
	await rm(root, { recursive: true, force: true });
	await rm(outsideFile, { force: true });
});

function restore(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

/**
 * Calls the route the way SvelteKit would, with an event that deliberately carries nothing but the
 * URL: no `cookies`, no `locals`, no `request`. A handler that consulted a session in any form
 * would throw here, so every 200 below is also proof of the "no session, no role" criterion.
 */
async function respondTo(link: string): Promise<Response> {
	const url = new URL(link, 'http://localhost:5181');
	return GET({ url } as unknown as Parameters<typeof GET>[0]);
}

/** A genuine expiry instant, comfortably in the future. */
function future(): Date {
	return new Date(Date.now() + FIFTEEN_MINUTES);
}

/** The signature the port would mint for `key` and `expires` — what an attacker cannot compute. */
function realSignature(key: string, expiresAtSeconds: number): string {
	return createHmac('sha256', SECRET).update(`${key}\n${expiresAtSeconds}`).digest('base64url');
}

/** Rewrites one query parameter of a signed link, leaving everything else alone. */
function tamper(link: string, parameter: string, value: string): string {
	const url = new URL(link, 'https://example.invalid');
	url.searchParams.set(parameter, value);
	return `${url.pathname}${url.search}`;
}

/** Drops one query parameter of a signed link. */
function strip(link: string, parameter: string): string {
	const url = new URL(link, 'https://example.invalid');
	url.searchParams.delete(parameter);
	return `${url.pathname}${url.search}`;
}

/** `link` with exactly one character of its signature changed. */
function flipOneSignatureCharacter(link: string): string {
	const url = new URL(link, 'https://example.invalid');
	const signature = url.searchParams.get('signature') ?? '';
	const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
	return tamper(link, 'signature', flipped);
}

describe('GET /files/[...key]', () => {
	it('answers a validly signed link with 200, the exact bytes, and headers a browser can trust', async () => {
		await minting.store('posts/w13/cover.png', CONTENT);
		const link = await minting.signedLink('posts/w13/cover.png', FIFTEEN_MINUTES);

		const response = await respondTo(link);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('content-length')).toBe(String(CONTENT.byteLength));
		expect(response.headers.get('content-disposition')).toBe('inline; filename="cover.png"');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(CONTENT);
	});

	it.each([
		{ extension: 'jpg', contentType: 'image/jpeg' },
		{ extension: 'jpeg', contentType: 'image/jpeg' },
		{ extension: 'webp', contentType: 'image/webp' }
	])('serves a stored .$extension as $contentType', async ({ extension, contentType }) => {
		const key = `typed/example.${extension}`;
		await minting.store(key, CONTENT);

		const response = await respondTo(await minting.signedLink(key, FIFTEEN_MINUTES));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(contentType);
	});

	it('serves an extension it does not know as an opaque download, never a guess', async () => {
		await minting.store('docs/report.bin', CONTENT);

		const response = await respondTo(await minting.signedLink('docs/report.bin', FIFTEEN_MINUTES));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.bin"');
	});

	it.each(['constructor', '__proto__'])(
		'serves an extension named after the prototype property "%s" as an opaque download, never an inherited value',
		async (extension) => {
			// After lowercasing, these are the two `Object.prototype` names a key's charset can spell.
			// On an object-literal map, indexing with either returns an inherited function or object —
			// truthy, so the octet-stream fallback would never fire and the value would be coerced
			// into a garbage Content-Type header. The map is a `Map` precisely so this stays pinned.
			const key = `proto/evil.${extension}`;
			await minting.store(key, CONTENT);

			const response = await respondTo(await minting.signedLink(key, FIFTEEN_MINUTES));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('application/octet-stream');
			expect(response.headers.get('content-disposition')).toBe(
				`attachment; filename="evil.${extension}"`
			);
		}
	);

	it('refuses a signature with one character changed with 403, not 200 and not 404', async () => {
		await minting.store('tampered/proof.jpg', CONTENT);
		const link = await minting.signedLink('tampered/proof.jpg', FIFTEEN_MINUTES);

		const response = await respondTo(flipOneSignatureCharacter(link));

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('');
	});

	it('refuses a genuine link re-pointed at another stored file', async () => {
		await minting.store('payments/mine/proof.jpg', CONTENT);
		await minting.store('payments/theirs/proof.jpg', new TextEncoder().encode(OUTSIDE_SECRET));
		const link = await minting.signedLink('payments/mine/proof.jpg', FIFTEEN_MINUTES);

		const response = await respondTo(link.replace('payments/mine/', 'payments/theirs/'));

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('');
	});

	it('refuses a link past its expiry with 403 though its signature is genuine', async () => {
		await minting.store('expired/proof.jpg', CONTENT);
		const link = buildSignedLink({
			key: 'expired/proof.jpg',
			expiresAt: new Date(Date.now() - 1000),
			secret: SECRET
		});

		const response = await respondTo(link);

		expect(response.status).toBe(403);
	});

	it.each(['signature', 'expires'])(
		'refuses a link without its %s parameter',
		async (parameter) => {
			await minting.store('stripped/proof.jpg', CONTENT);
			const link = await minting.signedLink('stripped/proof.jpg', FIFTEEN_MINUTES);

			const response = await respondTo(strip(link, parameter));

			expect(response.status).toBe(403);
		}
	);

	it('gives every refusal the same empty answer, so the reason never reaches the holder', async () => {
		await minting.store('uniform/proof.jpg', CONTENT);
		const genuine = await minting.signedLink('uniform/proof.jpg', FIFTEEN_MINUTES);
		const refused = [
			flipOneSignatureCharacter(genuine),
			buildSignedLink({
				key: 'uniform/proof.jpg',
				expiresAt: new Date(Date.now() - 1000),
				secret: SECRET
			}),
			`${SIGNED_LINK_BASE_PATH}/uniform/proof.jpg`
		];

		for (const link of refused) {
			const response = await respondTo(link);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe('');
			expect(response.headers.get('content-type')).toBeNull();
		}
	});

	it.each([
		{ name: 'a raw parent directory', key: `../${outsideFileName}` },
		{ name: 'a percent-encoded slash', key: `..%2f${outsideFileName}` },
		{ name: 'percent-encoded dots', key: `%2e%2e/${outsideFileName}` },
		{ name: 'a fully percent-encoded traversal', key: `%2e%2e%2f${outsideFileName}` },
		{ name: 'a doubled-up traversal', key: `....//${outsideFileName}` },
		{ name: 'a percent-encoded backslash', key: `..%5c${outsideFileName}` }
	])(
		'never reads outside the root through $name, even under a genuine signature',
		async ({ key }) => {
			// The strongest form of the attack: the HMAC is computed over exactly the key string the
			// parser would extract, as if the secret had leaked or a signing bug existed. The key
			// check must refuse it before the signature is ever consulted.
			const expiresAtSeconds = Math.floor(future().getTime() / 1000);
			const link = `${SIGNED_LINK_BASE_PATH}/${key}?expires=${expiresAtSeconds}&signature=${realSignature(key, expiresAtSeconds)}`;

			const response = await respondTo(link);

			expect(response.status).toBe(403);
			expect(await response.text()).not.toContain(OUTSIDE_SECRET);
			expect(existsSync(outsideFile)).toBe(true);
		}
	);

	it('answers 404 for a genuine link whose file does not exist', async () => {
		const link = await minting.signedLink('never/written.png', FIFTEEN_MINUTES);

		const response = await respondTo(link);

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});
