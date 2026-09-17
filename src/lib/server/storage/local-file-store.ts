import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Clock } from '../ports/clock';
import {
	assertStorageKey,
	buildSignedLink,
	readFileStoreSecret,
	signedLinkExpiry,
	verifySignedLink,
	DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS,
	type FileLinkVerification,
	type ServedFileStore
} from '../ports/file-store';

/**
 * The `FileStore` that writes to a directory on this machine.
 *
 * It is the implementation the whole application runs on until there is somewhere to publish to,
 * at which point an S3-compatible store implements the same port and this one keeps being what
 * tests and a laptop use. The interface, the key rules and the meaning of a signed link all live
 * in `../ports/file-store.ts`; what is decided here is only how they meet a filesystem:
 *
 * - **The root directory is resolved once, at construction.** Every key is then resolved against
 *   it and checked to be inside it. Keys are already validated by `assertStorageKey`, which no
 *   `..` gets through, so this second check never fires — it is here because the cost of the two
 *   of them ever disagreeing is handing out a file from outside the storage root.
 * - **Directories are created on the way in, and never removed on the way out.** A key with
 *   slashes in it becomes nested directories; deleting the last file in one leaves the empty
 *   directory behind, which costs nothing and avoids a delete racing a concurrent write into the
 *   same directory.
 * - **No metadata is stored beside the bytes.** No content type, no original file name, no size.
 *   Those belong on the domain row that owns the key, where they are queryable and where they
 *   survive a move to another store; a sidecar file here would be a second source of truth that
 *   an S3 adapter has no way to reproduce.
 */

/** Where files are written when `FILE_STORE_ROOT` says nothing. It is listed in `.gitignore`. */
export const DEFAULT_FILE_STORE_ROOT = 'storage';

/** The filesystem error codes that mean "there is no file here", as opposed to a real failure. */
const MISSING_FILE_CODES = ['ENOENT', 'EISDIR'];

/** Everything `LocalFileStore` needs. */
export interface LocalFileStoreSettings {
	/** The directory files are written into, absolute or relative to the working directory. */
	readonly root: string;
	/** The secret that signs links. See `readFileStoreSecret`. */
	readonly secret: string;
	/** The source of time, so that a test can prove an expired link is refused. */
	readonly clock: Clock;
}

/** A `FileStore` backed by a directory on this machine. */
export class LocalFileStore implements ServedFileStore {
	readonly #root: string;
	readonly #secret: string;
	readonly #clock: Clock;

	constructor(settings: LocalFileStoreSettings) {
		this.#root = path.resolve(settings.root);
		this.#secret = settings.secret;
		this.#clock = settings.clock;
	}

	/** The directory this store writes into, as an absolute path. */
	get root(): string {
		return this.#root;
	}

	async store(key: string, content: Uint8Array): Promise<void> {
		const file = this.#pathOf(key);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, content);
	}

	async read(key: string): Promise<Uint8Array | undefined> {
		try {
			return await readFile(this.#pathOf(key));
		} catch (error) {
			if (isMissingFile(error)) {
				return undefined;
			}
			throw error;
		}
	}

	async signedLink(
		key: string,
		expiresInMilliseconds: number = DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS
	): Promise<string> {
		assertStorageKey(key);
		const expiresAt = signedLinkExpiry(this.#clock.now(), expiresInMilliseconds);
		return buildSignedLink({ key, expiresAt, secret: this.#secret });
	}

	verifySignedLink(link: string): FileLinkVerification {
		return verifySignedLink({ link, secret: this.#secret, now: this.#clock.now() });
	}

	async delete(key: string): Promise<void> {
		try {
			await unlink(this.#pathOf(key));
		} catch (error) {
			if (!isMissingFile(error)) {
				throw error;
			}
		}
	}

	/**
	 * The absolute path a key names.
	 *
	 * @throws {TypeError} when the key is not valid, or when it somehow resolves outside the root.
	 */
	#pathOf(key: string): string {
		assertStorageKey(key);
		const file = path.resolve(this.#root, key);
		if (!file.startsWith(this.#root + path.sep)) {
			throw new TypeError(`The storage key "${key}" resolves outside the storage root.`);
		}
		return file;
	}
}

/** Whether a filesystem error means the file is not there. */
function isMissingFile(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return false;
	}
	const code = (error as { code: unknown }).code;
	return typeof code === 'string' && MISSING_FILE_CODES.includes(code);
}

/**
 * Builds the store the running application uses, from `FILE_STORE_ROOT` and `FILE_STORE_SECRET`.
 *
 * @throws {Error} naming the variable when the secret is missing or too short.
 */
export function localFileStoreFromEnvironment(
	clock: Clock,
	environment: NodeJS.ProcessEnv = process.env
): LocalFileStore {
	return new LocalFileStore({
		root: environment.FILE_STORE_ROOT?.trim() || DEFAULT_FILE_STORE_ROOT,
		secret: readFileStoreSecret(environment),
		clock
	});
}
