import { like, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rateLimitBuckets } from '$lib/server/db/schema/rate-limit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	callerAddress,
	clearEmailBucket,
	consumeRateLimit,
	countBuckets,
	MAXIMUM_SUBJECT_LENGTH,
	normalizeEmail,
	RATE_LIMIT_POLICY,
	UNKNOWN_ADDRESS,
	type RateLimitDecision,
	type RateLimitPolicy
} from '$lib/server/rate-limit';

/**
 * The form-action rate limiter (#60), against a real PostgreSQL: the properties that matter are
 * properties of one atomic upsert and of a delete, and a fake table would prove nothing about
 * either. Time is a `FakeClock`, so a window ends when the test says it does rather than a minute
 * later.
 *
 * Every test writes its own subjects — a fresh address, fresh emails, sometimes a policy of its own
 * — because the file shares one schema and the sweep is global: a test that moved its clock past
 * another test's window would otherwise be able to empty that test's buckets.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-01-01T00:00:00.000Z';

/** One minute, the window of the short policy below. */
const MINUTE = 60_000;

/** A policy small enough to exhaust in a handful of calls. */
const SHORT: RateLimitPolicy = {
	action: 'test-short',
	perAddress: { limit: 6, windowMilliseconds: MINUTE },
	perEmail: { limit: 3, windowMilliseconds: MINUTE }
};

/** The same limits under a different name, for the tests about actions not sharing buckets. */
const OTHER: RateLimitPolicy = { ...SHORT, action: 'test-other' };

/** Makes every subject in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** A fresh address in the TEST-NET-3 range, one per call. */
function anAddress(): string {
	return `203.0.113.${(sequence += 1) % 250}-${sequence}`;
}

/** A fresh email, one per call. */
function anEmail(): string {
	return `${unique('warga')}@komplek.local`;
}

/** Counts one attempt and returns the decision. */
function attempt(
	clock: FakeClock,
	policy: RateLimitPolicy,
	address: string,
	email: string
): Promise<RateLimitDecision> {
	return consumeRateLimit(testDb.db, clock, policy, { address, email });
}

/** The `retryAt` of a refusal; fails the test when the request was allowed instead. */
function retryAtOf(decision: RateLimitDecision): Date {
	if (decision.allowed) {
		throw new Error('The request was allowed, so there is no retryAt to read.');
	}
	return decision.retryAt;
}

describe('consumeRateLimit', () => {
	it('allows every attempt up to the email limit and refuses the one after it', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();

		const allowed = [];
		for (let attemptNumber = 0; attemptNumber < SHORT.perEmail.limit; attemptNumber += 1) {
			allowed.push(await attempt(clock, SHORT, address, email));
		}
		const refused = await attempt(clock, SHORT, address, email);

		expect(allowed.every((decision) => decision.allowed)).toBe(true);
		expect(refused.allowed).toBe(false);
		expect(retryAtOf(refused).toISOString()).toBe(
			new Date(Date.parse(START) + MINUTE).toISOString()
		);
	});

	it('refuses an address that rotates through emails once its own budget is used', async () => {
		// The attack the address bucket exists for: one guess per address on the resident list.
		const clock = new FakeClock(START);
		const address = anAddress();

		const allowed = [];
		for (let attemptNumber = 0; attemptNumber < SHORT.perAddress.limit; attemptNumber += 1) {
			allowed.push(await attempt(clock, SHORT, address, anEmail()));
		}
		const refused = await attempt(clock, SHORT, address, anEmail());

		expect(allowed.every((decision) => decision.allowed)).toBe(true);
		expect(refused.allowed).toBe(false);
	});

	it('lets an exhausted email through again once its window has ended', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		for (let attemptNumber = 0; attemptNumber <= SHORT.perEmail.limit; attemptNumber += 1) {
			await attempt(clock, SHORT, address, email);
		}
		expect((await attempt(clock, SHORT, address, email)).allowed).toBe(false);

		clock.advance(MINUTE);

		expect((await attempt(clock, SHORT, address, email)).allowed).toBe(true);
	});

	it('counts refused attempts without extending the window they fall in', async () => {
		// Hammering a refused bucket must not keep a resident locked out for as long as the attacker
		// likes: the window still ends one minute after its first attempt.
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		for (let attemptNumber = 0; attemptNumber < SHORT.perEmail.limit; attemptNumber += 1) {
			await attempt(clock, SHORT, address, email);
		}

		clock.advance(MINUTE / 2);
		const refused = await attempt(clock, SHORT, address, email);
		const stillRefused = await attempt(clock, SHORT, address, email);
		clock.advance(MINUTE / 2);
		const allowedAgain = await attempt(clock, SHORT, address, email);

		expect(refused.allowed).toBe(false);
		expect(stillRefused.allowed).toBe(false);
		expect(retryAtOf(stillRefused).toISOString()).toBe(
			new Date(Date.parse(START) + MINUTE).toISOString()
		);
		expect(allowedAgain.allowed).toBe(true);
	});

	it('keeps one action apart from another for the same caller and email', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		for (let attemptNumber = 0; attemptNumber <= SHORT.perEmail.limit; attemptNumber += 1) {
			await attempt(clock, SHORT, address, email);
		}
		expect((await attempt(clock, SHORT, address, email)).allowed).toBe(false);

		expect((await attempt(clock, OTHER, address, email)).allowed).toBe(true);
	});

	it('keeps one email apart from another under the same address', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const blocked = anEmail();
		for (let attemptNumber = 0; attemptNumber <= SHORT.perEmail.limit; attemptNumber += 1) {
			await attempt(clock, SHORT, address, blocked);
		}
		expect((await attempt(clock, SHORT, address, blocked)).allowed).toBe(false);

		expect((await attempt(clock, SHORT, address, anEmail())).allowed).toBe(true);
	});

	it('treats the same email in another case, with spaces around it, as one bucket', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		const spellings = [email, ` ${email} `, email.toUpperCase()];

		for (let attemptNumber = 0; attemptNumber < SHORT.perEmail.limit; attemptNumber += 1) {
			const spelling = spellings[attemptNumber % spellings.length];
			expect((await attempt(clock, SHORT, address, spelling)).allowed).toBe(true);
		}

		expect((await attempt(clock, SHORT, address, `  ${email.toUpperCase()}`)).allowed).toBe(false);
	});

	it('answers with the later expiry when both buckets refuse', async () => {
		const policy: RateLimitPolicy = {
			action: unique('test-both'),
			perAddress: { limit: 1, windowMilliseconds: 2 * MINUTE },
			perEmail: { limit: 1, windowMilliseconds: MINUTE }
		};
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		await attempt(clock, policy, address, email);

		const refused = await attempt(clock, policy, address, email);

		expect(retryAtOf(refused).toISOString()).toBe(
			new Date(Date.parse(START) + 2 * MINUTE).toISOString()
		);
	});

	it('counts a parallel burst one attempt at a time, so none of it slips under the limit', async () => {
		// A read-then-write limiter would let every request in a burst read "0" and let them all
		// through. The upsert takes the row lock inside PostgreSQL, so exactly `limit` succeed.
		const policy: RateLimitPolicy = {
			action: unique('test-burst'),
			perAddress: { limit: 100, windowMilliseconds: MINUTE },
			perEmail: { limit: 3, windowMilliseconds: MINUTE }
		};
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		const burst = Array.from({ length: 12 }, () => attempt(clock, policy, address, email));

		const decisions = await Promise.all(burst);

		expect(decisions.filter((decision) => decision.allowed)).toHaveLength(policy.perEmail.limit);
		expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(
			12 - policy.perEmail.limit
		);
	});

	it('sweeps every expired bucket the next time anything is counted', async () => {
		const policy: RateLimitPolicy = { ...SHORT, action: unique('test-sweep') };
		const clock = new FakeClock(START);
		const address = anAddress();
		await attempt(clock, policy, address, anEmail());
		await attempt(clock, policy, address, anEmail());
		// One address bucket and two email buckets.
		expect(await countBuckets(testDb.db, policy)).toBe(3);

		clock.advance(MINUTE);
		await attempt(clock, policy, anAddress(), anEmail());

		// Only the two buckets the last attempt wrote are left.
		expect(await countBuckets(testDb.db, policy)).toBe(2);
	});

	it('does not sweep a bucket whose window is still running', async () => {
		const policy: RateLimitPolicy = { ...SHORT, action: unique('test-keep') };
		const clock = new FakeClock(START);
		await attempt(clock, policy, anAddress(), anEmail());

		clock.advance(MINUTE - 1);
		await attempt(clock, policy, anAddress(), anEmail());

		expect(await countBuckets(testDb.db, policy)).toBe(4);
	});

	it('bounds the subject it keys on, so a huge email field writes a small row', async () => {
		const policy: RateLimitPolicy = { ...SHORT, action: unique('test-long') };
		const clock = new FakeClock(START);
		const hugeEmail = `${'a'.repeat(5_000)}@komplek.local`;

		await attempt(clock, policy, anAddress(), hugeEmail);

		const rows = await testDb.db
			.select({ key: rateLimitBuckets.key })
			.from(rateLimitBuckets)
			.where(like(rateLimitBuckets.key, `${policy.action}:email:%`));
		expect(rows).toHaveLength(1);
		expect(rows[0].key.length).toBe(`${policy.action}:email:`.length + MAXIMUM_SUBJECT_LENGTH);
	});
});

describe('clearEmailBucket', () => {
	it('forgets the email and leaves the address bucket counting', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		for (let attemptNumber = 0; attemptNumber < SHORT.perEmail.limit; attemptNumber += 1) {
			await attempt(clock, SHORT, address, email);
		}
		expect((await attempt(clock, SHORT, address, email)).allowed).toBe(false);

		await clearEmailBucket(testDb.db, SHORT, email);

		// The email is forgiven: the address bucket stands at 4 of 6, so this one is the fifth.
		expect((await attempt(clock, SHORT, address, email)).allowed).toBe(true);
		// The address was not forgiven: one more takes it to 6, and the one after that is refused.
		expect((await attempt(clock, SHORT, address, anEmail())).allowed).toBe(true);
		expect((await attempt(clock, SHORT, address, anEmail())).allowed).toBe(false);
	});

	it('forgives the email however it was spelled', async () => {
		const clock = new FakeClock(START);
		const address = anAddress();
		const email = anEmail();
		for (let attemptNumber = 0; attemptNumber <= SHORT.perEmail.limit; attemptNumber += 1) {
			await attempt(clock, SHORT, address, email);
		}

		await clearEmailBucket(testDb.db, SHORT, ` ${email.toUpperCase()} `);

		expect((await attempt(clock, SHORT, address, email)).allowed).toBe(true);
	});
});

describe('callerAddress', () => {
	it('returns the address the adapter resolved, trimmed', () => {
		expect(callerAddress({ getClientAddress: () => ' 203.0.113.9 ' })).toBe('203.0.113.9');
	});

	it.each([
		{
			what: 'the adapter throws',
			getClientAddress: (): string => {
				throw new Error('ADDRESS_HEADER=x-forwarded-for but is absent from request');
			}
		},
		{ what: 'the adapter answers an empty string', getClientAddress: (): string => '' }
	])('answers the shared unknown address when $what', ({ getClientAddress }) => {
		expect(callerAddress({ getClientAddress })).toBe(UNKNOWN_ADDRESS);
	});
});

describe('normalizeEmail', () => {
	it('trims and lower-cases', () => {
		expect(normalizeEmail('  Warga@Example.COM ')).toBe('warga@example.com');
	});
});

describe('RATE_LIMIT_POLICY', () => {
	it('gives every guarded action a name of its own, so no two share a bucket', () => {
		const actions = Object.values(RATE_LIMIT_POLICY).map((policy) => policy.action);
		expect(new Set(actions).size).toBe(actions.length);
	});

	it.each(Object.values(RATE_LIMIT_POLICY))(
		'$action holds the email to fewer attempts than the address, over a positive window',
		(policy) => {
			expect(policy.perEmail.limit).toBeGreaterThan(0);
			expect(policy.perEmail.limit).toBeLessThan(policy.perAddress.limit);
			expect(policy.perEmail.windowMilliseconds).toBeGreaterThan(0);
			expect(policy.perAddress.windowMilliseconds).toBeGreaterThan(0);
		}
	);
});

describe('the migration', () => {
	it('created rate_limit_buckets', async () => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = 'rate_limit_buckets'`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it('creates the rate_limit_buckets_expires_at_idx index the sweep relies on', async () => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from pg_indexes
			    where schemaname = ${testDb.schemaName}
			      and indexname = 'rate_limit_buckets_expires_at_idx'`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it('refuses a bucket with no hits', async () => {
		await expect(
			testDb.db
				.insert(rateLimitBuckets)
				.values({ key: unique('test-zero'), hits: 0, expiresAt: new Date(START) })
				.execute()
		).rejects.toMatchObject({
			cause: { code: '23514', constraint: 'rate_limit_buckets_hits_check' }
		});
	});
});
