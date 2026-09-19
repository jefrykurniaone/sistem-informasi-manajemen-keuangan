import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { CASH_CATEGORY_TYPE, type CashCategoryType } from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { monthlyReports } from '$lib/server/db/schema/monthly-report';
import { PERIOD_STATUS, periods } from '$lib/server/db/schema/period';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { createCashCategory } from '$lib/server/services/cash/category';
import {
	PERIOD_LOCKED_ACTION,
	PERIOD_RULE,
	PeriodLockedError,
	PeriodRuleError,
	unlockPeriod
} from '$lib/server/services/cash/period';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';
import {
	REPORT_PUBLISHED_ACTION,
	REPORT_RULE,
	ReportRuleError,
	publishReport,
	publishedReport,
	listPublishedReports,
	reportWorkbench
} from '$lib/server/services/report/publication';

/**
 * Publishing a Laporan Bulanan and revising it — `docs/spec-kas-laporan-v1.md`'s own testing
 * decision, verbatim: "versi laporan diuji dengan menerbitkan, membuka kunci, menambah transaksi,
 * menerbitkan ulang, lalu membuktikan revisi 1 masih bisa dibaca dengan angka lamanya."
 *
 * Three properties are the point of this file, and each is a thing the database cannot state on its
 * own:
 *
 * 1. **One transaction.** Freezing the numbers, numbering the revision and locking the month either
 *    all happen or none do. Every refusal below is checked for the second half as well — that
 *    nothing was written *and* that the month was not left locked by a publication that failed.
 * 2. **Gapless sequential revisions.** Numbers are derived rather than allocated, so a refused
 *    publication consumes nothing; a rejected attempt between two successful ones leaves 1, 2 and
 *    not 1, 3.
 * 3. **The race between two publishers**, forced with a second connection rather than hoped away
 *    with two concurrent calls, the way `tests/unit/period-lock.test.ts` forces its own.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** One minute between rows, so `createdAt` orders them exactly as they were recorded. */
const STEP_MILLISECONDS = 60_000;

/** The month every test here publishes. */
const PERIOD = '2026-03';

/** `PERIOD` as the two integer columns `periods` keys a month by. */
const PERIOD_YEAR = 2026;
const PERIOD_MONTH = 3;

/**
 * How long a blocked call is given to prove it is genuinely waiting on a lock rather than merely
 * slow. A local query that is not waiting finishes in well under a millisecond.
 */
const BLOCKED_FOR_MILLISECONDS = 300;

let sequence = 0;

/** Makes every name this file writes different from every other one. */
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** A user holding `role` on top of the default `resident` one. */
async function insertUserWithRole(name: string, role: Role): Promise<string> {
	const id = await insertUser(name);
	await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: new Date(START) });
	return id;
}

let adminId: string;
let superuserId: string;
let clock: FakeClock;
let fileStore: FakeFileStore;
let expenseCategoryId: string;

beforeEach(async () => {
	// The figures below are sums over the whole schema, and a Periode is keyed by its month, so rows
	// left behind by an earlier test would both change the numbers and refuse the next publication.
	await testDb.db.delete(monthlyReports);
	await testDb.db.delete(cashTransactions);
	await testDb.db.delete(periods);

	adminId = await insertUserWithRole(unique('Pengurus Terbit'), ROLE.admin);
	superuserId = await insertUserWithRole(unique('Pengurus Buka Kunci'), ROLE.superuser);
	clock = new FakeClock(START);
	fileStore = new FakeFileStore(clock);
	expenseCategoryId = await addCategory('Perbaikan pompa', CASH_CATEGORY_TYPE.expense);
});

/** One ordinary Kategori Kas. */
async function addCategory(name: string, type: CashCategoryType): Promise<string> {
	const created = await createCashCategory(testDb.db, clock, {
		actorId: superuserId,
		name: unique(name),
		type
	});
	return created.id;
}

/** One Transaksi Kas through the service, so the Periode behaves exactly as it really does. */
async function record(occurredOn: string, amount: number): Promise<void> {
	clock.advance(STEP_MILLISECONDS);
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: adminId,
		occurredOn,
		categoryId: expenseCategoryId,
		amount: rupiah(amount),
		description: 'Perbaikan pompa air komplek'
	});
}

/** The `periods` row for the month under test, or undefined when nothing has created it yet. */
async function periodRow() {
	const [row] = await testDb.db
		.select()
		.from(periods)
		.where(and(eq(periods.year, PERIOD_YEAR), eq(periods.month, PERIOD_MONTH)));
	return row;
}

/** Every `monthly_reports` row there is, so "exactly one" and "none" can both be asserted. */
async function reportRows() {
	return testDb.db.select().from(monthlyReports);
}

/** Reopens the month, the way a superuser does when a receipt turns up late. */
async function reopen(reason = 'Ada nota perbaikan pompa yang baru ditemukan.'): Promise<void> {
	await unlockPeriod(testDb.db, clock, {
		actorId: superuserId,
		year: PERIOD_YEAR,
		month: PERIOD_MONTH,
		reason
	});
}

/**
 * A second, independent connection into this file's own schema — a stand-in for a concurrent
 * publisher, with its own client and its own transaction, never sharing one with `testDb.db`.
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

describe('publishing a Laporan Bulanan', () => {
	it('freezes the figures, numbers the revision 1, and locks the month, in one go', async () => {
		await record('2026-03-08', 400_000);

		const report = await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		expect(report).toMatchObject({
			revision: 1,
			revisionReason: null,
			publishedBy: adminId,
			totalExpense: 400_000,
			totalIncome: 0,
			openingBalance: 0,
			closingBalance: -400_000
		});
		expect((await periodRow()).status).toBe(PERIOD_STATUS.locked);
	});

	it('refuses a transaction dated inside the month it just locked', async () => {
		// User story 14, reached through the publication rather than through a lock button: publishing
		// is what makes a month stop accepting money.
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		await expect(record('2026-03-19', 50_000)).rejects.toThrow(PeriodLockedError);
	});

	it('records both the publication and the lock in the audit log', async () => {
		await record('2026-03-08', 400_000);

		const report = await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		const publication = await auditEntriesFor(testDb.db, report.id);
		expect(publication).toHaveLength(1);
		expect(publication[0]).toMatchObject({
			actorId: adminId,
			action: REPORT_PUBLISHED_ACTION,
			after: { period: PERIOD, revision: 1, revisionReason: null }
		});

		const lock = await auditEntriesFor(testDb.db, report.periodId);
		expect(lock.map((entry) => entry.action)).toContain(PERIOD_LOCKED_ACTION);
	});

	it('refuses a caller who may not publish, and writes nothing when it does', async () => {
		const residentId = await insertUser(unique('Warga Terbit'));
		const otherSuperuserId = await insertUserWithRole(unique('Superuser Saja'), ROLE.superuser);
		await record('2026-03-08', 400_000);

		for (const actorId of [residentId, otherSuperuserId]) {
			await expect(
				publishReport(testDb.db, clock, { actorId, period: PERIOD })
			).rejects.toBeInstanceOf(PermissionDeniedError);
		}
		expect(await reportRows()).toHaveLength(0);
		expect(await periodRow()).toMatchObject({ status: PERIOD_STATUS.open });
	});

	it('refuses a period that is not a calendar month', async () => {
		await expect(
			publishReport(testDb.db, clock, { actorId: adminId, period: '2026-13' })
		).rejects.toThrow(TypeError);
	});
});

describe('the alasan revisi, on both sides', () => {
	it('refuses one on revision 1, and leaves the month open when it does', async () => {
		await record('2026-03-08', 400_000);

		const refusal: unknown = await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Tidak ada yang direvisi.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ReportRuleError);
		expect(refusal).toMatchObject({ rule: REPORT_RULE.revisionReasonNotAllowed });
		// The whole transaction rolled back, so the lock the publication took went with it.
		expect(await reportRows()).toHaveLength(0);
		expect(await periodRow()).toMatchObject({ status: PERIOD_STATUS.open });
	});

	it('requires one from revision 2 on, and leaves the month open when it is missing', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });
		await reopen();
		await record('2026-03-21', 125_000);

		const refusal: unknown = await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ReportRuleError);
		expect(refusal).toMatchObject({ rule: REPORT_RULE.revisionReasonMissing });
		expect(await reportRows()).toHaveLength(1);
		expect(await periodRow()).toMatchObject({ status: PERIOD_STATUS.open });
	});

	it('treats a reason of nothing but spaces as missing', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });
		await reopen();

		await expect(
			publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD, revisionReason: '   ' })
		).rejects.toMatchObject({ rule: REPORT_RULE.revisionReasonMissing });
	});
});

describe('revising a published report', () => {
	it('keeps revision 1 readable with its old figures after revision 2 exists', async () => {
		// The spec's own scenario, end to end.
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });
		await reopen();
		await record('2026-03-21', 125_000);
		const second = await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Nota perbaikan pompa tanggal 21 baru ditemukan.'
		});

		expect(second.revision).toBe(2);
		expect((await periodRow()).status).toBe(PERIOD_STATUS.locked);

		const first = await publishedReport(testDb.db, PERIOD, 1);
		expect(first?.figures.totalExpense).toBe(400_000);
		expect(first?.revisionReason).toBeNull();
		expect(first?.isLatest).toBe(false);

		const latest = await publishedReport(testDb.db, PERIOD);
		expect(latest?.revision).toBe(2);
		expect(latest?.figures.totalExpense).toBe(525_000);
		expect(latest?.revisionReason).toBe('Nota perbaikan pompa tanggal 21 baru ditemukan.');
		expect(latest?.isLatest).toBe(true);
		// Both revisions are offered from either one, so an older one is always one click away.
		expect(latest?.revisions.map((entry) => entry.revision)).toEqual([2, 1]);
	});

	it('refuses a second publication while the month is still locked', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		const refusal: unknown = await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Mencoba menerbitkan lagi tanpa membuka kunci.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PeriodRuleError);
		expect(refusal).toMatchObject({ rule: PERIOD_RULE.alreadyLocked });
		expect(await reportRows()).toHaveLength(1);
	});

	it('numbers revisions sequentially with no gap, even across refused attempts', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		await reopen();
		// A refused attempt in the middle: a sequence would have handed out and kept the number 2.
		await expect(
			publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD })
		).rejects.toBeInstanceOf(ReportRuleError);
		await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Revisi kedua.'
		});

		await reopen();
		await expect(
			publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD })
		).rejects.toBeInstanceOf(ReportRuleError);
		await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Revisi ketiga.'
		});

		const revisions = (await reportRows()).map((row) => row.revision).sort((a, b) => a - b);
		expect(revisions).toEqual([1, 2, 3]);
	});

	it('is refused by the database if two publishers ever did reach the same number', async () => {
		// The backstop behind the row lock, asserted on its own so that a later change breaking the
		// lock argument still cannot produce two revision 2s. `monthly_reports_period_id_revision_unique`
		// turns the race into an error rather than a duplicate.
		await record('2026-03-08', 400_000);
		const first = await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		await expect(
			testDb.db.insert(monthlyReports).values({
				periodId: first.periodId,
				revision: first.revision,
				publishedAt: clock.now(),
				publishedBy: adminId,
				revisionReason: null,
				openingBalance: rupiah(0),
				totalIncome: rupiah(0),
				totalExpense: rupiah(0),
				closingBalance: rupiah(0),
				duesCollected: rupiah(0),
				duesUnitsPaid: 0,
				duesUnitsUnpaid: 0,
				categoryBreakdown: []
			})
		).rejects.toThrow();
	});
});

describe('the race between two publishers', () => {
	it('blocks on the Periode row rather than reading a revision number that is about to change', async () => {
		// The stand-in connection holds exactly the row lock a publication holds, and locks the month
		// the way a committed publication would. The publication under test must *wait* there — at the
		// Periode row, before it ever reads `max(revision)` — and then find the month locked.
		//
		// If it did not block, it would read `max(revision)` from a snapshot the other transaction is
		// about to invalidate, compute the same number, and depend on the unique index to notice. The
		// wait is what makes gapless numbering a property rather than a coincidence.
		await record('2026-03-08', 400_000);

		const other = await connectToSchema();
		try {
			await other.client.query('BEGIN');
			await other.client.query(
				`update periods set status = 'locked' where year = ${PERIOD_YEAR} and month = ${PERIOD_MONTH}`
			);

			const publishing = publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });
			let settled = false;
			publishing.then(
				() => (settled = true),
				() => (settled = true)
			);

			await new Promise((resolve) => setTimeout(resolve, BLOCKED_FOR_MILLISECONDS));
			expect(settled).toBe(false);

			await other.client.query('COMMIT');

			// Unblocked, it re-reads and finds the lock that really is there now.
			await expect(publishing).rejects.toMatchObject({ rule: PERIOD_RULE.alreadyLocked });
			expect(await reportRows()).toHaveLength(0);
		} finally {
			await other.release();
		}
	});
});

describe('reading published reports back', () => {
	it('lists the newest revision of each month, newest month first', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });
		await reopen();
		await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Revisi kedua.'
		});
		await record('2026-04-02', 90_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: '2026-04' });

		const listed = await listPublishedReports(testDb.db);

		expect(listed.map((entry) => `${entry.period}#${entry.revision}`)).toEqual([
			'2026-04#1',
			'2026-03#2'
		]);
	});

	it('answers nothing for a month never published, and for a revision never published', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		expect(await publishedReport(testDb.db, '2026-05')).toBeUndefined();
		expect(await publishedReport(testDb.db, PERIOD, 2)).toBeUndefined();
	});
});

describe("the admin's publishing screen", () => {
	it('previews the month as it stands and says which revision would be next', async () => {
		await record('2026-03-08', 400_000);

		const workbench = await reportWorkbench(testDb.db, clock, adminId, PERIOD);

		expect(workbench).toMatchObject({
			period: PERIOD,
			isLocked: false,
			nextRevision: 1,
			revisionReasonRequired: false
		});
		expect(workbench.figures.totalExpense).toBe(400_000);
		expect(workbench.periods).toContain(PERIOD);
	});

	it('says a revision needs an alasan once the month has been published and reopened', async () => {
		await record('2026-03-08', 400_000);
		await publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });

		const locked = await reportWorkbench(testDb.db, clock, adminId, PERIOD);
		expect(locked).toMatchObject({ isLocked: true, nextRevision: 2, revisionReasonRequired: true });
		expect(locked.revisions.map((entry) => entry.revision)).toEqual([1]);

		await reopen();
		const reopened = await reportWorkbench(testDb.db, clock, adminId, PERIOD);
		expect(reopened).toMatchObject({
			isLocked: false,
			nextRevision: 2,
			revisionReasonRequired: true
		});
	});

	it('defaults to the month the complex is in, and refuses a caller who may not publish', async () => {
		const residentId = await insertUser(unique('Warga Pratinjau'));

		const workbench = await reportWorkbench(testDb.db, clock, adminId);
		expect(workbench.period).toBe('2026-01');

		await expect(reportWorkbench(testDb.db, clock, residentId)).rejects.toBeInstanceOf(
			PermissionDeniedError
		);
	});
});
