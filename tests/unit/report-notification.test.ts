import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatRupiah, rupiah } from '$lib/money';
import { readOrigin } from '$lib/server/auth';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { CASH_CATEGORY_TYPE, type CashCategoryType } from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { emailQueue } from '$lib/server/db/schema/email';
import { monthlyReports } from '$lib/server/db/schema/monthly-report';
import { periods } from '$lib/server/db/schema/period';
import { residents } from '$lib/server/db/schema/resident';
import { subscriptions } from '$lib/server/db/schema/subscription';
import { testDatabase } from '$lib/server/db/test-helpers';
import { emailQueueDrainJob } from '$lib/server/email/jobs';
import {
	MONTHLY_REPORT_KIND,
	monthlyReportPayload,
	monthlyReportTemplate
} from '$lib/server/email/templates/monthly-report';
import {
	MONTHLY_REPORT_REVISED_KIND,
	reportRevisedPayload,
	reportRevisedTemplate
} from '$lib/server/email/templates/report-revised';
import { FakeClock, FakeEmailSender, FakeFileStore } from '$lib/server/ports/fakes';
import { runJob } from '$lib/server/scheduler';
import { createCashCategory } from '$lib/server/services/cash/category';
import { unlockPeriod } from '$lib/server/services/cash/period';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';
import {
	MONTHLY_REPORT_ANNOUNCEMENT_WINDOW_MILLISECONDS,
	sendMonthlyReportEmails
} from '$lib/server/services/report/notification';
import { monthlyReportJob, MONTHLY_REPORT_JOB_NAME } from '$lib/server/services/report/jobs';
import { publishReport } from '$lib/server/services/report/publication';
import { setSubscriptionPreference } from '$lib/server/services/subscription';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';
import { verifyUnsubscribeToken } from '$lib/server/services/subscription/unsubscribe-token';

/**
 * #37's recipient side: who is told a Laporan Bulanan exists, what they are told, and the rule that
 * running the job twice does not tell anybody twice.
 *
 * Against a real PostgreSQL, with a `FakeClock` and — where an email is actually sent rather than
 * merely queued — a `FakeEmailSender`, as the ticket's own acceptance criterion asks. The
 * publications are made through `publishReport` rather than by inserting `monthly_reports` rows by
 * hand, because the criterion is about what happens *after a report is published*, and the freeze,
 * the revision number and the lock are all part of that.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-04-02T00:00:00.000Z';

/** One minute between rows, so `createdAt` orders them exactly as they were recorded. */
const STEP_MILLISECONDS = 60_000;

/** A day, for moving the clock into a new schedule period. */
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/** The month every test here publishes. */
const PERIOD = '2026-03';

/** `PERIOD` as the two integer columns `periods` keys a month by. */
const PERIOD_YEAR = 2026;
const PERIOD_MONTH = 3;

/** The one income this file records, so the figures in an email are not all zero. */
const INCOME = 1_500_000;

/** The one expense. */
const EXPENSE = 400_000;

let sequence = 0;

/** Makes every name and address this file writes different from every other one. */
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

let adminId: string;
let superuserId: string;
let clock: FakeClock;
let fileStore: FakeFileStore;
let incomeCategoryId: string;
let expenseCategoryId: string;

beforeEach(async () => {
	// The figures are sums over the whole schema and a Periode is keyed by its month, so rows left by
	// an earlier test would change the numbers and refuse the next publication. The queue and the
	// Langganan are emptied for the same reason: every assertion below counts rows.
	await testDb.db.delete(emailQueue);
	await testDb.db.delete(subscriptions);
	await testDb.db.delete(residents);
	await testDb.db.delete(monthlyReports);
	await testDb.db.delete(cashTransactions);
	await testDb.db.delete(periods);

	adminId = await insertUserWithRole(unique('Pengurus Terbit Laporan'), ROLE.admin);
	superuserId = await insertUserWithRole(unique('Pengurus Buka Kunci Laporan'), ROLE.superuser);
	clock = new FakeClock(START);
	fileStore = new FakeFileStore(clock);
	incomeCategoryId = await addCategory('Iuran warga', CASH_CATEGORY_TYPE.income);
	expenseCategoryId = await addCategory('Perbaikan pompa', CASH_CATEGORY_TYPE.expense);
});

/** Inserts a bare `user` row. */
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

/** One warga: a `user` row, a `residents` row, and nothing said about any Langganan yet. */
async function insertResident(name: string): Promise<{
	readonly userId: string;
	readonly residentId: string;
	readonly email: string;
}> {
	const userId = await insertUser(name);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, phone: null, createdAt: new Date(START) })
		.returning();
	const [account] = await testDb.db.select().from(user).where(eq(user.id, userId));
	return { userId, residentId: row.id, email: account.email };
}

/** One warga who asked for the monthly report. */
async function insertSubscriber(name: string) {
	const resident = await insertResident(name);
	await setSubscriptionPreference(testDb.db, clock, {
		callerUserId: resident.userId,
		residentId: resident.residentId,
		kind: SUBSCRIPTION_KIND.monthlyReport,
		enabled: true
	});
	return resident;
}

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
async function record(occurredOn: string, categoryId: string, amount: number): Promise<void> {
	clock.advance(STEP_MILLISECONDS);
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: adminId,
		occurredOn,
		categoryId,
		amount: rupiah(amount),
		description: 'Kas komplek'
	});
}

/** The month's two transactions, so every figure in an email is a different number. */
async function recordTheMonth(): Promise<void> {
	await record('2026-03-05', incomeCategoryId, INCOME);
	await record('2026-03-08', expenseCategoryId, EXPENSE);
}

/** Publishes `PERIOD` for the first time. */
async function publishFirstRevision() {
	return publishReport(testDb.db, clock, { actorId: adminId, period: PERIOD });
}

/** Reopens the month, the way a superuser does when a receipt turns up late. */
async function reopen(): Promise<void> {
	await unlockPeriod(testDb.db, clock, {
		actorId: superuserId,
		year: PERIOD_YEAR,
		month: PERIOD_MONTH,
		reason: 'Ada nota yang baru ditemukan.'
	});
}

/** Every queue row of one kind, oldest first. */
async function queuedOf(kind: string) {
	return testDb.db.select().from(emailQueue).where(eq(emailQueue.kind, kind));
}

describe('sendMonthlyReportEmails', () => {
	it('queues one email per subscriber, carrying the frozen figures and both links', async () => {
		const subscriber = await insertSubscriber(unique('Warga Berlangganan Laporan'));
		await recordTheMonth();
		await publishFirstRevision();

		const summary = await sendMonthlyReportEmails(testDb.db, clock);

		expect(summary).toMatchObject({ periods: [PERIOD], enqueued: 1, alreadySent: 0 });
		const rows = await queuedOf(MONTHLY_REPORT_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].recipient).toBe(subscriber.email);
		expect(rows[0].payload).toMatchObject({
			period: PERIOD,
			openingBalance: 0,
			totalIncome: INCOME,
			totalExpense: EXPENSE,
			closingBalance: INCOME - EXPENSE,
			reportUrl: `${readOrigin()}/reports/${PERIOD}`,
			locale: 'id'
		});
	});

	it('addresses the unsubscribe link to that one resident and that one kind', async () => {
		const subscriber = await insertSubscriber(unique('Warga Ingin Berhenti'));
		await recordTheMonth();
		await publishFirstRevision();

		await sendMonthlyReportEmails(testDb.db, clock);

		const [row] = await queuedOf(MONTHLY_REPORT_KIND);
		const prefix = `${readOrigin()}/unsubscribe/`;
		const url = String(row.payload.unsubscribeUrl);
		expect(url.startsWith(prefix)).toBe(true);
		expect(verifyUnsubscribeToken(url.slice(prefix.length))).toEqual({
			valid: true,
			residentId: subscriber.residentId,
			kind: SUBSCRIPTION_KIND.monthlyReport
		});
	});

	it('sends nothing at all to a warga who never asked for it', async () => {
		const optedOut = await insertResident(unique('Warga Tidak Berlangganan'));
		await recordTheMonth();
		await publishFirstRevision();

		await sendMonthlyReportEmails(testDb.db, clock);

		const recipients = (await queuedOf(MONTHLY_REPORT_KIND)).map((row) => row.recipient);
		expect(recipients).not.toContain(optedOut.email);
	});

	it('queues nothing a second time for a Periode already sent', async () => {
		await insertSubscriber(unique('Warga Tidak Mau Dobel'));
		await recordTheMonth();
		await publishFirstRevision();
		await sendMonthlyReportEmails(testDb.db, clock);

		const second = await sendMonthlyReportEmails(testDb.db, clock);

		expect(second).toMatchObject({ enqueued: 0, alreadySent: 1 });
		expect(await queuedOf(MONTHLY_REPORT_KIND)).toHaveLength(1);
	});

	it('leaves a Periode published longer ago than the window alone', async () => {
		await insertSubscriber(unique('Warga Berlangganan Terlambat'));
		await recordTheMonth();
		await publishFirstRevision();
		clock.advance(MONTHLY_REPORT_ANNOUNCEMENT_WINDOW_MILLISECONDS + DAY_MILLISECONDS);

		const summary = await sendMonthlyReportEmails(testDb.db, clock);

		expect(summary).toMatchObject({ periods: [], enqueued: 0 });
		expect(await queuedOf(MONTHLY_REPORT_KIND)).toEqual([]);
	});

	it('announces a Periode once, not once per revision', async () => {
		await insertSubscriber(unique('Warga Satu Pengumuman'));
		await recordTheMonth();
		await publishFirstRevision();
		await sendMonthlyReportEmails(testDb.db, clock);
		await reopen();
		await record('2026-03-21', expenseCategoryId, 125_000);
		await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Nota tanggal 21 baru ditemukan.'
		});

		await sendMonthlyReportEmails(testDb.db, clock);

		expect(await queuedOf(MONTHLY_REPORT_KIND)).toHaveLength(1);
	});
});

describe('the send-monthly-report job', () => {
	it('queues the emails when the scheduler runs it, and not again on the next day', async () => {
		// Two runs in two different schedule periods, so the `job_runs` lock cannot be what stops the
		// second one — the check against `email_queue` in the sender is.
		await insertSubscriber(unique('Warga Dijadwalkan'));
		await recordTheMonth();
		await publishFirstRevision();
		const summaries: unknown[] = [];
		const job = monthlyReportJob({ report: (summary) => summaries.push(summary) });

		const first = await runJob({ db: testDb.db, clock, job });
		clock.advance(DAY_MILLISECONDS + STEP_MILLISECONDS);
		const second = await runJob({ db: testDb.db, clock, job });

		expect(first).toMatchObject({ jobName: MONTHLY_REPORT_JOB_NAME });
		expect(second.period).not.toBe(first.period);
		expect(summaries).toEqual([
			expect.objectContaining({ enqueued: 1 }),
			expect.objectContaining({ enqueued: 0, alreadySent: 1 })
		]);
		expect(await queuedOf(MONTHLY_REPORT_KIND)).toHaveLength(1);
	});

	it('runs on a daily schedule in the complex time zone', () => {
		expect(monthlyReportJob().schedule.description).toBe('daily in Asia/Jakarta');
	});

	it('hands a fake email sender a readable email once the drain job runs', async () => {
		// The whole path, with no mail server: publish, queue, drain, read the message.
		await insertSubscriber(unique('Warga Menerima Email'));
		await recordTheMonth();
		await publishFirstRevision();
		await sendMonthlyReportEmails(testDb.db, clock);
		const sender = new FakeEmailSender();

		await runJob({ db: testDb.db, clock, job: emailQueueDrainJob({ sender }) });

		const message = sender.messages.find((sent) => sent.subject.includes(`periode ${PERIOD}`));
		if (!message) {
			throw new Error('Expected the monthly report email to have been sent, and it was not.');
		}
		expect(message.text).toContain(formatRupiah(rupiah(INCOME)));
		expect(message.text).toContain(`${readOrigin()}/reports/${PERIOD}`);
		expect(message.text).toContain(`${readOrigin()}/unsubscribe/`);
	});
});

describe('publishing a revision', () => {
	it('queues the revision notification to the same subscribers, with its number and its reason', async () => {
		const subscriber = await insertSubscriber(unique('Warga Diberi Tahu Revisi'));
		await recordTheMonth();
		await publishFirstRevision();
		await reopen();
		await record('2026-03-21', expenseCategoryId, 125_000);

		await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Nota perbaikan pompa tanggal 21 baru ditemukan.'
		});

		const rows = await queuedOf(MONTHLY_REPORT_REVISED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].recipient).toBe(subscriber.email);
		expect(rows[0].payload).toMatchObject({
			period: PERIOD,
			revision: 2,
			reason: 'Nota perbaikan pompa tanggal 21 baru ditemukan.',
			reportUrl: `${readOrigin()}/reports/${PERIOD}`
		});
	});

	it('queues nothing on revision 1, which revises nothing', async () => {
		await insertSubscriber(unique('Warga Tanpa Revisi'));
		await recordTheMonth();

		await publishFirstRevision();

		expect(await queuedOf(MONTHLY_REPORT_REVISED_KIND)).toEqual([]);
	});

	it('sends no revision notification to a warga who never asked for the report', async () => {
		const optedOut = await insertResident(unique('Warga Diam Soal Revisi'));
		await recordTheMonth();
		await publishFirstRevision();
		await reopen();

		await publishReport(testDb.db, clock, {
			actorId: adminId,
			period: PERIOD,
			revisionReason: 'Perbaikan angka.'
		});

		const recipients = (await queuedOf(MONTHLY_REPORT_REVISED_KIND)).map((row) => row.recipient);
		expect(recipients).not.toContain(optedOut.email);
	});

	it('still publishes when queuing the notification fails', async () => {
		// The rule `../dues/notification.ts` states: the publication is already committed by the time
		// the email is queued, so a failure there must never be reported as a failed publication.
		await insertSubscriber(unique('Warga Email Gagal'));
		await recordTheMonth();
		await publishFirstRevision();
		await reopen();

		const report = await publishReport(
			testDb.db,
			clock,
			{ actorId: adminId, period: PERIOD, revisionReason: 'Perbaikan angka.' },
			{
				notify: async () => {
					throw new Error('the queue is on fire');
				}
			}
		);

		expect(report.revision).toBe(2);
	});
});

describe('monthlyReportTemplate', () => {
	it('writes every figure, the report link and the unsubscribe link, in the payload locale', () => {
		const rendered = monthlyReportTemplate(
			monthlyReportPayload({
				period: PERIOD,
				openingBalance: 250_000,
				totalIncome: INCOME,
				totalExpense: EXPENSE,
				closingBalance: 250_000 + INCOME - EXPENSE,
				reportUrl: 'https://komplek.local/reports/2026-03',
				unsubscribeUrl: 'https://komplek.local/unsubscribe/abc.def',
				locale: 'id'
			})
		);

		expect(rendered.subject).toBe('Laporan keuangan periode 2026-03 sudah terbit');
		expect(rendered.text).toContain(formatRupiah(rupiah(250_000)));
		expect(rendered.text).toContain(formatRupiah(rupiah(INCOME)));
		expect(rendered.text).toContain(formatRupiah(rupiah(EXPENSE)));
		expect(rendered.text).toContain(formatRupiah(rupiah(1_350_000)));
		expect(rendered.text).toContain('https://komplek.local/reports/2026-03');
		expect(rendered.text).toContain('https://komplek.local/unsubscribe/abc.def');
	});

	it('renders in the locale the payload names', () => {
		const rendered = monthlyReportTemplate(
			monthlyReportPayload({
				period: PERIOD,
				openingBalance: 0,
				totalIncome: 0,
				totalExpense: 0,
				closingBalance: 0,
				reportUrl: 'https://komplek.local/reports/2026-03',
				unsubscribeUrl: 'https://komplek.local/unsubscribe/abc.def',
				locale: 'en'
			})
		);

		expect(rendered.subject).toBe('The financial report for 2026-03 has been published');
	});

	it.each([
		['period', { period: 1 }],
		['reportUrl', { reportUrl: 1 }],
		['unsubscribeUrl', { unsubscribeUrl: 1 }],
		['locale', { locale: 'kl' }],
		['totalIncome', { totalIncome: 'banyak' }],
		['closingBalance', { closingBalance: 1.5 }]
	])('throws TypeError when %s is not what it must be', (_name, overrides) => {
		const payload = {
			period: PERIOD,
			openingBalance: 0,
			totalIncome: 0,
			totalExpense: 0,
			closingBalance: 0,
			reportUrl: 'u',
			unsubscribeUrl: 'u',
			locale: 'id',
			...overrides
		};

		expect(() => monthlyReportTemplate(payload)).toThrow(TypeError);
	});
});

describe('reportRevisedTemplate', () => {
	it('writes the revision number, the reason and both links, and no figures', () => {
		const rendered = reportRevisedTemplate(
			reportRevisedPayload({
				period: PERIOD,
				revision: 3,
				reason: 'Nota perbaikan pompa tanggal 21 baru ditemukan.',
				reportUrl: 'https://komplek.local/reports/2026-03',
				unsubscribeUrl: 'https://komplek.local/unsubscribe/abc.def',
				locale: 'id'
			})
		);

		expect(rendered.subject).toBe('Laporan periode 2026-03 direvisi (revisi 3)');
		expect(rendered.text).toContain('Nota perbaikan pompa tanggal 21 baru ditemukan.');
		expect(rendered.text).toContain('https://komplek.local/reports/2026-03');
		expect(rendered.text).toContain('https://komplek.local/unsubscribe/abc.def');
		expect(rendered.text).not.toContain('Rp');
	});

	it.each([
		['period', { period: 1 }],
		['revision', { revision: 'dua' }],
		['reason', { reason: 1 }],
		['locale', { locale: 'kl' }]
	])('throws TypeError when %s is not what it must be', (_name, overrides) => {
		const payload = {
			period: PERIOD,
			revision: 2,
			reason: 'r',
			reportUrl: 'u',
			unsubscribeUrl: 'u',
			locale: 'id',
			...overrides
		};

		expect(() => reportRevisedTemplate(payload)).toThrow(TypeError);
	});
});
