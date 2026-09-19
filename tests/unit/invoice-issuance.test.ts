import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { duesRates } from '$lib/server/db/schema/dues-rate';
import { exemptions } from '$lib/server/db/schema/exemption';
import { invoices, type Invoice } from '$lib/server/db/schema/invoice';
import { residents } from '$lib/server/db/schema/resident';
import { jobRuns, JOB_RUN_STATUS } from '$lib/server/db/schema/scheduler';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	applicationJobs,
	JOB_OUTCOME,
	listJobsWithLastRun,
	runJob,
	triggerJob
} from '$lib/server/scheduler';
import {
	COMPLEX_TIME_ZONE,
	describeIssuance,
	issueInvoicesForPeriod,
	NoDuesRateError,
	UNIT_SKIP_REASON,
	type InvoiceIssuanceSummary
} from '$lib/server/services/dues/issuance';
import {
	INVOICE_ISSUANCE_JOB_NAME,
	invoiceIssuanceJob,
	registerDuesJobs
} from '$lib/server/services/dues/jobs';
import { deleteDuesRate, DuesRateInUseError } from '$lib/server/services/dues/rate';

/**
 * Penerbitan tagihan: what one run issues, what it passes over and why, and the job that carries it.
 * `tests/unit/invoice-issuance-idempotent.test.ts` is the other half — running it twice, running it
 * against a month that is already half issued, and the share lock on the Tarif.
 *
 * Every date this file asserts on comes from the Periode rather than from the clock, which is the
 * property the service is built around: the `FakeClock` only ever stamps `issuedAt`, so a test can
 * run "January's issuance" from an instant in March and still get January's rate.
 */

const testDb = testDatabase();

/** The Periode most of this file issues. */
const PERIOD = '2026-03';

/** An instant inside that Periode, in the complex's own zone: 10:00 on 1 March in Jakarta. */
const DURING_PERIOD = '2026-03-01T03:00:00.000Z';

/** The rate in force for most of this file. */
const MONTHLY_RATE = rupiah(150_000);

/** The day every Tagihan for `PERIOD` falls due. */
const DUE_DATE = '2026-03-05';

/** The first day of `PERIOD` — the day the Tarif and the Pembebasan are read on. */
const ISSUANCE_DAY = '2026-03-01';

/** A reason an exemption fixture carries. Never asserted on, only required by the table. */
const EXEMPTION_REASON = 'Rumah kosong sedang direnovasi';

/**
 * Everything one test writes is cleared before the next one.
 *
 * Issuance is a global read — every active Unit, every rate — so a row left behind by an earlier
 * test would silently join a later test's run. This deletes only inside this file's own PostgreSQL
 * schema, see `src/lib/server/db/test-helpers.ts`, so it cannot reach another file's rows.
 */
beforeEach(async () => {
	await testDb.db.delete(invoices);
	await testDb.db.delete(exemptions);
	await testDb.db.delete(units);
	await testDb.db.delete(duesRates);
	await testDb.db.delete(jobRuns);
});

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** A house. Active unless this test is about a deactivated one. */
async function insertUnit(isActive = true): Promise<{ id: string; block: string }> {
	sequence += 1;
	const block = `BILL-${String(sequence).padStart(3, '0')}`;
	const [row] = await testDb.db
		.insert(units)
		.values({ block, number: '1', isActive, createdAt: new Date(DURING_PERIOD) })
		.returning();
	return { id: row.id, block: row.block };
}

/** A Tarif written straight into `dues_rates`, bypassing the service that guards its history. */
async function insertRate(amount: Rupiah, effectiveFrom: string): Promise<string> {
	const [row] = await testDb.db
		.insert(duesRates)
		.values({ amount, effectiveFrom, createdAt: new Date(DURING_PERIOD) })
		.returning();
	return row.id;
}

/** A superuser with a `residents` row, ready to act as `actorId` and to be attributed a grant. */
async function insertSuperuser(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = randomUUID();
	const now = new Date(DURING_PERIOD);
	await testDb.db.insert(user).values({
		id: userId,
		name,
		email: `${userId}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	await testDb.db.insert(userRoles).values({ userId, role: ROLE.superuser, createdAt: now });
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: now })
		.returning();
	return { userId, residentId: resident.id };
}

/** A Pembebasan written straight into `exemptions`, bypassing the service that guards overlaps. */
async function insertExemption(
	unitId: string,
	startedOn: string,
	endedOn: string | null,
	createdBy: string
): Promise<void> {
	await testDb.db.insert(exemptions).values({
		unitId,
		startedOn,
		endedOn,
		reason: EXEMPTION_REASON,
		createdBy,
		createdAt: new Date(DURING_PERIOD)
	});
}

/** Every Tagihan in this file's schema, oldest period first. */
async function invoiceRows(): Promise<Invoice[]> {
	return testDb.db.select().from(invoices).orderBy(asc(invoices.period), asc(invoices.unitId));
}

/** A run of issuance at an instant that only ever stamps `issuedAt`. */
async function issue(period: string, at = DURING_PERIOD): Promise<InvoiceIssuanceSummary> {
	return issueInvoicesForPeriod(testDb.db, new FakeClock(at), period);
}

describe('issueInvoicesForPeriod', () => {
	it('issues one Tagihan per active unit, at the rate in force and due on the fifth', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const first = await insertUnit();
		const second = await insertUnit();

		const summary = await issue(PERIOD);

		expect(summary).toMatchObject({
			period: PERIOD,
			issuanceDay: ISSUANCE_DAY,
			dueDate: DUE_DATE,
			amount: MONTHLY_RATE,
			unitCount: 2,
			issuedCount: 2,
			skipped: []
		});
		const rows = await invoiceRows();
		expect(rows.map((row) => row.unitId).sort()).toEqual([first.id, second.id].sort());
		expect(rows.every((row) => row.amount === MONTHLY_RATE && row.dueDate === DUE_DATE)).toBe(true);
		expect(rows.every((row) => row.issuedAt.toISOString() === DURING_PERIOD)).toBe(true);
	});

	it('prices a Periode by the rate in force on its first day, not by the one in force when it runs', async () => {
		// The versioning test `docs/spec-iuran-v1.md` asks for: "Tagihan Januari memakai tarif lama
		// meski tarif baru ditetapkan pada Februari". The run happens in March, later than both.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertRate(rupiah(200_000), '2026-02-01');
		await insertUnit();

		const january = await issue('2026-01');
		const february = await issue('2026-02');

		expect(january.amount).toBe(MONTHLY_RATE);
		expect(february.amount).toBe(rupiah(200_000));
		expect((await invoiceRows()).map((row) => [row.period, row.amount, row.dueDate])).toEqual([
			['2026-01', MONTHLY_RATE, '2026-01-05'],
			['2026-02', rupiah(200_000), '2026-02-05']
		]);
	});

	it('runs late and writes exactly what an on-time run would have written', async () => {
		// "Menjalankannya terlambat menghasilkan tagihan yang sama": a rate that started on the tenth
		// does not reach a Periode whose first day it is not in force on, whatever day the job runs.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertRate(rupiah(999_000), '2026-03-10');
		await insertUnit();

		const summary = await issue(PERIOD, '2026-03-28T03:00:00.000Z');

		expect(summary.amount).toBe(MONTHLY_RATE);
		expect((await invoiceRows())[0]).toMatchObject({ amount: MONTHLY_RATE, dueDate: DUE_DATE });
	});

	it('passes over a unit whose Pembebasan covers the first day, and says which unit and why', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const billed = await insertUnit();
		const exempt = await insertUnit();
		const { residentId } = await insertSuperuser('Pengurus Pembebasan');
		await insertExemption(exempt.id, '2026-02-01', null, residentId);

		const summary = await issue(PERIOD);

		expect(summary.issuedCount).toBe(1);
		expect(summary.skipped).toEqual([
			{ unitId: exempt.id, block: exempt.block, number: '1', reason: UNIT_SKIP_REASON.exempt }
		]);
		expect((await invoiceRows()).map((row) => row.unitId)).toEqual([billed.id]);
	});

	it('bills a unit again in the Periode after its Pembebasan ended', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const unit = await insertUnit();
		const { residentId } = await insertSuperuser('Pengurus Pembebasan Berakhir');
		await insertExemption(unit.id, '2026-02-01', '2026-03-31', residentId);

		const exemptMonth = await issue(PERIOD);
		const nextMonth = await issue('2026-04');

		expect(exemptMonth.issuedCount).toBe(0);
		expect(nextMonth.issuedCount).toBe(1);
		expect((await invoiceRows()).map((row) => row.period)).toEqual(['2026-04']);
	});

	it('still issues for a unit whose Pembebasan starts later in the month', async () => {
		// The other side of "pembebasan yang ditetapkan mundur tidak membatalkan tagihan yang sudah
		// terbit": the exemption does not cover the first, so the Tagihan for that month stands and a
		// superuser cancels it by hand if that is what they meant.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const unit = await insertUnit();
		const { residentId } = await insertSuperuser('Pengurus Pembebasan Mundur');
		await insertExemption(unit.id, '2026-03-10', null, residentId);

		const summary = await issue(PERIOD);

		expect(summary.issuedCount).toBe(1);
		expect((await invoiceRows())[0].unitId).toBe(unit.id);
	});

	it('leaves a deactivated unit out of the run entirely, not merely unbilled', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const active = await insertUnit();
		await insertUnit(false);

		const summary = await issue(PERIOD);

		expect(summary).toMatchObject({ unitCount: 1, issuedCount: 1, skipped: [] });
		expect((await invoiceRows()).map((row) => row.unitId)).toEqual([active.id]);
	});

	it('issues nothing at all when no Tarif is in force, and names the day in the refusal', async () => {
		await insertUnit();
		await insertUnit();

		await expect(issue(PERIOD)).rejects.toBeInstanceOf(NoDuesRateError);
		await expect(issue(PERIOD)).rejects.toThrow(ISSUANCE_DAY);
		expect(await invoiceRows()).toEqual([]);
	});

	it('refuses a Periode whose first day falls before the only Tarif ever set', async () => {
		await insertRate(MONTHLY_RATE, '2026-03-02');
		await insertUnit();

		await expect(issue(PERIOD)).rejects.toBeInstanceOf(NoDuesRateError);
		expect(await invoiceRows()).toEqual([]);
	});

	it('refuses a period that is not a calendar month', async () => {
		await expect(issue('2026-13')).rejects.toBeInstanceOf(TypeError);
	});

	it('freezes the Tarif that priced the Periode the moment the first Tagihan is committed', async () => {
		// The composed invariant the share lock exists to reach: after issuance, `./rate.ts` refuses
		// every change to the rate that priced the month, so every unit in the run — and every later
		// re-run of it — is billed the same amount.
		const rateId = await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertUnit();
		const { userId } = await insertSuperuser('Pengurus Tarif');

		await issue(PERIOD);

		await expect(
			deleteDuesRate(testDb.db, new FakeClock('2026-03-15T03:00:00.000Z'), {
				actorId: userId,
				duesRateId: rateId
			})
		).rejects.toBeInstanceOf(DuesRateInUseError);
	});
});

describe('describeIssuance', () => {
	it('says how many Tagihan were issued, how many units were passed over, and why', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const exempt = await insertUnit();
		await insertUnit();
		const { residentId } = await insertSuperuser('Pengurus Ringkasan');
		await insertExemption(exempt.id, '2026-01-01', null, residentId);

		const summary = await issue(PERIOD);

		expect(describeIssuance(summary)).toBe(
			'Period 2026-03: 1 invoices issued at Rp 150.000, due 2026-03-05. 1 of 2 units skipped: 1 exempt, 0 already issued.'
		);
	});

	it('says so plainly when a run issued nothing', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');

		const summary = await issue(PERIOD);

		expect(describeIssuance(summary)).toBe(
			'Period 2026-03: no invoices issued. 0 of 0 units skipped.'
		);
	});
});

describe('the invoice issuance job', () => {
	it('is registered in applicationJobs, monthly in the complex time zone', () => {
		const registered = applicationJobs.get(INVOICE_ISSUANCE_JOB_NAME);

		expect(registered).toBeDefined();
		expect(registered?.schedule.description).toBe(`monthly in ${COMPLEX_TIME_ZONE}`);
	});

	it('is registered once however often the module that registers it is evaluated', () => {
		// `vite dev` re-executes a changed server module against the same registry. Registering has to
		// survive that rather than throwing on the duplicate name.
		expect(() => {
			registerDuesJobs();
			registerDuesJobs();
		}).not.toThrow();
		expect(
			applicationJobs.list().filter((job) => job.name === INVOICE_ISSUANCE_JOB_NAME)
		).toHaveLength(1);
	});

	it('reads the month in the complex time zone, so a Periode turns at local midnight', () => {
		// 2026-02-28T17:30:00Z is 00:30 on 1 March in Jakarta, and 16:30Z is 23:30 on 28 February. A
		// job scheduled in UTC would issue March's Tagihan seven hours late.
		const { schedule } = invoiceIssuanceJob();

		expect(schedule.periodFor(new Date('2026-02-28T17:30:00.000Z'))).toBe(PERIOD);
		expect(schedule.periodFor(new Date('2026-02-28T16:30:00.000Z'))).toBe('2026-02');
	});

	it('issues the month when the scheduler runs it, and hands the summary to its reporter', async () => {
		await insertRate(MONTHLY_RATE, '2026-01-01');
		await insertUnit();
		const reported: InvoiceIssuanceSummary[] = [];

		const outcome = await runJob({
			db: testDb.db,
			clock: new FakeClock(DURING_PERIOD),
			job: invoiceIssuanceJob({ report: (summary) => reported.push(summary) })
		});

		expect(outcome).toMatchObject({
			jobName: INVOICE_ISSUANCE_JOB_NAME,
			period: PERIOD,
			outcome: JOB_OUTCOME.succeeded
		});
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ period: PERIOD, issuedCount: 1 });
	});

	it('records the missing Tarif on the run and leaves the Periode free to be attempted again', async () => {
		await insertUnit();
		const clock = new FakeClock(DURING_PERIOD);
		const job = invoiceIssuanceJob({ report: () => undefined });

		const failed = await runJob({ db: testDb.db, clock, job });

		expect(failed).toMatchObject({ period: PERIOD, outcome: JOB_OUTCOME.failed });
		expect(failed.error).toContain(ISSUANCE_DAY);
		expect(await invoiceRows()).toEqual([]);

		// `failJobRun` takes the failed row out of the partial unique index, so the period is claimable
		// again — which is the whole point of reporting the missing Tarif as a failure.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const retried = await runJob({ db: testDb.db, clock, job });

		expect(retried.outcome).toBe(JOB_OUTCOME.succeeded);
		expect(await invoiceRows()).toHaveLength(1);
		const runs = await testDb.db
			.select()
			.from(jobRuns)
			.where(eq(jobRuns.jobName, INVOICE_ISSUANCE_JOB_NAME))
			.orderBy(asc(jobRuns.status));
		expect(runs.map((row) => row.status)).toEqual([
			JOB_RUN_STATUS.failed,
			JOB_RUN_STATUS.succeeded
		]);
	});

	it('is on the superuser screen and runs when its button is pressed', async () => {
		// `src/routes/(app)/admin/jobs/+page.server.ts` calls `listJobsWithLastRun` and `triggerJob`
		// with `applicationJobs` and nothing else, so this is the whole of "superuser dapat memicu
		// penerbitan sekarang juga lewat layar pekerjaan" — and the reason that page needed no edit.
		await insertRate(MONTHLY_RATE, '2026-01-01');
		const unit = await insertUnit();
		const { userId } = await insertSuperuser('Pengurus Pekerjaan');
		const clock = new FakeClock('2026-04-01T03:00:00.000Z');
		const screen = { db: testDb.db, clock, registry: applicationJobs, actorId: userId };

		const outcome = await triggerJob({ ...screen, jobName: INVOICE_ISSUANCE_JOB_NAME });

		expect(outcome).toMatchObject({ period: '2026-04', outcome: JOB_OUTCOME.succeeded });
		expect((await invoiceRows()).map((row) => [row.unitId, row.period])).toEqual([
			[unit.id, '2026-04']
		]);
		const listed = await listJobsWithLastRun(screen);
		expect(listed.find((job) => job.name === INVOICE_ISSUANCE_JOB_NAME)).toMatchObject({
			currentPeriod: '2026-04',
			lastRun: { period: '2026-04', status: JOB_RUN_STATUS.succeeded }
		});
	});
});
