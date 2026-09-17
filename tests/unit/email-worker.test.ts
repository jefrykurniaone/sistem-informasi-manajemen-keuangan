import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { emailQueue, scaffoldProbe, type QueuedEmail } from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';
import { enqueueEmail } from '$lib/server/email/queue';
import {
	MAX_EMAIL_ATTEMPTS,
	processEmailQueue,
	renderQueuedEmail,
	retryDelayMilliseconds,
	type EmailWorkerReport
} from '$lib/server/email/worker';
import {
	PermanentEmailError,
	type EmailMessage,
	type EmailSender,
	type EmailTemplates
} from '$lib/server/ports/email';
import { FakeClock, FakeEmailSender } from '$lib/server/ports/fakes';

/**
 * The worker that empties the email queue, against a real PostgreSQL.
 *
 * Retries and giving up are rules about state that survives a commit — an attempt counted, a
 * deadline written down, a row that stays behind as the record of an email nobody received — so
 * they are tested against a database that really commits, with time supplied by a fake clock
 * rather than by waiting two and a half hours for the real schedule to run out.
 *
 * Each test starts with an empty queue. Emptying it is safe here and only here: this file has a
 * PostgreSQL schema to itself, and a test asserting on "how many were sent" has to know that the
 * batch it is counting is its own.
 */

const testDb = testDatabase();

/** The instant every run starts at. */
const START = '2026-01-01T00:00:00.000Z';

/** One minute. */
const MINUTE = 60 * 1000;

/** The kinds this file can render. A worker is given exactly this much. */
const templates: EmailTemplates = {
	greeting: (payload) => ({
		subject: `Halo ${String(payload.name ?? 'warga')}`,
		text: `Selamat datang, ${String(payload.name ?? 'warga')}.`
	}),
	broken: () => {
		throw new TypeError('this template cannot render anything');
	}
};

/** A sender that fails for some recipients and delivers for the rest. */
class ChoosySender implements EmailSender {
	readonly delivered: string[] = [];
	readonly #refused: ReadonlySet<string>;

	constructor(refused: readonly string[]) {
		this.#refused = new Set(refused);
	}

	async send(message: EmailMessage): Promise<void> {
		if (this.#refused.has(message.to)) {
			throw new Error(`no route to ${message.to}`);
		}
		this.delivered.push(message.to);
	}
}

/** A sender that always fails, the way an unreachable mail server does. */
function unreachableSender(): FakeEmailSender {
	const sender = new FakeEmailSender();
	sender.failWith(new Error('connect ECONNREFUSED 127.0.0.1:1025'));
	return sender;
}

let clock: FakeClock;

beforeEach(async () => {
	clock = new FakeClock(START);
	await testDb.db.delete(emailQueue);
});

/** Runs the worker with this file's templates. */
async function run(sender: EmailSender, batchSize?: number): Promise<EmailWorkerReport> {
	return processEmailQueue({ db: testDb.db, clock, sender, templates, batchSize });
}

/** Queues one greeting and returns its id. */
async function queueGreeting(recipient = 'warga@komplek.local', name = 'Budi'): Promise<string> {
	const row = await enqueueEmail(testDb.db, clock, {
		recipient,
		kind: 'greeting',
		payload: { name }
	});
	return row.id;
}

/** Reads one row back, as it now stands in the database. */
async function reread(id: string): Promise<QueuedEmail> {
	const [row] = await testDb.db.select().from(emailQueue).where(eq(emailQueue.id, id));
	return row;
}

describe('retryDelayMilliseconds', () => {
	it.each([
		{ attempt: 1, delay: MINUTE },
		{ attempt: 2, delay: 5 * MINUTE },
		{ attempt: 3, delay: 25 * MINUTE },
		{ attempt: 4, delay: 125 * MINUTE },
		{ attempt: 5, delay: 625 * MINUTE }
	])('waits $delay milliseconds before attempt $attempt', ({ attempt, delay }) => {
		expect(retryDelayMilliseconds(attempt)).toBe(delay);
	});

	it('grows, so a mail server that is down is not hammered while it is down', () => {
		const delays = [1, 2, 3, 4, 5].map(retryDelayMilliseconds);

		expect(delays).toEqual([...delays].sort((a, b) => a - b));
	});
});

describe('renderQueuedEmail', () => {
	const row: QueuedEmail = {
		id: '00000000-0000-4000-8000-000000000000',
		recipient: 'warga@komplek.local',
		kind: 'greeting',
		payload: { name: 'Budi' },
		status: 'pending',
		attempts: 1,
		nextAttemptAt: new Date(START),
		lastError: null,
		createdAt: new Date(START),
		sentAt: null
	};

	it('renders the template named by the row, over the row payload', () => {
		expect(renderQueuedEmail(row, templates)).toEqual({
			to: 'warga@komplek.local',
			subject: 'Halo Budi',
			text: 'Selamat datang, Budi.'
		});
	});

	it('refuses a kind nobody registered, permanently', () => {
		expect(() => renderQueuedEmail({ ...row, kind: 'unknown-kind' }, templates)).toThrow(
			PermanentEmailError
		);
	});

	it('refuses a kind that names something off Object.prototype', () => {
		// The kind is data read back from a table. `templates['constructor']` would otherwise find
		// a function that is not a template at all and call it.
		expect(() => renderQueuedEmail({ ...row, kind: 'constructor' }, templates)).toThrow(
			PermanentEmailError
		);
	});

	it('turns a template that throws into a permanent failure rather than retrying a bug', () => {
		expect(() => renderQueuedEmail({ ...row, kind: 'broken' }, templates)).toThrow(
			PermanentEmailError
		);
	});
});

describe('processEmailQueue', () => {
	it('does nothing, cheerfully, when there is nothing to send', async () => {
		const sender = new FakeEmailSender();

		expect(await run(sender)).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
	});

	it('sends a due email and marks it sent', async () => {
		const id = await queueGreeting();
		const sender = new FakeEmailSender();

		const report = await run(sender);

		expect(report).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
		expect(await reread(id)).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
	});

	it('writes down when the email left, from the clock it was given', async () => {
		const id = await queueGreeting();
		clock.advance(3 * MINUTE);

		await run(new FakeEmailSender());

		expect((await reread(id)).sentAt?.getTime()).toBe(Date.parse(START) + 3 * MINUTE);
	});

	it('renders the email when it leaves, from the kind and payload on the row', async () => {
		// Nothing rendered was stored at enqueue time, so the text an email carries is the one the
		// template produces now. A wording fix reaches the emails still waiting in the queue.
		await queueGreeting('warga@komplek.local', 'Siti');
		const sender = new FakeEmailSender();

		await run(sender);

		expect(sender.lastMessage).toEqual({
			to: 'warga@komplek.local',
			subject: 'Halo Siti',
			text: 'Selamat datang, Siti.'
		});
	});

	it('leaves an email whose next attempt is still in the future', async () => {
		await queueGreeting();
		await run(unreachableSender());

		const report = await run(new FakeEmailSender());

		expect(report).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0 });
	});

	it('takes no more than the batch it was asked for', async () => {
		for (const name of ['a', 'b', 'c']) {
			await queueGreeting(`${name}@komplek.local`);
		}

		const report = await run(new FakeEmailSender(), 2);

		expect(report).toMatchObject({ claimed: 2, sent: 2 });
	});

	it('keeps sending the rest of the batch when one address fails', async () => {
		// Two hundred monthly reports do not stop at the first bad address.
		for (const name of ['a', 'b', 'c']) {
			await queueGreeting(`${name}@komplek.local`);
		}
		const sender = new ChoosySender(['b@komplek.local']);

		const report = await run(sender);

		expect(report).toEqual({ claimed: 3, sent: 2, retried: 1, failed: 0 });
		expect(sender.delivered).toEqual(['a@komplek.local', 'c@komplek.local']);
	});
});

describe('when an email cannot be sent', () => {
	it('counts the attempt, records why, and leaves it pending for another try', async () => {
		const id = await queueGreeting();

		const report = await run(unreachableSender());

		expect(report).toEqual({ claimed: 1, sent: 1 - 1, retried: 1, failed: 0 });
		expect(await reread(id)).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'connect ECONNREFUSED 127.0.0.1:1025'
		});
	});

	it('waits longer before each following attempt', async () => {
		const id = await queueGreeting();
		const sender = unreachableSender();
		const waits: number[] = [];

		for (let attempt = 1; attempt < MAX_EMAIL_ATTEMPTS; attempt += 1) {
			const before = clock.now().getTime();
			await run(sender);
			const wait = (await reread(id)).nextAttemptAt.getTime() - before;
			waits.push(wait);
			clock.advance(wait);
		}

		expect(waits).toEqual([MINUTE, 5 * MINUTE, 25 * MINUTE, 125 * MINUTE]);
	});

	it('gives up after the last attempt, and keeps the row as the record of what never arrived', async () => {
		const id = await queueGreeting();
		const sender = unreachableSender();

		for (let attempt = 1; attempt <= MAX_EMAIL_ATTEMPTS; attempt += 1) {
			await run(sender);
			clock.advance(retryDelayMilliseconds(attempt));
		}

		expect(await reread(id)).toMatchObject({ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS });
	});

	it('stops trying once it has given up, even when the mail server comes back', async () => {
		const id = await queueGreeting();
		const sender = unreachableSender();
		for (let attempt = 1; attempt <= MAX_EMAIL_ATTEMPTS; attempt += 1) {
			await run(sender);
			clock.advance(retryDelayMilliseconds(attempt));
		}

		const report = await run(new FakeEmailSender());

		expect(report.claimed).toBe(0);
		expect((await reread(id)).status).toBe('failed');
	});

	it('gives up at once when the failure is one that retrying cannot fix', async () => {
		const id = await queueGreeting('tidak-ada@komplek.local');
		const sender = new FakeEmailSender();
		sender.failWith(new PermanentEmailError('550 no such mailbox'));

		const report = await run(sender);

		expect(report).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
		expect(await reread(id)).toMatchObject({
			status: 'failed',
			attempts: 1,
			lastError: '550 no such mailbox'
		});
	});

	it('gives up at once on a kind it has no template for, and says which kind', async () => {
		const row = await enqueueEmail(testDb.db, clock, {
			recipient: 'warga@komplek.local',
			kind: 'a-kind-nobody-registered'
		});

		const report = await run(new FakeEmailSender());

		expect(report).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
		expect((await reread(row.id)).lastError).toContain('a-kind-nobody-registered');
	});

	it('does not fail the action that queued it', async () => {
		// The requirement, stated as the test that proves it: verifying a payment must succeed
		// whether or not the mail server is answering. Enqueuing is an insert in the caller's
		// transaction; sending happens later, in this worker, where there is no caller left to
		// fail.
		const verified = await testDb.db.transaction(async (transaction) => {
			const [probe] = await transaction
				.insert(scaffoldProbe)
				.values({ description: 'a verified payment', amount: rupiah(150_000) })
				.returning();
			await enqueueEmail(transaction, clock, {
				recipient: 'warga@komplek.local',
				kind: 'greeting',
				payload: { name: 'Budi' }
			});
			return probe;
		});

		const report = await run(unreachableSender());

		expect(report.retried).toBe(1);
		const probes = await testDb.db
			.select()
			.from(scaffoldProbe)
			.where(eq(scaffoldProbe.id, verified.id));
		expect(probes).toHaveLength(1);
	});
});
