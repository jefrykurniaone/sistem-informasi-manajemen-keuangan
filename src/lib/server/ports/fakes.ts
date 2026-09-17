import { randomBytes } from 'node:crypto';
import type { Clock } from './clock';
import type { EmailMessage, EmailSender } from './email';
import {
	buildSignedLink,
	assertStorageKey,
	signedLinkExpiry,
	verifySignedLink,
	DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS,
	type FileLinkVerification,
	type ServedFileStore
} from './file-store';

/**
 * The fake implementation of each outgoing port, for use in tests.
 *
 * They live together in one module rather than next to each of their ports so that a test imports
 * them from one place, and so that it is obvious at a glance that the whole set of fakes is small.
 * A fake that grows behaviour of its own stops being a fake and starts being a second
 * implementation nobody runs in production — when one of these needs a new switch, the honest
 * move is usually to shrink the port instead.
 *
 * These are test doubles, not production code, but they are here under `src/` rather than under
 * `tests/` because a later spec's own fakes and test factories will want to compose them, and
 * because the type checker then holds them to the same interfaces the real implementations
 * satisfy.
 */

/** The instant a `FakeClock` starts at when the test does not care which one it is. */
export const DEFAULT_FAKE_INSTANT = new Date('2026-01-01T00:00:00.000Z');

/**
 * A clock a test moves by hand.
 *
 * ```ts
 * const clock = new FakeClock();
 * clock.advance(5 * 60 * 1000); // five minutes later
 * ```
 */
export class FakeClock implements Clock {
	#instant: Date;

	constructor(instant: Date | string = DEFAULT_FAKE_INSTANT) {
		this.#instant = new Date(instant);
		this.#rejectInvalid();
	}

	now(): Date {
		return new Date(this.#instant);
	}

	/** Moves the clock to `instant`, forwards or backwards. */
	set(instant: Date | string): void {
		this.#instant = new Date(instant);
		this.#rejectInvalid();
	}

	/**
	 * Moves the clock forward.
	 *
	 * @throws {TypeError} when asked to move backwards. Time going backwards is what a test that
	 *   meant `set()` looks like, and a silently reversed clock turns the failure it causes into a
	 *   puzzle somewhere else.
	 */
	advance(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0) {
			throw new TypeError(
				`A fake clock advances by a non-negative number of milliseconds, not ${milliseconds}. Use set() to move it backwards.`
			);
		}
		this.#instant = new Date(this.#instant.getTime() + milliseconds);
	}

	#rejectInvalid(): void {
		if (Number.isNaN(this.#instant.getTime())) {
			throw new TypeError('A fake clock needs a valid instant.');
		}
	}
}

/**
 * An email sender that delivers nowhere and remembers everything.
 *
 * ```ts
 * const sender = new FakeEmailSender();
 * await service.doSomething();
 * expect(sender.messages).toHaveLength(1);
 * ```
 */
export class FakeEmailSender implements EmailSender {
	readonly #messages: EmailMessage[] = [];
	#failure: Error | undefined;

	/** Every message that was accepted, oldest first. */
	get messages(): readonly EmailMessage[] {
		return this.#messages;
	}

	/** The most recently accepted message, for the common case of asserting on one email. */
	get lastMessage(): EmailMessage | undefined {
		return this.#messages.at(-1);
	}

	async send(message: EmailMessage): Promise<void> {
		if (this.#failure) {
			throw this.#failure;
		}
		this.#messages.push(message);
	}

	/** Makes every following send fail, the way an unreachable mail server would. */
	failWith(error: Error): void {
		this.#failure = error;
	}

	/** Makes sending work again. */
	stopFailing(): void {
		this.#failure = undefined;
	}

	/** Forgets every message, for a test that runs several rounds against one sender. */
	clear(): void {
		this.#messages.length = 0;
	}
}

/**
 * A file store that keeps bytes in memory.
 *
 * It signs links with the same functions the real store uses, over a secret generated for this
 * instance, so an expired or tampered link is refused here exactly as it would be on disk — and a
 * link minted by one fake is worthless to another, which is what two installations with different
 * secrets do.
 */
export class FakeFileStore implements ServedFileStore {
	readonly #files = new Map<string, Uint8Array>();
	readonly #clock: Clock;
	readonly #secret = randomBytes(32).toString('base64url');

	constructor(clock: Clock) {
		this.#clock = clock;
	}

	/** Every key currently held, in the order it was first written. */
	get keys(): readonly string[] {
		return [...this.#files.keys()];
	}

	async store(key: string, content: Uint8Array): Promise<void> {
		assertStorageKey(key);
		this.#files.set(key, Uint8Array.from(content));
	}

	async read(key: string): Promise<Uint8Array | undefined> {
		assertStorageKey(key);
		const content = this.#files.get(key);
		return content === undefined ? undefined : Uint8Array.from(content);
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
		assertStorageKey(key);
		this.#files.delete(key);
	}
}
