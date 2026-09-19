import { asc } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { duesRates } from '$lib/server/db/schema/dues-rate';
import { invoices, type Invoice } from '$lib/server/db/schema/invoice';
import { jobRuns } from '$lib/server/db/schema/scheduler';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { JOB_OUTCOME, runJob } from '$lib/server/scheduler';
import {
	issueInvoicesForPeriod,
	UNIT_SKIP_REASON,
	type InvoiceIssuanceSummary
} from '$lib/server/services/dues/issuance';
import { invoiceIssuanceJob } from '$lib/server/services/dues/jobs';

/**
 * The idempotency argument of `docs/spec-iuran-v1.md`, proved rather than asserted: "menjalankan
 * pekerjaan itu dua kali tidak menghasilkan tagihan ganda". The rules about *what* a run issues are
 * in `tests/unit/invoice-issuance.test.ts`; this file is only about running it more than once.
 *
 * The key is `invoices_unit_id_period_unique`, which is a property of a unique index rather than of
 * anything the service reads, so the two tests that matter here force an interleaving with a second
 * connection holding an uncommitted transaction — the same technique
 * `tests/unit/scheduler-jobs.test.ts` uses, and for the same reason: two calls raced through
 * `Promise.allSettled` would ordinarily let the first commit before the second reached the index, so
 * a version with no lock and no `on conflict` at all would pass that.
 */

const testDb = testDatabase();

/** The Periode this file issues. */
const PERIOD = '2026-03';

/** An instant inside that Periode, in the complex's own zone: 10:00 on 1 March in Jakarta. */
const DURING_PERIOD = '2026-03-01T03:00:00.000Z';

/** A later instant, for a second run, so that a rewritten row would show a different `issuedAt`. */
const LATER_IN_PERIOD = '2026-03-08T03:00:00.000Z';

/** The rate in force throughout this file. */
const MONTHLY_RATE = rupiah(150_000);

/** How long a test waits to be satisfied that something is *not* going to happen. */
const SETTLE_MILLISECONDS = 250;

beforeEach(async () => {
	await testDb.db.delete(invoices);
	await testDb.db.delete(units);
	await testDb.db.delete(duesRates);
	await testDb.db.delete(jobRuns);
});

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** A house. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({
			block: `IDEM-${String(sequence).padStart(3, '0')}`,
			number: '1',
			createdAt: new Date(DURING_PERIOD)
		})
		.returning();
	return row.id;
}

/** A Tarif written straight into `dues_rates`. */
async function insertRate(amount: Rupiah, effectiveFrom: string): Promise<void> {
	await testDb.db
		.insert(duesRates)
		.values({ amount, effectiveFrom, createdAt: new Date(DURING_PERIOD) });
}

/** Every Tagihan in this file's schema. */
async function invoiceRows(): Promise<Invoice[]> {
	return testDb.db.select().from(invoices).orderBy(asc(invoices.period), asc(invoices.unitId));
}

/** A run of issuance at an instant that only ever stamps `issuedAt`. */
async function issue(period: string, at = DURING_PERIOD): Promise<InvoiceIssuanceSummary> {
	return issueInvoicesForPeriod(testDb.db, new FakeClock(at), period);
}

/** Waits for `milliseconds`, for a test that has to let a blocked statement stay blocked. */
function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A second, independent connection into this file's own schema — a stand-in for a concurrent
 * instance of the application, with its own client and its own transaction.
 */
async function connectToSchema(): Promise<{ client: PoolClient; release: () => Promise<void> }> {
	const connection = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
		options: `-c search_path=${testDb.schemaName}`
	});
	const client = await connection.pool.connect();
	return {
		client,
		release: async () => {
			client.release();
			await connection.close();
		}
	};
}

describe('running issuance more than once for one Periode', () => {
	it('leaves the same number of Tagihan, and reports the second run as issuing none', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const first = await insertUnit();
		const second = await insertUnit();

		const once = await issue(PERIOD);
		const twice = await issue(PERIOD, LATER_IN_PERIOD);

		expect(once.issuedCount).toBe(2);
		expect(twice).toMatchObject({ unitCount: 2, issuedCount: 0 });
		expect(twice.amount).toBeUndefined();
		expect(twice.skipped.map((skip) => skip.unitId).sort()).toEqual([first, second].sort());
		expect(twice.skipped.every((skip) => skip.reason === UNIT_SKIP_REASON.alreadyIssued)).toBe(
			true
		);
		expect(await invoiceRows()).toHaveLength(2);
	});

	it('never rewrites a Tagihan that already exists', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertUnit();

		await issue(PERIOD);
		const [before] = await invoiceRows();
		await issue(PERIOD, LATER_IN_PERIOD);
		const [after] = await invoiceRows();

		expect(after).toEqual(before);
		expect(after.issuedAt.toISOString()).toBe(DURING_PERIOD);
	});

	it('issues a fresh Tagihan for a different Periode', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const unit = await insertUnit();

		await issue(PERIOD);
		const april = await issue('2026-04', '2026-04-01T03:00:00.000Z');

		expect(april.issuedCount).toBe(1);
		expect((await invoiceRows()).map((row) => [row.unitId, row.period])).toEqual([
			[unit, PERIOD],
			[unit, '2026-04']
		]);
	});

	it('finishes a Periode an earlier run only got halfway through', async () => {
		// The row a run that died after its first house would have left behind. Each house is its own
		// transaction, so a crash commits what it reached and nothing more.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const reached = await insertUnit();
		await insertUnit();
		await insertUnit();
		await testDb.db.insert(invoices).values({
			unitId: reached,
			period: PERIOD,
			amount: MONTHLY_RATE,
			dueDate: '2026-03-05',
			issuedAt: new Date(DURING_PERIOD)
		});

		const summary = await issue(PERIOD, LATER_IN_PERIOD);

		expect(summary).toMatchObject({ unitCount: 3, issuedCount: 2 });
		expect(summary.skipped.map((unit) => [unit.unitId, unit.reason])).toEqual([
			[reached, UNIT_SKIP_REASON.alreadyIssued]
		]);
		expect(await invoiceRows()).toHaveLength(3);
		const untouched = (await invoiceRows()).find((row) => row.unitId === reached);
		expect(untouched?.issuedAt.toISOString()).toBe(DURING_PERIOD);
	});

	it('picks up a house registered after the first run', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertUnit();

		await issue(PERIOD);
		const late = await insertUnit();
		const second = await issue(PERIOD, LATER_IN_PERIOD);

		expect(second.issuedCount).toBe(1);
		expect(await invoiceRows()).toHaveLength(2);
		expect((await invoiceRows()).some((row) => row.unitId === late)).toBe(true);
	});
});

describe('the scheduler running issuance more than once', () => {
	it('refuses the second attempt at a Periode that already succeeded, without touching the month', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertUnit();
		const job = invoiceIssuanceJob({ report: () => undefined });
		const attempt = { db: testDb.db, clock: new FakeClock(DURING_PERIOD), job };

		const first = await runJob(attempt);
		const second = await runJob(attempt);

		expect(first.outcome).toBe(JOB_OUTCOME.succeeded);
		expect(second.outcome).toBe(JOB_OUTCOME.skipped);
		expect(await invoiceRows()).toHaveLength(1);
	});
});

describe('two instances issuing the same Periode at once', () => {
	it('produces one Tagihan per house, because the unique index refuses the second insert', async () => {
		// The stand-in connection is the second application instance: it holds an uncommitted Tagihan
		// for this exact pair, which is the window in which a read-then-insert would already have seen
		// "no Tagihan yet" and gone ahead. The run must wait inside the index and then report the house
		// as already issued rather than failing.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const unit = await insertUnit();
		const other = await connectToSchema();
		let running: Promise<InvoiceIssuanceSummary> | undefined;
		try {
			await other.client.query('BEGIN');
			await other.client.query(
				`insert into invoices (unit_id, period, amount, due_date, issued_at)
				 values ($1, $2, $3, $4, $5)`,
				[unit, PERIOD, MONTHLY_RATE, '2026-03-05', new Date(DURING_PERIOD)]
			);

			let settled = false;
			running = issue(PERIOD, LATER_IN_PERIOD);
			const tracked = running.then((summary) => {
				settled = true;
				return summary;
			});

			await pause(SETTLE_MILLISECONDS);
			expect(settled).toBe(false);

			await other.client.query('COMMIT');
			const summary = await tracked;

			expect(summary.issuedCount).toBe(0);
			expect(summary.skipped.map((skip) => skip.reason)).toEqual([UNIT_SKIP_REASON.alreadyIssued]);
			expect(await invoiceRows()).toHaveLength(1);
		} finally {
			await other.client.query('ROLLBACK').catch(() => undefined);
			await running?.catch(() => undefined);
			await other.release();
		}
	});

	it('holds the Tarif still while it writes, so a concurrent rate change waits for the Tagihan', async () => {
		// `updateDuesRate` and `deleteDuesRate` take `for update` on the rate rows and then read
		// `invoices` without a lock, so an issuance that had read its rate and not yet committed would
		// be invisible to them. The share lock inside the issuing transaction is what makes them wait;
		// without it this run would finish while the other transaction was still open.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertUnit();
		const other = await connectToSchema();
		let running: Promise<InvoiceIssuanceSummary> | undefined;
		try {
			await other.client.query('BEGIN');
			await other.client.query('select id from dues_rates for update');

			let settled = false;
			running = issue(PERIOD);
			const tracked = running.then((summary) => {
				settled = true;
				return summary;
			});

			await pause(SETTLE_MILLISECONDS);
			expect(settled).toBe(false);

			await other.client.query('COMMIT');

			expect(await tracked).toMatchObject({ issuedCount: 1, amount: MONTHLY_RATE });
		} finally {
			await other.client.query('ROLLBACK').catch(() => undefined);
			await running?.catch(() => undefined);
			await other.release();
		}
	});
});
