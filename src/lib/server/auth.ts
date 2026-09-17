import { getRequestEvent } from '$app/server';
import { betterAuth, type BetterAuthPlugin, type Logger } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { database, type Database } from './db';
import { account, session, user, verification } from './db/schema/auth';
import { enqueueEmail } from './email/queue';
import {
	PASSWORD_RESET_KIND,
	PASSWORD_RESET_LIFETIME_SECONDS,
	passwordResetPayload
} from './email/templates/password-reset';
import {
	VERIFY_EMAIL_KIND,
	VERIFY_EMAIL_LIFETIME_SECONDS,
	verifyEmailPayload
} from './email/templates/verify-email';
import { systemClock, type Clock } from './ports/clock';

/**
 * better-auth, configured for this application. This module is the only place that decides how
 * someone signs in, how long a session lasts, and what a cookie carrying one looks like.
 *
 * ## Decisions settled here
 *
 * 1. **A factory first, a singleton second**, the same shape as `./db/index.ts` and for the same
 *    reason: a test needs an instance bound to its own schema and its own fake clock, and an
 *    instance built at import time would open a connection pool in every process that so much as
 *    mentions this module.
 * 2. **The SvelteKit cookie plugin is passed in, not baked in.** `sveltekitCookies` calls
 *    `getRequestEvent()`, which throws when there is no request in flight, so an instance built
 *    for a unit test must not have it. `auth()` adds it; `createAuth()` on its own does not.
 * 3. **Email is queued, never sent.** Both callbacks below do one `insert` through
 *    `enqueueEmail`. Nothing here awaits `processEmailQueue`, and nothing here talks to a mail
 *    server: an unreachable SMTP host must not be able to fail a registration. The one part of
 *    `../email/queue.ts`'s contract that cannot be honoured here is the transaction: better-auth
 *    hands its callbacks no transaction handle, so the writer passed below is the pool. In 1.7.5
 *    the callback runs after the sign-up has already committed, so nothing can roll back under
 *    it — and the dependency is pinned to that exact version rather than a range, because a minor
 *    release that moved the callback inside the transaction would change that silently.
 * 4. **The links in those emails point at this application's own pages**, not at better-auth's
 *    endpoints. better-auth offers a `url` built from its own `/verify-email` and
 *    `/reset-password/:token` routes; it is ignored in favour of `/verify?token=` and
 *    `/set-password?token=`, so that every word a resident reads on the way through is a page
 *    this repository owns and writes in Indonesian.
 * 5. **An address has to be proven before it can sign in.** `requireEmailVerification` makes
 *    `signInEmail` refuse an unverified account outright, so there is no such thing as a session
 *    belonging to someone who never opened their email. The alternative — letting them in and
 *    checking a flag on every protected page — is one forgotten check away from not being true.
 * 6. **Verification does not sign anyone in.** `autoSignInAfterVerification` stays off. A
 *    verification link travels through an inbox, and a link that mints a session is a link that
 *    signs in whoever reads that inbox. Verifying proves the address; signing in is a separate,
 *    deliberate act with a password.
 * 7. **A failed sign-in does not send mail.** `sendOnSignIn` stays off. Sending on every refused
 *    attempt would turn the login form into a way to post mail to any address a stranger names.
 *    Resending is an explicit request on `/verify` instead.
 * 8. **A password reset ends every session.** `revokeSessionsOnPasswordReset` is on: the usual
 *    reason to reset a password is that someone else may have it, and leaving their session alive
 *    would make the reset pointless.
 *
 * ## What the session cookie looks like, and why
 *
 * better-auth writes one cookie holding an opaque session token — never the user, never a role,
 * never anything a browser could edit into a different answer. Its attributes:
 *
 * - `httpOnly` is on, so script on the page cannot read it. `defaultCookieAttributes` below repeats
 *   it, and `sameSite`, as a statement of intent rather than as a pin: better-auth applies that
 *   object in the same literal as its own identical defaults, so removing the line would change
 *   nothing today. What holds the guarantee is the assertion in `tests/unit/auth.test.ts`, which
 *   reads the attributes off a real `Set-Cookie` header rather than off the configuration.
 * - `sameSite` is `lax`. `strict` was considered and rejected: the verification and reset links
 *   arrive from a mail client, which makes the first navigation into this application a
 *   cross-site one, and under `strict` that request carries no cookie at all. `lax` sends the
 *   cookie on ordinary top-level navigation and withholds it from cross-site form posts and
 *   subresource requests, which is exactly the boundary that matters here.
 * - `secure` follows the origin: on when `ORIGIN` is an `https://` address, off on plain
 *   `http://localhost` where a `Secure` cookie would simply never be stored. better-auth also
 *   prefixes the cookie with `__Secure-` when it is secure, which stops a plaintext response from
 *   overwriting it.
 * - `maxAge` comes from the session lifetime below, which is what makes a session outlive closing
 *   the browser.
 *
 * ## What is deliberately not here
 *
 * Session data is not cached in a cookie (`session.cookieCache` stays off): every request reads
 * the session row, so revoking a session takes effect on the next request rather than up to five
 * minutes later.
 *
 * ## Two things the next ticket has to know
 *
 * **`auth()` may only be called while a request is in flight.** The SvelteKit cookie plugin baked
 * into the singleton calls `getRequestEvent()` on every endpoint, and that throws outside a
 * request. A scheduled job, a seed script or a command-line tool that needs better-auth builds its
 * own instance with `createAuth()` and no plugins.
 *
 * **`ORIGIN` is not decoration.** It is handed to better-auth as `baseURL`, and
 * `svelteKitHandler` only answers `/api/auth/*` when the request's origin matches it exactly —
 * otherwise those addresses fall through to SvelteKit and 404. That is the same requirement
 * SvelteKit's own Node adapter already has for form posts, so there is one variable rather than
 * two that can disagree; but it does mean that serving the application on a port `ORIGIN` does
 * not name leaves `$lib/auth-client.ts` with nothing to call. The pages in this ticket are
 * unaffected: they use form actions and `auth().api.*` directly, neither of which goes through
 * that router.
 */

/** Where each page of the sign-in flow lives, so that a link and its route cannot drift apart. */
export const AUTH_PATHS = {
	login: '/login',
	register: '/register',
	logout: '/logout',
	verify: '/verify',
	forgotPassword: '/forgot-password',
	setPassword: '/set-password'
} as const;

/**
 * The shortest password this application accepts. Length is the only rule: composition rules push
 * people towards `Password1!` and towards writing it down, and a long passphrase beats a short
 * password with a symbol in it.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/** The longest password accepted, which is a limit on how much scrypt is asked to chew, not on how safe a password may be. */
export const MAXIMUM_PASSWORD_LENGTH = 200;

/** How long a session lasts without being used: thirty days. */
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/** How old a session may get before using it pushes its expiry back: one day. */
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

/** The shortest `BETTER_AUTH_SECRET` this application will start with. */
const MINIMUM_SECRET_LENGTH = 32;

/** Everything one better-auth instance needs. */
export interface AuthSettings {
	/** The database it stores users, sessions, accounts and tokens in. */
	readonly db: Database;
	/** The clock the queued emails are stamped with. */
	readonly clock: Clock;
	/**
	 * The origin this application answers on, such as `http://localhost:5173`. It decides the
	 * addresses in outgoing emails and whether the session cookie is marked `Secure`.
	 */
	readonly baseURL: string;
	/** The key every token is signed with. */
	readonly secret: string;
	/**
	 * Extra plugins. `auth()` passes the SvelteKit cookie plugin; a test passes nothing, because
	 * that plugin needs a request in flight.
	 */
	readonly plugins?: BetterAuthPlugin[];
	/**
	 * Where better-auth writes its own log lines. Left out by the running application, which gets
	 * the library's default of warnings and errors on the console. A test hands one in, turned all
	 * the way up, to prove what does *not* end up in it.
	 */
	readonly logger?: Logger;
}

/** Builds a better-auth instance. Every call produces its own. */
export function createAuth(settings: AuthSettings) {
	const { baseURL, clock, db } = settings;

	return betterAuth({
		appName: 'Sistem Informasi dan Manajemen Keuangan Komplek',
		baseURL,
		secret: settings.secret,
		// `undefined` leaves better-auth with its own logger: warnings and errors, on the console.
		logger: settings.logger,
		// Nothing about this installation is reported anywhere. The default is already off; it is
		// written down so that a later default cannot turn it on quietly.
		telemetry: { enabled: false },
		database: drizzleAdapter(db, {
			provider: 'pg',
			// The keys are better-auth's model names and the values are this repository's tables.
			// Passing them explicitly rather than letting the adapter read the whole schema keeps
			// the application's own tables out of its reach.
			schema: { user, session, account, verification },
			// PostgreSQL has transactions, and better-auth uses one to consume a reset token: it
			// reads the row and deletes it together, which is what stops two clicks on the same
			// link from both counting.
			transaction: true
		}),
		emailAndPassword: {
			enabled: true,
			minPasswordLength: MINIMUM_PASSWORD_LENGTH,
			maxPasswordLength: MAXIMUM_PASSWORD_LENGTH,
			requireEmailVerification: true,
			resetPasswordTokenExpiresIn: PASSWORD_RESET_LIFETIME_SECONDS,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user: recipient, token }) => {
				await enqueueEmail(db, clock, {
					recipient: recipient.email,
					kind: PASSWORD_RESET_KIND,
					payload: passwordResetPayload({
						name: recipient.name,
						url: tokenLink(baseURL, AUTH_PATHS.setPassword, token)
					})
				});
			}
		},
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: false,
			autoSignInAfterVerification: false,
			expiresIn: VERIFY_EMAIL_LIFETIME_SECONDS,
			sendVerificationEmail: async ({ user: recipient, token }) => {
				await enqueueEmail(db, clock, {
					recipient: recipient.email,
					kind: VERIFY_EMAIL_KIND,
					payload: verifyEmailPayload({
						name: recipient.name,
						url: tokenLink(baseURL, AUTH_PATHS.verify, token)
					})
				});
			}
		},
		session: {
			expiresIn: SESSION_LIFETIME_SECONDS,
			updateAge: SESSION_REFRESH_SECONDS
		},
		// On for every environment, not only production, with the defaults: three sign-in attempts
		// per ten seconds and three password reset requests per minute. Memory storage is enough
		// because this application is one process.
		//
		// Read this before relying on it: the limiter is middleware on better-auth's own HTTP
		// router, so it covers `/api/auth/*` and nothing else. The pages in this ticket call
		// `auth().api.*` directly — the pattern better-auth documents for SvelteKit form actions —
		// and a direct call never reaches that middleware. `POST /login`, `POST /forgot-password`
		// and `POST /verify?/resend` are therefore not throttled by this setting. Closing that gap
		// needs a limiter that sits in front of form actions, which is a decision for the whole
		// application rather than for this module.
		rateLimit: { enabled: true, storage: 'memory' },
		advanced: {
			useSecureCookies: isSecureOrigin(baseURL),
			defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' }
		},
		plugins: settings.plugins ?? []
	});
}

/** A better-auth instance as this application configures it. */
export type Auth = ReturnType<typeof createAuth>;

/** Whether an origin is one a browser will store a `Secure` cookie for. */
export function isSecureOrigin(baseURL: string): boolean {
	return baseURL.trim().toLowerCase().startsWith('https://');
}

/** Builds a link to one of this application's pages, carrying a token. */
function tokenLink(baseURL: string, path: string, token: string): string {
	return `${baseURL.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

let instance: Auth | undefined;

/**
 * The running application's better-auth, built once on first call. Routes and `hooks.server.ts`
 * use this; tests do not — they build their own with `createAuth()`.
 */
export function auth(): Auth {
	instance ??= createAuth({
		db: database(),
		clock: systemClock,
		baseURL: readOrigin(),
		secret: readAuthSecret(),
		// Last in the array, as the plugin's own guard asks: it copies whatever `Set-Cookie` the
		// other hooks ended up producing onto the SvelteKit response, which is what makes a form
		// action able to sign someone in.
		plugins: [sveltekitCookies(getRequestEvent)]
	});
	return instance;
}

/**
 * Reads the origin this application answers on.
 *
 * `ORIGIN` already exists and already means this — SvelteKit's Node adapter checks form posts
 * against it — so better-auth reads the same line rather than a `BETTER_AUTH_URL` that could
 * disagree with it.
 *
 * @throws {Error} naming the variable when it is missing or is not an absolute http(s) address.
 */
export function readOrigin(environment: NodeJS.ProcessEnv = process.env): string {
	const origin = environment.ORIGIN?.trim();
	if (!origin) {
		throw new Error(
			'Environment variable ORIGIN is not set. Copy .env.example to .env; ORIGIN is the address this application answers on, for example http://localhost:5173.'
		);
	}
	if (!/^https?:\/\/\S+$/.test(origin)) {
		throw new Error(
			`Environment variable ORIGIN is "${origin}", which is not an absolute address. It has to start with http:// or https://, for example http://localhost:5173.`
		);
	}
	return origin;
}

/**
 * Reads the key every session token, verification link and reset link is signed with.
 *
 * @throws {Error} naming the variable when it is missing or too short. A short secret is the one
 *   failure here that nothing else would report: tokens would still be signed, still be accepted,
 *   and still be forgeable.
 */
export function readAuthSecret(environment: NodeJS.ProcessEnv = process.env): string {
	const secret = environment.BETTER_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			'Environment variable BETTER_AUTH_SECRET is not set. Copy .env.example to .env, then put a value of your own there; generate one with `openssl rand -base64 32`.'
		);
	}
	if (secret.length < MINIMUM_SECRET_LENGTH) {
		throw new Error(
			`Environment variable BETTER_AUTH_SECRET is ${secret.length} characters long, and it has to be at least ${MINIMUM_SECRET_LENGTH}. Generate one with \`openssl rand -base64 32\`.`
		);
	}
	return secret;
}
