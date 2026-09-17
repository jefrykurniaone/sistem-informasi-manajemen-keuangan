import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { emailQueue, scaffoldProbe, type QueuedEmail } from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';
import {
	claimDueEmails,
	enqueueEmail,
	markEmailFailed,
	markEmailSent,
	recordEmailRetry
} from '$lib/server/email/queue';
import { FakeClock } from '$lib/server/ports/fakes';

/**
 * The email queue table and the operations on it, against a real PostgreSQL.
 *
 * These tests commit. That is the point of the harness this file uses: what the queue promises is
 * about what survives a commit — an email that is in the table because the action that asked for
 * it committed, and an attempt that is counted because it really was started.
 *
 * Rows from earlier tests stay in the schema for the whole file, so each test gives its rows a
 * `kind` of their own and reads back only those. A claim always takes whatever else is due as
 * well, which is exactly what it does in production.
 */

const testDb = testDatabase();

/** The instant most clocks in this file start at. */
const START = '2026-01-01T00:00:00.000Z';

/** One minute. */
const MINUTE = 60 * 1000;

/** A limit high enough to take every row this file ever queues. */
const EVERYTHING = 100;

/** A retry policy with round numbers, so a test asserting on a deadline reads clearly. */
const fixedDelay = (attempt: number): number => attempt * MINUTE;

/** Claims everything that is due, and keeps only the rows of one kind. */
async function claimKind(kind: string, clock: FakeClock): Promise<readonly QueuedEmail[]> {
	const claimed = await claimDueEmails(testDb.db, {
		clock,
		limit: EVERYTHING,
		retryDelayMilliseconds: fixedDelay
	});
	return claimed.filter((row) => row.kind === kind);
}

/** Reads one row back, as it now stands in the database. */
async function reread(id: string): Promise<QueuedEmail> {
	const [row] = await testDb.db.select().from(emailQueue).where(eq(emailQueue.id, id));
	return row;
}

/** Every row of one kind. */
async function rowsOf(kind: string): Promise<QueuedEmail[]> {
	return testDb.db.select().from(emailQueue).where(eq(emailQueue.kind, kind));
}

/** The name of the constraint a database error broke, when it broke one. */
function brokenConstraint(error: unknown): string | undefined {
	let current: unknown = error;
	while (current instanceof Error) {
		if ('constraint' in current && typeof current.constraint === 'string') {
			return current.constraint;
		}
		current = current.cause;
	}
	return undefined;
}

describe('enqueueEmail', () => {
	it('adds an email that is pending, untried, and due at once', async () => {
		const clock = new FakeClock(START);

		const row = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'enqueue-shape',
			payload: { invoiceId: 'b2b4', amount: rupiah(150_000) }
		});

		expect(row).toMatchObject({
			recipient: 'warga@komplek.local',
			kind: 'enqueue-shape',
			status: 'pending',
			attempts: 0,
			lastError: null,
			sentAt: null
		});
		expect(row.nextAttemptAt.getTime()).toBe(Date.parse(START));
	});

	it('takes every instant from the clock it was given, never from the database', async () => {
		// A column filled by `now()` is a column a fake clock cannot reach, and every rule about
		// retries and deadlines in this application is a rule about the clock's time.
		const clock = new FakeClock('2027-07-07T07:07:07.000Z');

		const row = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'enqueue-clock'
		});

		expect(row.createdAt.getTime()).toBe(Date.parse('2027-07-07T07:07:07.000Z'));
		expect(row.nextAttemptAt.getTime()).toBe(Date.parse('2027-07-07T07:07:07.000Z'));
	});

	it('stores the payload and reads back exactly what it was given', async () => {
		const payload = {
			invoiceId: 'b2b4',
			amount: 150_000,
			period: '2026-01',
			overdue: true,
			units: ['A-1', 'A-2']
		};

		const row = await enqueueEmail(testDb.db, new FakeClock(START), {
			recipient: 'warga@komplek.local',
			kind: 'enqueue-payload',
			payload
		});

		expect((await reread(row.id)).payload).toEqual(payload);
	});

	it('takes an empty payload for an email that needs no values', async () => {
		const row = await enqueueEmail(testDb.db, new FakeClock(START), {
			recipient: 'warga@komplek.local',
			kind: 'enqueue-empty-payload'
		});

		expect(row.payload).toEqual({});
	});

	it.each([
		{ name: 'a blank recipient', recipient: '  ', kind: 'invitation' },
		{ name: 'no recipient at all', recipient: '', kind: 'invitation' },
		{ name: 'a blank kind', recipient: 'warga@komplek.local', kind: '   ' }
	])('refuses $name, which could never be delivered', async ({ recipient, kind }) => {
		await expect(
			enqueueEmail(testDb.db, new FakeClock(START), { recipient, kind })
		).rejects.toThrow(TypeError);
	});

	it('commits with the action that asked for it', async () => {
		// The shape every service follows: the change and the email it causes are one transaction.
		await testDb.db.transaction(async (transaction) => {
			await transaction
				.insert(scaffoldProbe)
				.values({ description: 'an action that succeeds', amount: rupiah(1) });
			await enqueueEmail(transaction, new FakeClock(START), {
				recipient: 'warga@komplek.local',
				kind: 'enqueue-committed'
			});
		});

		expect(await rowsOf('enqueue-committed')).toHaveLength(1);
	});

	it('is rolled back with the action that asked for it, so no email promises what did not happen', async () => {
		await expect(
			testDb.db.transaction(async (transaction) => {
				await enqueueEmail(transaction, new FakeClock(START), {
					recipient: 'warga@komplek.local',
					kind: 'enqueue-rolled-back'
				});
				throw new Error('the action failed after queueing its email');
			})
		).rejects.toThrow('the action failed');

		expect(await rowsOf('enqueue-rolled-back')).toHaveLength(0);
	});
});

describe('claimDueEmails', () => {
	it('takes a due email, counts the attempt, and moves its next attempt forward', async () => {
		const clock = new FakeClock(START);
		const queued = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'claim-one'
		});

		const [claimed] = await claimKind('claim-one', clock);

		expect(claimed.id).toBe(queued.id);
		expect(claimed.attempts).toBe(1);
		expect(claimed.nextAttemptAt.getTime()).toBe(Date.parse(START) + MINUTE);
	});

	it('writes the claim down, so a second worker does not find the row untouched', async () => {
		const clock = new FakeClock(START);
		const queued = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'claim-persisted'
		});

		await claimKind('claim-persisted', clock);

		const stored = await reread(queued.id);
		expect(stored.attempts).toBe(1);
		expect(stored.nextAttemptAt.getTime()).toBe(Date.parse(START) + MINUTE);
	});

	it('leaves an email whose next attempt is still in the future', async () => {
		const clock = new FakeClock(START);
		await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'claim-not-due'
		});
		await claimKind('claim-not-due', clock);

		expect(await claimKind('claim-not-due', clock)).toHaveLength(0);
	});

	it('takes an email again once its delay has passed', async () => {
		const clock = new FakeClock(START);
		await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'claim-again'
		});
		await claimKind('claim-again', clock);

		clock.advance(MINUTE);

		expect((await claimKind('claim-again', clock))[0]?.attempts).toBe(2);
	});

	it('takes the emails with the earliest deadline first', async () => {
		const clock = new FakeClock('2026-02-01T00:00:00.000Z');
		await enqueueEmail(testDb.db, clock, {
			recipient: 'second@komplek.local',
			kind: 'claim-order'
		});
		clock.advance(MINUTE);
		await enqueueEmail(testDb.db, clock, {
			recipient: 'third@komplek.local',
			kind: 'claim-order'
		});
		clock.set('2026-01-31T00:00:00.000Z');
		await enqueueEmail(testDb.db, clock, {
			recipient: 'first@komplek.local',
			kind: 'claim-order'
		});

		clock.set('2026-03-01T00:00:00.000Z');
		const claimed = await claimKind('claim-order', clock);

		expect(claimed.map((row) => row.recipient)).toEqual([
			'first@komplek.local',
			'second@komplek.local',
			'third@komplek.local'
		]);
	});

	it('takes no more than the limit', async () => {
		const clock = new FakeClock('2026-04-01T00:00:00.000Z');
		for (const name of ['a', 'b', 'c']) {
			await enqueueEmail(testDb.db, clock, {
				recipient: `${name}@komplek.local`,
				kind: 'claim-limit'
			});
		}

		const claimed = await claimDueEmails(testDb.db, {
			clock,
			limit: 2,
			retryDelayMilliseconds: fixedDelay
		});

		expect(claimed).toHaveLength(2);
	});

	it.each([0, -1, 1.5])('refuses a limit of %s', async (limit) => {
		await expect(
			claimDueEmails(testDb.db, {
				clock: new FakeClock(START),
				limit,
				retryDelayMilliseconds: fixedDelay
			})
		).rejects.toThrow(TypeError);
	});

	it.each(['sent', 'failed'] as const)(
		'never takes an email that is already %s',
		async (status) => {
			const clock = new FakeClock('2026-05-01T00:00:00.000Z');
			const kind = `claim-${status}`;
			const queued = await enqueueEmail(testDb.db, clock, {
				recipient: 'warga@komplek.local',
				kind
			});
			if (status === 'sent') {
				await markEmailSent(testDb.db, clock, queued.id);
			} else {
				await markEmailFailed(testDb.db, queued.id, 'given up on');
			}

			expect(await claimKind(kind, clock)).toHaveLength(0);
		}
	);
});

describe('recording what happened to an email', () => {
	it('marks one sent, with the instant it left and no error left over', async () => {
		const clock = new FakeClock(START);
		const queued = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'record-sent'
		});
		await recordEmailRetry(testDb.db, queued.id, 'a failure that was later overcome');

		clock.advance(MINUTE);
		await markEmailSent(testDb.db, clock, queued.id);

		const stored = await reread(queued.id);
		expect(stored).toMatchObject({ status: 'sent', lastError: null });
		expect(stored.sentAt?.getTime()).toBe(Date.parse(START) + MINUTE);
	});

	it('keeps a retrying email pending, and writes down why the attempt failed', async () => {
		const clock = new FakeClock(START);
		const queued = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'record-retry'
		});

		await recordEmailRetry(testDb.db, queued.id, 'connect ECONNREFUSED');

		expect(await reread(queued.id)).toMatchObject({
			status: 'pending',
			lastError: 'connect ECONNREFUSED'
		});
	});

	it('marks one failed, and keeps the reason so the row can be explained', async () => {
		const clock = new FakeClock(START);
		const queued = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'record-failed'
		});

		await markEmailFailed(testDb.db, queued.id, '550 no such mailbox');

		expect(await reread(queued.id)).toMatchObject({
			status: 'failed',
			lastError: '550 no such mailbox'
		});
	});
});

describe('the email_queue table', () => {
	it('refuses a status that is not one of the three, whatever writes it', async () => {
		// The check constraint, proven from outside the type system: a status that only TypeScript
		// forbids is a status a raw statement can still write.
		const failure: unknown = await testDb.db
			.execute(
				sql`insert into email_queue (recipient, kind, payload, status, attempts, next_attempt_at, created_at)
				    values ('warga@komplek.local', 'constraint', '{}'::jsonb, 'sending', 0, now(), now())`
			)
			.catch((error: unknown) => error);

		expect(brokenConstraint(failure)).toBe('email_queue_status_check');
	});
});
