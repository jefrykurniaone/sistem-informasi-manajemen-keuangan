import { and, desc, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCookies } from 'better-auth/cookies';
import {
	createAuth,
	isSecureOrigin,
	MINIMUM_PASSWORD_LENGTH,
	readAuthSecret,
	readOrigin,
	type Auth
} from '$lib/server/auth';
import {
	account,
	emailQueue,
	session,
	user,
	verification,
	type QueuedEmail
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';
import {
	PASSWORD_RESET_KIND,
	passwordResetTemplates
} from '$lib/server/email/templates/password-reset';
import { VERIFY_EMAIL_KIND, verifyEmailTemplates } from '$lib/server/email/templates/verify-email';
import { processEmailQueue } from '$lib/server/email/worker';
import { FakeClock, FakeEmailSender } from '$lib/server/ports/fakes';

/**
 * Authentication, against a real PostgreSQL and the real better-auth.
 *
 * Nothing here is mocked except the two outgoing ports. That is the point: what this ticket
 * promises is about what survives a commit and what a second request can see — a password that is
 * a hash in a column, a reset token that is gone after one use, a session that outlives the call
 * that made it. A test against a fake better-auth would prove none of it.
 *
 * Every test gives its accounts an address of its own, because rows from earlier tests stay in the
 * schema for the whole file.
 */

const testDb = testDatabase();

/** The origin the instance under test answers on. Plain http, as a laptop serves it. */
const TEST_ORIGIN = 'http://localhost:5173';

/** A secret of the length the real reader insists on. It signs nothing outside this file. */
const TEST_SECRET = 'a-test-secret-that-is-long-enough-to-pass';

/** A password that clears the minimum length, used wherever the password itself does not matter. */
const GOOD_PASSWORD = 'kata sandi yang panjang';

/** The instant the queue rows in this file are stamped with. */
const START = '2026-01-01T00:00:00.000Z';

/** Every template this application can render, as the worker is given them. */
const ALL_TEMPLATES = { ...verifyEmailTemplates, ...passwordResetTemplates };

/** A batch big enough to take everything this file ever queues in one run. */
const EVERYTHING = 100;

const clock = new FakeClock(START);

let instance: Auth | undefined;

/**
 * The instance under test, built on first use. It cannot be built at module scope: `testDb.db`
 * only exists once the harness's `beforeAll` has run.
 */
function authentication(): Auth {
	instance ??= createAuth({
		db: testDb.db,
		clock,
		baseURL: TEST_ORIGIN,
		secret: TEST_SECRET
	});
	return instance;
}

/** Registers someone, leaving them unverified and their verification email queued. */
async function register(email: string, password: string = GOOD_PASSWORD): Promise<void> {
	await authentication().api.signUpEmail({ body: { name: 'Warga Uji', email, password } });
}

/** The most recent email of one kind queued for one address. */
async function queued(recipient: string, kind: string): Promise<QueuedEmail | undefined> {
	const [row] = await testDb.db
		.select()
		.from(emailQueue)
		.where(and(eq(emailQueue.recipient, recipient), eq(emailQueue.kind, kind)))
		.orderBy(desc(emailQueue.createdAt))
		.limit(1);
	return row;
}

/** Every email of one kind queued for one address. */
async function allQueued(recipient: string, kind: string): Promise<QueuedEmail[]> {
	return testDb.db
		.select()
		.from(emailQueue)
		.where(and(eq(emailQueue.recipient, recipient), eq(emailQueue.kind, kind)));
}

/** The link a queued email carries. */
function linkOf(row: QueuedEmail | undefined): string {
	const url = row?.payload.url;
	if (typeof url !== 'string') {
		throw new TypeError(`The queued email carries no link: ${JSON.stringify(row?.payload)}`);
	}
	return url;
}

/** The token inside a link this application put in an email. */
function tokenOf(link: string): string {
	const token = new URL(link).searchParams.get('token');
	if (token === null) {
		throw new TypeError(`The link carries no token: ${link}`);
	}
	return token;
}

/** Walks the whole flow a new resident walks: register, read the email, open the link. */
async function registerAndVerify(email: string, password: string = GOOD_PASSWORD): Promise<void> {
	await register(email, password);
	const token = tokenOf(linkOf(await queued(email, VERIFY_EMAIL_KIND)));
	await authentication().api.verifyEmail({ query: { token } });
}

/** Signs in and returns the `Cookie` header a browser would send back afterwards. */
async function signInAndKeepCookies(
	email: string,
	password: string = GOOD_PASSWORD
): Promise<string> {
	const { headers } = await authentication().api.signInEmail({
		body: { email, password },
		returnHeaders: true
	});
	return headers
		.getSetCookie()
		.map((line) => line.split(';')[0])
		.join('; ');
}

/** The error code better-auth answered a refused call with. */
async function refusalCode(call: Promise<unknown>): Promise<string | undefined> {
	try {
		await call;
	} catch (error) {
		const body: unknown = (error as { body?: unknown }).body;
		return (body as { code?: string } | undefined)?.code;
	}
	return undefined;
}

/** Sends everything the queue holds, and hands back what the mail server was given. */
async function emptyTheQueue(): Promise<FakeEmailSender> {
	const sender = new FakeEmailSender();
	await processEmailQueue({
		db: testDb.db,
		clock,
		sender,
		templates: ALL_TEMPLATES,
		batchSize: EVERYTHING
	});
	return sender;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('registering', () => {
	it('creates an account that cannot be used until its address is proven', async () => {
		const email = 'register-shape@komplek.local';

		await register(email);

		const [row] = await testDb.db.select().from(user).where(eq(user.email, email));
		expect(row).toMatchObject({ name: 'Warga Uji', email, emailVerified: false });
	});

	it('queues exactly one verification email, addressed to the person who registered', async () => {
		const email = 'register-queues@komplek.local';

		await register(email);

		const rows = await allQueued(email, VERIFY_EMAIL_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
	});

	it('sends nothing from inside the call, so a dead mail server cannot fail a registration', async () => {
		// The queue row is the whole of what registering does about email. Proven by the row being
		// pending and untried: a sender that had been reached would have moved it.
		const email = 'register-not-sent@komplek.local';

		await register(email);

		expect((await queued(email, VERIFY_EMAIL_KIND))?.sentAt).toBeNull();
	});

	it('answers a second registration of the same address without saying it is taken', async () => {
		const email = 'register-twice@komplek.local';
		await register(email);

		await expect(register(email, 'kata sandi yang lain lagi')).resolves.not.toThrow();

		// One person, one email. The answer gives a stranger nothing, and the person who really
		// owns the address is not sent a second link by someone else's typing.
		expect(await testDb.db.select().from(user).where(eq(user.email, email))).toHaveLength(1);
		expect(await allQueued(email, VERIFY_EMAIL_KIND)).toHaveLength(1);
	});

	it.each([
		{
			name: 'one character short',
			password: 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1),
			code: 'PASSWORD_TOO_SHORT'
		},
		// An empty password never reaches the length rule: it fails the endpoint's own shape check
		// first. The registration form catches this one before better-auth does, so that the person
		// reads an Indonesian sentence instead of either code.
		{ name: 'empty', password: '', code: 'VALIDATION_ERROR' }
	])('refuses a password that is $name', async ({ password, code }) => {
		const email = `register-short-${password.length}@komplek.local`;

		expect(await refusalCode(register(email, password))).toBe(code);
	});
});

describe('the verification email', () => {
	it('is written in Indonesian and carries a link to this application, not to the library', async () => {
		const email = 'verify-email-body@komplek.local';
		await register(email);

		const sender = await emptyTheQueue();
		const message = sender.messages.find((sent) => sent.to === email);

		expect(message?.subject).toBe('Verifikasi alamat email Anda');
		expect(message?.text).toContain(`${TEST_ORIGIN}/verify?token=`);
	});

	it('proves the address when its link is opened', async () => {
		const email = 'verify-works@komplek.local';
		await register(email);

		await authentication().api.verifyEmail({
			query: { token: tokenOf(linkOf(await queued(email, VERIFY_EMAIL_KIND))) }
		});

		const [row] = await testDb.db.select().from(user).where(eq(user.email, email));
		expect(row.emailVerified).toBe(true);
	});

	it('does not sign anyone in, because the link travelled through an inbox', async () => {
		const email = 'verify-no-session@komplek.local';

		await registerAndVerify(email);

		const [row] = await testDb.db.select().from(user).where(eq(user.email, email));
		expect(await testDb.db.select().from(session).where(eq(session.userId, row.id))).toHaveLength(
			0
		);
	});

	it('refuses a token that was tampered with', async () => {
		const email = 'verify-tampered@komplek.local';
		await register(email);
		const token = tokenOf(linkOf(await queued(email, VERIFY_EMAIL_KIND)));

		const refused = refusalCode(
			authentication().api.verifyEmail({ query: { token: `${token}x` } })
		);

		expect(await refused).toBe('INVALID_TOKEN');
	});

	it('can be asked for again without the answer saying whether the address exists', async () => {
		const unknown = 'verify-resend-unknown@komplek.local';
		const known = 'verify-resend-known@komplek.local';
		await register(known);

		await expect(
			authentication().api.sendVerificationEmail({ body: { email: unknown } })
		).resolves.toMatchObject({ status: true });
		await expect(
			authentication().api.sendVerificationEmail({ body: { email: known } })
		).resolves.toMatchObject({ status: true });

		// The answers are identical; only the queue knows the difference.
		expect(await allQueued(unknown, VERIFY_EMAIL_KIND)).toHaveLength(0);
		expect(await allQueued(known, VERIFY_EMAIL_KIND)).toHaveLength(2);
	});
});

describe('signing in', () => {
	it('refuses an account whose address has not been proven, and says which problem it is', async () => {
		const email = 'signin-unverified@komplek.local';
		await register(email);

		expect(
			await refusalCode(
				authentication().api.signInEmail({ body: { email, password: GOOD_PASSWORD } })
			)
		).toBe('EMAIL_NOT_VERIFIED');
	});

	it.each([
		{ name: 'the wrong password', email: 'signin-wrong-password@komplek.local', registered: true },
		{
			name: 'an address nobody registered',
			email: 'signin-nobody@komplek.local',
			registered: false
		}
	])('answers $name with one indistinguishable refusal', async ({ email, registered }) => {
		if (registered) {
			await registerAndVerify(email);
		}

		expect(
			await refusalCode(
				authentication().api.signInEmail({ body: { email, password: 'kata sandi yang salah' } })
			)
		).toBe('INVALID_EMAIL_OR_PASSWORD');
	});

	it('writes a session that a later request can read back from its cookie', async () => {
		const email = 'signin-session@komplek.local';
		await registerAndVerify(email);

		const cookie = await signInAndKeepCookies(email);
		const active = await authentication().api.getSession({ headers: new Headers({ cookie }) });

		expect(active?.user.email).toBe(email);
	});

	it('mints a new session token every time, so an old one can never be made to count', async () => {
		// The session fixation argument: there is nothing a caller can hand in that decides which
		// token it gets, and signing in twice never lands on the same row.
		const email = 'signin-fresh-token@komplek.local';
		await registerAndVerify(email);

		await signInAndKeepCookies(email);
		await signInAndKeepCookies(email);

		const [first, second] = await testDb.db
			.select()
			.from(session)
			.innerJoin(user, eq(session.userId, user.id))
			.where(eq(user.email, email));
		expect(first.session.token).not.toBe(second.session.token);
	});
});

describe('signing out', () => {
	it('ends the session it was asked about, and leaves nothing to read back', async () => {
		const email = 'signout@komplek.local';
		await registerAndVerify(email);
		const cookie = await signInAndKeepCookies(email);

		await authentication().api.signOut({ headers: new Headers({ cookie }) });

		expect(await authentication().api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
	});
});

describe('recovering a forgotten password', () => {
	it('queues an email whose link points at this application and carries a token', async () => {
		const email = 'reset-queued@komplek.local';
		await registerAndVerify(email);

		await authentication().api.requestPasswordReset({ body: { email } });

		const link = linkOf(await queued(email, PASSWORD_RESET_KIND));
		expect(link.startsWith(`${TEST_ORIGIN}/set-password?token=`)).toBe(true);
	});

	it('is written in Indonesian and says what the link is worth', async () => {
		const email = 'reset-body@komplek.local';
		await registerAndVerify(email);
		await authentication().api.requestPasswordReset({ body: { email } });

		const sender = await emptyTheQueue();
		const message = sender.messages.find(
			(sent) => sent.to === email && sent.subject === 'Atur ulang kata sandi Anda'
		);

		expect(message?.text).toContain('hanya bisa dipakai sekali');
	});

	it('answers an address nobody registered exactly as it answers one that is', async () => {
		const unknown = 'reset-unknown@komplek.local';

		await expect(
			authentication().api.requestPasswordReset({ body: { email: unknown } })
		).resolves.toMatchObject({ status: true });

		expect(await allQueued(unknown, PASSWORD_RESET_KIND)).toHaveLength(0);
	});

	it('sets the new password and stops the old one working', async () => {
		const email = 'reset-changes-password@komplek.local';
		const newPassword = 'kata sandi yang baru sekali';
		await registerAndVerify(email);
		await authentication().api.requestPasswordReset({ body: { email } });
		const token = tokenOf(linkOf(await queued(email, PASSWORD_RESET_KIND)));

		await authentication().api.resetPassword({ body: { token, newPassword } });

		await expect(
			authentication().api.signInEmail({ body: { email, password: newPassword } })
		).resolves.toBeDefined();
		expect(
			await refusalCode(
				authentication().api.signInEmail({ body: { email, password: GOOD_PASSWORD } })
			)
		).toBe('INVALID_EMAIL_OR_PASSWORD');
	});

	it('refuses the same link a second time, because using it deletes it', async () => {
		const email = 'reset-single-use@komplek.local';
		await registerAndVerify(email);
		await authentication().api.requestPasswordReset({ body: { email } });
		const token = tokenOf(linkOf(await queued(email, PASSWORD_RESET_KIND)));
		await authentication().api.resetPassword({
			body: { token, newPassword: 'kata sandi pertama' }
		});

		const refused = refusalCode(
			authentication().api.resetPassword({ body: { token, newPassword: 'kata sandi kedua' } })
		);

		expect(await refused).toBe('INVALID_TOKEN');
		expect(
			await testDb.db
				.select()
				.from(verification)
				.where(eq(verification.identifier, `reset-password:${token}`))
		).toHaveLength(0);
	});

	it('refuses a link whose hour has passed', async () => {
		const email = 'reset-expired@komplek.local';
		await registerAndVerify(email);
		await authentication().api.requestPasswordReset({ body: { email } });
		const token = tokenOf(linkOf(await queued(email, PASSWORD_RESET_KIND)));

		// better-auth reads the wall clock for this deadline, not the `Clock` port, so the row is
		// aged rather than the clock moved.
		await testDb.db
			.update(verification)
			.set({ expiresAt: new Date(Date.parse(START)) })
			.where(eq(verification.identifier, `reset-password:${token}`));

		const refused = refusalCode(
			authentication().api.resetPassword({ body: { token, newPassword: 'kata sandi ketiga' } })
		);

		expect(await refused).toBe('INVALID_TOKEN');
	});

	it('throws every signed-in browser out, because the reason to reset is that someone else may be in', async () => {
		const email = 'reset-revokes@komplek.local';
		await registerAndVerify(email);
		const cookie = await signInAndKeepCookies(email);
		await authentication().api.requestPasswordReset({ body: { email } });
		const token = tokenOf(linkOf(await queued(email, PASSWORD_RESET_KIND)));

		await authentication().api.resetPassword({
			body: { token, newPassword: 'kata sandi keempat' }
		});

		expect(await authentication().api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
	});
});

describe('the password itself', () => {
	it('is never stored in its original form, in any column of any table', async () => {
		const email = 'password-not-stored@komplek.local';
		const password = 'rahasia-yang-tidak-boleh-tersimpan-apa-adanya';
		await registerAndVerify(email);
		await authentication().api.signInEmail({ body: { email, password: GOOD_PASSWORD } });
		await register('password-not-stored-two@komplek.local', password);

		// Every row of every table this ticket writes, as text. A leak through a column nobody
		// thought of shows up here without the test having to name that column.
		const dump = await testDb.db.execute<{ dump: string }>(sql`
			select coalesce(string_agg(entry::text, ' '), '') as dump
			from (
				select to_jsonb(u) as entry from "user" u
				union all select to_jsonb(s) from "session" s
				union all select to_jsonb(a) from "account" a
				union all select to_jsonb(v) from "verification" v
				union all select to_jsonb(q) from "email_queue" q
			) entries
		`);

		expect(dump.rows[0]?.dump).not.toContain(password);
		expect(dump.rows[0]?.dump).not.toContain(GOOD_PASSWORD);
	});

	it('is kept as a salted scrypt hash, so two identical passwords do not look identical', async () => {
		const shared = 'kata sandi yang sama persis';
		await register('password-hash-one@komplek.local', shared);
		await register('password-hash-two@komplek.local', shared);

		const hashes = await testDb.db
			.select({
				password: account.password,
				providerId: account.providerId,
				userId: account.userId
			})
			.from(account)
			.innerJoin(user, eq(account.userId, user.id))
			.where(eq(user.email, 'password-hash-one@komplek.local'));
		const [other] = await testDb.db
			.select({ password: account.password })
			.from(account)
			.innerJoin(user, eq(account.userId, user.id))
			.where(eq(user.email, 'password-hash-two@komplek.local'));

		expect(hashes[0].providerId).toBe('credential');
		expect(hashes[0].password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
		expect(hashes[0].password).not.toBe(other.password);
	});

	it('never reaches a log line, however far the logging is turned up', async () => {
		const password = 'rahasia-yang-tidak-boleh-tercatat-di-log';
		const email = 'password-not-logged@komplek.local';
		const lines: string[] = [];
		const noisy = createAuth({
			db: testDb.db,
			clock,
			baseURL: TEST_ORIGIN,
			secret: TEST_SECRET,
			logger: {
				level: 'debug',
				disabled: false,
				log: (level, message, ...args) => {
					lines.push([level, message, ...args.map((arg) => String(arg))].join(' '));
				}
			}
		});
		// Anything that bypasses better-auth's own logger and writes straight to the console is
		// caught here instead.
		const console_ = ['debug', 'log', 'info', 'warn', 'error'] as const;
		for (const method of console_) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				lines.push(args.map((arg) => String(arg)).join(' '));
			});
		}

		await noisy.api.signUpEmail({ body: { name: 'Warga Uji', email, password } });
		await refusalCode(noisy.api.signInEmail({ body: { email, password } }));
		await refusalCode(noisy.api.signInEmail({ body: { email, password: 'yang salah' } }));

		expect(lines.join('\n')).not.toContain(password);
	});
});

describe('the session cookie', () => {
	it('is unreadable to script, is withheld from cross-site posts, and outlives the browser', async () => {
		const { sessionToken } = getCookies(authentication().options);

		expect(sessionToken.attributes).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: false
		});
		// Thirty days, which is what makes the session survive closing and reopening the browser:
		// a cookie with no max-age would be gone the moment the browser is.
		expect(sessionToken.attributes.maxAge).toBe(30 * 24 * 60 * 60);
	});

	it('is marked Secure and prefixed when the application answers on https', () => {
		const overHttps = createAuth({
			db: testDb.db,
			clock,
			baseURL: 'https://komplek.example',
			secret: TEST_SECRET
		});

		const { sessionToken } = getCookies(overHttps.options);

		expect(sessionToken.attributes.secure).toBe(true);
		// The `__Secure-` prefix is a browser rule, not a hint: a page served over plain http
		// cannot set or overwrite a cookie whose name starts with it.
		expect(sessionToken.name.startsWith('__Secure-')).toBe(true);
	});

	it.each([
		{ origin: 'https://komplek.example', secure: true },
		{ origin: 'HTTPS://komplek.example', secure: true },
		{ origin: 'http://localhost:5173', secure: false },
		{ origin: 'http://komplek.example', secure: false }
	])('treats $origin as secure=$secure', ({ origin, secure }) => {
		expect(isSecureOrigin(origin)).toBe(secure);
	});
});

describe('reading the settings out of the environment', () => {
	it.each([
		{ name: 'missing', environment: {} },
		{ name: 'blank', environment: { BETTER_AUTH_SECRET: '   ' } },
		{
			name: 'too short to be worth signing with',
			environment: { BETTER_AUTH_SECRET: 'terlalu-pendek' }
		}
	])('refuses a secret that is $name, naming the variable', ({ environment }) => {
		expect(() => readAuthSecret(environment)).toThrow(/BETTER_AUTH_SECRET/);
	});

	it.each([
		{ name: 'missing', environment: {} },
		{ name: 'not an absolute address', environment: { ORIGIN: 'localhost:5173' } }
	])('refuses an origin that is $name, naming the variable', ({ environment }) => {
		expect(() => readOrigin(environment)).toThrow(/ORIGIN/);
	});

	it('accepts an origin and a secret that are both usable', () => {
		const environment = { ORIGIN: TEST_ORIGIN, BETTER_AUTH_SECRET: TEST_SECRET };

		expect(readOrigin(environment)).toBe(TEST_ORIGIN);
		expect(readAuthSecret(environment)).toBe(TEST_SECRET);
	});
});
