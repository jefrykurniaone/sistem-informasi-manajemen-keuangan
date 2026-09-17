import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import {
	isStorageKey,
	readFileStoreSecret,
	SIGNED_LINK_BASE_PATH,
	DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS,
	MINIMUM_FILE_STORE_SECRET_LENGTH,
	type ServedFileStore
} from '$lib/server/ports/file-store';
import { LocalFileStore } from '$lib/server/storage/local-file-store';

/**
 * The `FileStore` port, its local implementation, and what a signed link is worth.
 *
 * The store under test writes into a directory of its own beneath `storage/`, which is the real
 * storage root and is already in `.gitignore`. Nothing here writes outside the repository.
 */

/** A secret of a plausible length. It signs links in this file and nowhere else. */
const SECRET = randomUUID() + randomUUID();

/** A second secret, standing in for another installation. */
const OTHER_SECRET = randomUUID() + randomUUID();

/** The instant every clock in this file starts at. */
const START = '2026-01-01T00:00:00.000Z';

/** One minute. */
const MINUTE = 60 * 1000;

/** The bytes written by most of the tests below. */
const CONTENT = new TextEncoder().encode('bukti transfer');

/** A root inside `storage/`, removed when the file finishes. */
const root = path.resolve(process.cwd(), 'storage', `test-${randomUUID()}`);

function bytes(content: Uint8Array | undefined): number[] {
	return Array.from(content ?? []);
}

/** Rewrites one query parameter of a signed link, leaving everything else alone. */
function tamper(link: string, parameter: string, value: string): string {
	const url = new URL(link, 'https://example.invalid');
	url.searchParams.set(parameter, value);
	return `${url.pathname}${url.search}`;
}

beforeAll(async () => {
	await mkdir(root, { recursive: true });
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('isStorageKey', () => {
	it.each([
		'proof.jpg',
		'payments/8f1c/proof.jpg',
		'reports/2026-01/laporan-bulanan.pdf',
		'a',
		'a_b-c.d/e'
	])('accepts "%s"', (key) => {
		expect(isStorageKey(key)).toBe(true);
	});

	it.each([
		{ name: 'a parent directory', key: '../secret' },
		{ name: 'a parent directory in the middle', key: 'payments/../../etc/passwd' },
		{ name: 'an absolute path', key: '/etc/passwd' },
		{ name: 'a Windows path', key: 'C:\\Windows\\win.ini' },
		{ name: 'a backslash', key: 'payments\\proof.jpg' },
		{ name: 'an empty segment', key: 'payments//proof.jpg' },
		{ name: 'a trailing slash', key: 'payments/' },
		{ name: 'nothing at all', key: '' },
		{ name: 'a leading dot', key: '.env' },
		{ name: 'a leading dash', key: '-rf' },
		{ name: 'a percent-encoded traversal', key: '%2e%2e%2fsecret' },
		{ name: 'a null byte', key: 'proof.jpg\u0000.png' },
		{ name: 'a space', key: 'my proof.jpg' }
	])('refuses $name', ({ key }) => {
		expect(isStorageKey(key)).toBe(false);
	});
});

describe('LocalFileStore', () => {
	let clock: FakeClock;
	let store: LocalFileStore;

	beforeAll(() => {
		clock = new FakeClock(START);
		store = new LocalFileStore({ root, secret: SECRET, clock });
	});

	it('writes bytes and reads exactly those bytes back', async () => {
		await store.store('round-trip.txt', CONTENT);

		expect(bytes(await store.read('round-trip.txt'))).toEqual(bytes(CONTENT));
	});

	it('creates the directories a nested key names', async () => {
		await store.store('payments/8f1c/proof.jpg', CONTENT);

		expect(existsSync(path.join(root, 'payments', '8f1c', 'proof.jpg'))).toBe(true);
	});

	it('replaces what was there rather than failing, so a retried upload leaves one file', async () => {
		const second = new TextEncoder().encode('bukti transfer yang benar');
		await store.store('overwritten.txt', CONTENT);

		await store.store('overwritten.txt', second);

		expect(bytes(await store.read('overwritten.txt'))).toEqual(bytes(second));
	});

	it('reports a key it does not have as undefined rather than throwing', async () => {
		expect(await store.read('never-written.txt')).toBeUndefined();
	});

	it('removes a file', async () => {
		await store.store('removed.txt', CONTENT);

		await store.delete('removed.txt');

		expect(await store.read('removed.txt')).toBeUndefined();
	});

	it('treats removing a key it does not have as done, because the caller wanted it gone', async () => {
		await expect(store.delete('was-never-there.txt')).resolves.toBeUndefined();
	});

	it.each(['../escaped.txt', 'payments/../../escaped.txt', '/etc/passwd', 'a\\b'])(
		'refuses to write through the key "%s"',
		async (key) => {
			await expect(store.store(key, CONTENT)).rejects.toThrow(TypeError);
		}
	);

	it('leaves nothing outside the storage root when a traversal is attempted', async () => {
		const outside = path.resolve(root, '..', 'escaped.txt');

		await expect(store.store('../escaped.txt', CONTENT)).rejects.toThrow(TypeError);

		expect(existsSync(outside)).toBe(false);
	});

	it('refuses to read a file that exists outside the root', async () => {
		const outside = path.resolve(root, '..', `outside-${randomUUID()}.txt`);
		await writeFile(outside, 'a secret');
		try {
			await expect(store.read(`../${path.basename(outside)}`)).rejects.toThrow(TypeError);
		} finally {
			await rm(outside, { force: true });
		}
	});
});

describe('signed links', () => {
	let clock: FakeClock;
	let store: LocalFileStore;

	beforeAll(() => {
		clock = new FakeClock(START);
		store = new LocalFileStore({ root, secret: SECRET, clock });
	});

	it('points at the key it was minted for, and carries an expiry and a signature', async () => {
		const link = await store.signedLink('payments/8f1c/proof.jpg');

		const url = new URL(link, 'https://example.invalid');
		expect(url.pathname).toBe(`${SIGNED_LINK_BASE_PATH}/payments/8f1c/proof.jpg`);
		expect(url.searchParams.get('expires')).not.toBeNull();
		expect(url.searchParams.get('signature')).not.toBeNull();
	});

	it('is accepted while it is still valid', async () => {
		const link = await store.signedLink('proof.jpg', 15 * MINUTE);

		clock.advance(14 * MINUTE);

		expect(store.verifySignedLink(link)).toEqual({
			valid: true,
			key: 'proof.jpg',
			expiresAt: new Date('2026-01-01T00:15:00.000Z')
		});
	});

	it('is refused once it has expired', async () => {
		const fresh = new FakeClock(START);
		const expiring = new LocalFileStore({ root, secret: SECRET, clock: fresh });
		const link = await expiring.signedLink('proof.jpg', 15 * MINUTE);

		fresh.advance(15 * MINUTE + 1);

		expect(expiring.verifySignedLink(link)).toEqual({ valid: false, reason: 'expired' });
	});

	it('is refused at the very instant it expires, not a moment later', async () => {
		const fresh = new FakeClock(START);
		const expiring = new LocalFileStore({ root, secret: SECRET, clock: fresh });
		const link = await expiring.signedLink('proof.jpg', 15 * MINUTE);

		fresh.advance(15 * MINUTE);

		expect(expiring.verifySignedLink(link)).toEqual({ valid: false, reason: 'expired' });
	});

	it('lasts the default lifetime when the caller does not choose one', async () => {
		const fresh = new FakeClock(START);
		const defaulted = new LocalFileStore({ root, secret: SECRET, clock: fresh });
		const link = await defaulted.signedLink('proof.jpg');

		fresh.advance(DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS - 1);
		expect(defaulted.verifySignedLink(link).valid).toBe(true);

		fresh.advance(1);
		expect(defaulted.verifySignedLink(link).valid).toBe(false);
	});

	it('cannot be made to last longer by editing its expiry, because the signature covers it', async () => {
		const fresh = new FakeClock(START);
		const expiring = new LocalFileStore({ root, secret: SECRET, clock: fresh });
		const link = await expiring.signedLink('proof.jpg', 15 * MINUTE);
		const extended = tamper(link, 'expires', String(Math.floor(Date.parse(START) / 1000) + 86_400));

		fresh.advance(60 * MINUTE);

		// Refused for the signature, not for the expiry: the edited link never was one of ours.
		expect(expiring.verifySignedLink(extended)).toEqual({ valid: false, reason: 'signature' });
	});

	it('cannot be repointed at another file, because the signature covers the key', async () => {
		const link = await store.signedLink('payments/mine/proof.jpg', 15 * MINUTE);
		const repointed = link.replace('payments/mine/', 'payments/someone-else/');

		expect(store.verifySignedLink(repointed)).toEqual({ valid: false, reason: 'signature' });
	});

	it('is refused when its signature is edited', async () => {
		const link = await store.signedLink('proof.jpg', 15 * MINUTE);

		expect(store.verifySignedLink(tamper(link, 'signature', 'not-the-signature'))).toEqual({
			valid: false,
			reason: 'signature'
		});
	});

	it('is worthless at an installation with another secret', async () => {
		const link = await store.signedLink('proof.jpg', 15 * MINUTE);
		const elsewhere = new LocalFileStore({ root, secret: OTHER_SECRET, clock });

		expect(elsewhere.verifySignedLink(link)).toEqual({ valid: false, reason: 'signature' });
	});

	it.each([
		{ name: 'a path that is not ours', link: '/uploads/proof.jpg?expires=1&signature=x' },
		{ name: 'no expiry', link: `${SIGNED_LINK_BASE_PATH}/proof.jpg?signature=x` },
		{ name: 'no signature', link: `${SIGNED_LINK_BASE_PATH}/proof.jpg?expires=1` },
		{
			name: 'an expiry that is not a number',
			link: `${SIGNED_LINK_BASE_PATH}/p.jpg?expires=soon&signature=x`
		},
		{
			name: 'a traversal in the key',
			link: `${SIGNED_LINK_BASE_PATH}/../../etc/passwd?expires=1&signature=x`
		},
		{
			name: 'a percent-encoded traversal',
			link: `${SIGNED_LINK_BASE_PATH}/%2e%2e%2fpasswd?expires=1&signature=x`
		},
		{ name: 'no key at all', link: `${SIGNED_LINK_BASE_PATH}/?expires=1&signature=x` },
		{ name: 'another origin', link: 'https://evil.invalid/files/proof.jpg?expires=1&signature=x' }
	])('refuses $name as malformed', ({ link }) => {
		expect(store.verifySignedLink(link)).toEqual({ valid: false, reason: 'malformed' });
	});

	it.each([0, -1, Number.NaN])(
		'refuses to mint a link that lives for %s milliseconds',
		async (lifetime) => {
			await expect(store.signedLink('proof.jpg', lifetime)).rejects.toThrow(TypeError);
		}
	);
});

describe('FakeFileStore', () => {
	it('keeps bytes in memory and gives them back', async () => {
		const store: ServedFileStore = new FakeFileStore(new FakeClock(START));

		await store.store('proof.jpg', CONTENT);

		expect(bytes(await store.read('proof.jpg'))).toEqual(bytes(CONTENT));
	});

	it('copies what it is given, so a caller mutating its buffer cannot change what was stored', async () => {
		const store = new FakeFileStore(new FakeClock(START));
		const mutable = Uint8Array.from(CONTENT);
		await store.store('proof.jpg', mutable);

		mutable.fill(0);

		expect(bytes(await store.read('proof.jpg'))).toEqual(bytes(CONTENT));
	});

	it('lists what it holds', async () => {
		const store = new FakeFileStore(new FakeClock(START));
		await store.store('one.txt', CONTENT);
		await store.store('two.txt', CONTENT);

		expect(store.keys).toEqual(['one.txt', 'two.txt']);
	});

	it('forgets a deleted key', async () => {
		const store = new FakeFileStore(new FakeClock(START));
		await store.store('one.txt', CONTENT);

		await store.delete('one.txt');

		expect(store.keys).toEqual([]);
	});

	it('refuses an invalid key exactly as the real store does', async () => {
		const store = new FakeFileStore(new FakeClock(START));

		await expect(store.store('../escaped.txt', CONTENT)).rejects.toThrow(TypeError);
	});

	it('expires its links, so a test of an expired link needs no disk', async () => {
		const clock = new FakeClock(START);
		const store = new FakeFileStore(clock);
		const link = await store.signedLink('proof.jpg', 15 * MINUTE);
		expect(store.verifySignedLink(link).valid).toBe(true);

		clock.advance(15 * MINUTE + 1);

		expect(store.verifySignedLink(link)).toEqual({ valid: false, reason: 'expired' });
	});

	it('refuses a link minted by another fake, because each one signs with its own secret', async () => {
		const clock = new FakeClock(START);
		const link = await new FakeFileStore(clock).signedLink('proof.jpg', 15 * MINUTE);

		expect(new FakeFileStore(clock).verifySignedLink(link)).toEqual({
			valid: false,
			reason: 'signature'
		});
	});
});

describe('readFileStoreSecret', () => {
	it('reads the secret', () => {
		expect(readFileStoreSecret({ FILE_STORE_SECRET: SECRET })).toBe(SECRET);
	});

	it('rejects a missing secret with a message naming its variable', () => {
		expect(() => readFileStoreSecret({})).toThrow(/FILE_STORE_SECRET is not set/);
	});

	it('rejects a blank secret', () => {
		expect(() => readFileStoreSecret({ FILE_STORE_SECRET: '   ' })).toThrow(/is not set/);
	});

	it('rejects a secret short enough to guess', () => {
		const short = 'a'.repeat(MINIMUM_FILE_STORE_SECRET_LENGTH - 1);

		expect(() => readFileStoreSecret({ FILE_STORE_SECRET: short })).toThrow(/at least/);
	});
});
