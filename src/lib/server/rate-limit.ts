import type { RequestEvent } from '@sveltejs/kit';
import { eq, like, lte, sql } from 'drizzle-orm';
import { database, type Database } from './db';
import { rateLimitBuckets } from './db/schema/rate-limit';
import { systemClock, type Clock } from './ports/clock';

/**
 * The rate limiter a public form action calls before it does its work.
 *
 * ## Why this exists next to better-auth's own limiter
 *
 * `src/lib/server/auth.ts` turns on `rateLimit`, and that setting stays on. It is middleware on
 * better-auth's HTTP router, so it guards `/api/auth/*` — the addresses `$lib/auth-client.ts` calls
 * from the browser — and nothing else. The sign-in, forgot-password and resend-verification pages
 * call `auth().api.*` directly from a form action, which is the pattern better-auth documents for
 * SvelteKit, and a direct call never passes through that middleware. Without this module,
 * `POST /login` is unlimited password guessing against any known address, and `POST
 * /forgot-password` and `POST /verify?/resend` are unlimited mail to any registered address plus
 * unlimited growth of `email_queue` by someone who has never signed in.
 *
 * ## How a form action uses it
 *
 * ```ts
 * export const actions: Actions = {
 *   default: async (event) => {
 *     const form = await event.request.formData();
 *     const email = String(form.get('email') ?? '').trim();
 *     // …reject a blank form first: that answer touches nothing and reveals nothing…
 *     const decision = await limitFormAction(event, RATE_LIMIT_POLICY.login, email);
 *     if (!decision.allowed) {
 *       return fail(429, { email, message: TOO_MANY_ATTEMPTS });
 *     }
 *     // …only now call auth().api.* or anything else that costs something…
 *   }
 * };
 * ```
 *
 * A later ticket that adds a public form action adds one entry to `RATE_LIMIT_POLICY` — the action
 * name, and a limit and window for each of the two keys — and calls `limitFormAction` with it
 * before doing anything that sends mail, hashes a password or writes a row. Three rules hold for
 * every caller:
 *
 * 1. **The check runs before the work, never after.** The whole point is that a refused request
 *    costs nothing: no scrypt, no queued email, no row.
 * 2. **The refused answer is one sentence, the same for every email.** The limiter counts a
 *    registered address and an unregistered one identically, because it never looks either up;
 *    the route has to keep that property by answering both with the same `fail(429, …)` and
 *    nothing else. #11 closed the account-enumeration leak on these pages and a limiter that
 *    answered differently would be the easiest way to reopen it.
 * 3. **The route translates; this module never does.** `RateLimitDecision` is a value, not an
 *    error, and the Indonesian sentence and the 429 live in the route, the same split
 *    `$lib/errors` records for `PermissionDeniedError`.
 *
 * ## Decisions settled here
 *
 * **Counts live in PostgreSQL, in `rate_limit_buckets`, not in process memory.** Memory would be
 * enough for one process on one day, and it was the tempting choice. It was rejected for three
 * reasons, in order of weight. A memory counter is emptied by every restart and by every `vite
 * dev` reload, and a limiter that forgets on restart is a limiter an attacker waits out. The test
 * contract of this run is a real PostgreSQL schema per file with real commits, and a memory
 * limiter would either be tested against something other than what runs, or force a store
 * interface with two implementations of which only one is ever exercised in production. And
 * `docker-compose.yml` can start a second `app` container tomorrow without this module changing:
 * a table is shared by construction. The price is one `delete` and two upserts per guarded form
 * post, on a table that holds at most one row per subject seen in the last window, which is
 * nothing next to the scrypt hash the post is about to pay for anyway.
 *
 * **Two keys per request, each with its own limit and window: the caller's address and the
 * normalised email.** Either alone is wrong. An address alone lets one attacker behind one address
 * be throttled while punishing a whole household behind one router with them, and behind a
 * misconfigured proxy it throttles the whole complex as one caller. An email alone lets an
 * attacker rotate through the resident list, one address at a time, each under the limit. Both
 * together mean a stranger gets a few tries per address they name and a few dozen tries in total
 * before they are stopped, while a resident who mistypes twice is never touched. The action name
 * is the first segment of every key, so `/login` and `/forgot-password` do not share a bucket: a
 * resident locked out of guessing their own password can still ask for a reset link.
 *
 * **Fixed windows, not sliding ones or token buckets.** A fixed window is one row and one atomic
 * upsert: `insert … on conflict do update` either starts the window or adds to it, and PostgreSQL
 * serialises two concurrent requests on the row so both are counted — a read-then-write in
 * application code would let a burst of parallel posts all read "0". The known weakness of fixed
 * windows, that a burst can straddle two windows and get up to twice the limit, is accepted: the
 * limits below are set with that factor in mind, and a sliding log would mean one row per attempt
 * rather than one per subject.
 *
 * **Refused attempts are counted too.** Hammering a refused bucket does not extend its window —
 * that would let an attacker keep a resident locked out for as long as they liked — but it does
 * not earn anything either.
 *
 * **A successful sign-in clears the email bucket of `login`, and only that.** The bucket exists to
 * stop guessing against one address, and a success is proof that the person holding the password
 * is present, so leaving a penalty behind would only bite a resident who mistyped four times,
 * succeeded, signed out and came back. Clearing it reveals nothing, because reaching the clearing
 * line already required the password. The address bucket is left alone: it is a cap on volume from
 * one caller, and one member of a household signing in says nothing about the other posts coming
 * from the same router.
 *
 * **Expired rows are swept on every call, before the count.** `consumeRateLimit` first deletes
 * every row whose `expires_at` has passed — one indexed range delete that usually removes nothing
 * — and only then upserts its own two rows. So the table never holds more than one row per subject
 * seen inside the last window, and nothing has to schedule a cleanup job or remember to run one.
 * Correctness does not depend on the sweep: the upsert itself restarts a window whose `expires_at`
 * has passed, so a row the sweep somehow missed is still counted right.
 *
 * **When the adapter cannot say who is calling, every such caller shares one address bucket.**
 * `event.getClientAddress()` throws under adapter-node when `ADDRESS_HEADER` names a header the
 * request does not carry, or when `XFF_DEPTH` asks for more proxies than the `X-Forwarded-For`
 * chain holds — which is what a request that bypassed the proxy looks like. `callerAddress`
 * catches that and answers `UNKNOWN_ADDRESS`, so the form keeps working, the email bucket still
 * holds per address named, and every request without a trustworthy address competes for one
 * shared address bucket. That degraded state is deliberately tighter for the anonymous crowd
 * rather than looser: failing open would hand exactly the callers whose address cannot be trusted
 * an unlimited budget.
 *
 * **No `Retry-After` header.** `fail()` carries no headers, and a route could set one through
 * `event.setHeaders`; it does not, because the sentence it shows already says to wait and the
 * exact number would only help a script schedule its next burst.
 */

/** One minute, in milliseconds. */
const MINUTE_MILLISECONDS = 60_000;

/** One rule: at most `limit` attempts inside any one window of `windowMilliseconds`. */
export interface RateLimitRule {
	readonly limit: number;
	readonly windowMilliseconds: number;
}

/** What one form action is held to: a name for its buckets and a rule for each key. */
export interface RateLimitPolicy {
	/** The first segment of every key this action writes, so actions never share a bucket. */
	readonly action: string;
	/** How often one caller address may post this action. */
	readonly perAddress: RateLimitRule;
	/** How often one email may be named in this action, whoever names it. */
	readonly perEmail: RateLimitRule;
}

/**
 * The limits each guarded form action is held to. The neighbourhood of every number here is set by
 * one question — what does a person clicking through this form ever do? — and then by what the
 * attack the bucket exists to stop needs.
 *
 * - **Sign-in, per email: 5 per minute.** A person retyping a password does it two or three times;
 *   an attacker working a list of common passwords needs thousands. Five a minute is 300 an hour,
 *   which against a 12-character minimum (`MINIMUM_PASSWORD_LENGTH` in `./auth.ts`) is no attack at
 *   all. It is also above better-auth's own default of 3 per 10 seconds, so a resident who is
 *   already refused by that on `/api/auth/*` would not find this page stricter.
 * - **Sign-in, per address: 30 per minute.** A household of several people signing in from one
 *   router, an office of pengurus, or a Playwright run posting every sign-in from `127.0.0.1` all
 *   stay far under it; a stranger rotating through the resident list at one guess per address is
 *   stopped after thirty.
 * - **Forgot-password and resend-verification, per email: 3 per 15 minutes.** Each post queues an
 *   email in the complex's name to whoever holds the address. A person asks once, twice if the
 *   first is slow to arrive; three in a quarter of an hour is the most anyone honest does, and a
 *   fourth arriving the same minute would be the start of the mail-bomb this bucket exists to stop.
 *   The window is fifteen times longer than the sign-in one because the cost of each post here is
 *   borne by the recipient and by `email_queue`, not by the caller.
 * - **Forgot-password and resend-verification, per address: 15 per 15 minutes.** Ten times what
 *   one honest caller needs, so that a household or an office is never touched, and low enough
 *   that one caller cannot fill the queue with more than sixty emails an hour.
 */
export const RATE_LIMIT_POLICY = {
	login: {
		action: 'login',
		perAddress: { limit: 30, windowMilliseconds: MINUTE_MILLISECONDS },
		perEmail: { limit: 5, windowMilliseconds: MINUTE_MILLISECONDS }
	},
	forgotPassword: {
		action: 'forgot-password',
		perAddress: { limit: 15, windowMilliseconds: 15 * MINUTE_MILLISECONDS },
		perEmail: { limit: 3, windowMilliseconds: 15 * MINUTE_MILLISECONDS }
	},
	resendVerification: {
		action: 'resend-verification',
		perAddress: { limit: 15, windowMilliseconds: 15 * MINUTE_MILLISECONDS },
		perEmail: { limit: 3, windowMilliseconds: 15 * MINUTE_MILLISECONDS }
	}
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * The address recorded when the adapter cannot produce one. Every such request shares this one
 * address bucket — see the module header for why that is tighter, not looser.
 */
export const UNKNOWN_ADDRESS = 'unknown';

/**
 * The longest subject — address or email — kept in a key. RFC 5321 caps an address at 254
 * characters and an IPv6 literal is 45, so nothing honest is ever cut; the bound is what keeps a
 * form post carrying a megabyte in the email field from writing a megabyte row.
 */
export const MAXIMUM_SUBJECT_LENGTH = 254;

/** Who is posting, as the limiter keys it. */
export interface RateLimitCaller {
	/** The caller's network address, from `callerAddress`. */
	readonly address: string;
	/** The email the form named. Normalised here; a caller passes it as typed. */
	readonly email: string;
}

/** The limiter's answer. A value rather than an error: the route decides what a refusal looks like. */
export type RateLimitDecision =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			/** The instant after which every bucket that refused this request has started over. */
			readonly retryAt: Date;
	  };

/** The two kinds of key one action writes. */
const KEY_KIND = {
	address: 'address',
	email: 'email'
} as const;

/**
 * The caller's address as the adapter resolves it, or `UNKNOWN_ADDRESS` when it cannot.
 *
 * Under adapter-node the answer honours `ADDRESS_HEADER` and `XFF_DEPTH`, so behind a proxy it is
 * the proxy's job to be configured; the throw this catches is the adapter saying that it was not,
 * or that this one request did not come through the proxy at all.
 */
export function callerAddress(event: Pick<RequestEvent, 'getClientAddress'>): string {
	try {
		return event.getClientAddress().trim() || UNKNOWN_ADDRESS;
	} catch {
		return UNKNOWN_ADDRESS;
	}
}

/**
 * The form of an email the limiter keys on: trimmed and lower-cased, so `Warga@Example.com` and
 * ` warga@example.com` are one bucket rather than two tries at the same account.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Counts one attempt against both of `policy`'s buckets and says whether it may go ahead.
 *
 * Both buckets are always counted, whichever answer comes back, so a refused request and an
 * allowed one run the same statements in the same order and take the same time.
 *
 * @param db the application database, or a test file's own schema. Never a transaction: a count
 *   that rolled back with the caller's work would forget the attempt that was refused.
 */
export async function consumeRateLimit(
	db: Database,
	clock: Clock,
	policy: RateLimitPolicy,
	caller: RateLimitCaller
): Promise<RateLimitDecision> {
	const now = clock.now();
	await sweepExpired(db, now);

	const address = await hit(
		db,
		now,
		keyFor(policy, KEY_KIND.address, caller.address),
		policy.perAddress
	);
	const email = await hit(
		db,
		now,
		keyFor(policy, KEY_KIND.email, normalizeEmail(caller.email)),
		policy.perEmail
	);

	const refusing = [address, email].filter((bucket) => bucket.hits > bucket.limit);
	if (refusing.length === 0) {
		return { allowed: true };
	}
	const retryAt = new Date(Math.max(...refusing.map((bucket) => bucket.expiresAt.getTime())));
	return { allowed: false, retryAt };
}

/**
 * Forgets every attempt counted against `email` for `policy`, leaving the address bucket as it is.
 * The sign-in action calls this after a successful sign-in — see the module header for why that
 * one success, and no other event, earns a reset.
 */
export async function clearEmailBucket(
	db: Database,
	policy: RateLimitPolicy,
	email: string
): Promise<void> {
	await db
		.delete(rateLimitBuckets)
		.where(eq(rateLimitBuckets.key, keyFor(policy, KEY_KIND.email, normalizeEmail(email))));
}

/**
 * `consumeRateLimit` bound to the running application's database and clock, for a form action.
 * Routes call this; tests call `consumeRateLimit` with their own schema and a fake clock.
 */
export function limitFormAction(
	event: Pick<RequestEvent, 'getClientAddress'>,
	policy: RateLimitPolicy,
	email: string
): Promise<RateLimitDecision> {
	return consumeRateLimit(database(), systemClock, policy, {
		address: callerAddress(event),
		email
	});
}

/** `clearEmailBucket` bound to the running application's database, for a form action. */
export function forgiveEmail(policy: RateLimitPolicy, email: string): Promise<void> {
	return clearEmailBucket(database(), policy, email);
}

/**
 * The number of rows currently held for `policy`, whatever their state. For a test proving that
 * the sweep really removes what has expired; nothing in the application reads it.
 */
export async function countBuckets(db: Database, policy: RateLimitPolicy): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(rateLimitBuckets)
		.where(like(rateLimitBuckets.key, `${policy.action}:%`));
	return row?.total ?? 0;
}

/** What one upsert reports back, together with the limit it is measured against. */
interface BucketState {
	readonly hits: number;
	readonly expiresAt: Date;
	readonly limit: number;
}

/** Builds the one key a (policy, kind, subject) triple maps to. */
function keyFor(policy: RateLimitPolicy, kind: string, subject: string): string {
	return `${policy.action}:${kind}:${subject.slice(0, MAXIMUM_SUBJECT_LENGTH)}`;
}

/** Deletes every bucket whose window ended at or before `now`. */
async function sweepExpired(db: Database, now: Date): Promise<void> {
	await db.delete(rateLimitBuckets).where(lte(rateLimitBuckets.expiresAt, now));
}

/**
 * Adds one attempt to `key`'s bucket and returns the count after it, as one atomic statement.
 *
 * A row whose window has ended is restarted in place rather than incremented, which is what makes
 * this correct even when the sweep did not run first. PostgreSQL takes the row lock inside
 * `on conflict do update`, so two of these racing for the same key are counted one after the other
 * and both see their own attempt in the number returned.
 */
async function hit(
	db: Database,
	now: Date,
	key: string,
	rule: RateLimitRule
): Promise<BucketState> {
	const freshExpiry = new Date(now.getTime() + rule.windowMilliseconds);
	const [row] = await db
		.insert(rateLimitBuckets)
		.values({ key, hits: 1, expiresAt: freshExpiry })
		.onConflictDoUpdate({
			target: rateLimitBuckets.key,
			set: {
				hits: sql`case when ${rateLimitBuckets.expiresAt} <= ${now}::timestamptz then 1 else ${rateLimitBuckets.hits} + 1 end`,
				expiresAt: sql`case when ${rateLimitBuckets.expiresAt} <= ${now}::timestamptz then ${freshExpiry}::timestamptz else ${rateLimitBuckets.expiresAt} end`
			}
		})
		.returning({ hits: rateLimitBuckets.hits, expiresAt: rateLimitBuckets.expiresAt });
	return { hits: row.hits, expiresAt: row.expiresAt, limit: rule.limit };
}
