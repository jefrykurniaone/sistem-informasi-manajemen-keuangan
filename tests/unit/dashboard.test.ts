import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { civilDayOf } from '$lib/time';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { CASH_CATEGORY_TYPE } from '$lib/server/db/schema/cash-category';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaints,
	type ComplaintStatus
} from '$lib/server/db/schema/complaint';
import { duesRates } from '$lib/server/db/schema/dues-rate';
import { invoices } from '$lib/server/db/schema/invoice';
import { OCCUPANCY_ROLE, occupancies } from '$lib/server/db/schema/occupancy';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { POST_STATUS, POST_TYPE, posts, type PostStatus } from '$lib/server/db/schema/post';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { JOB_RUN_PRUNE_JOB_NAME } from '$lib/server/scheduler';
import { createCashCategory } from '$lib/server/services/cash/category';
import { recordOpeningBalance } from '$lib/server/services/cash/opening-balance';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';
import { adminDashboard, residentDashboard } from '$lib/server/services/dashboard';
import { issueInvoicesForPeriod } from '$lib/server/services/dues/issuance';
import { INVOICE_STATUS, invoiceStatus } from '$lib/server/services/dues/queries';

/**
 * The Beranda service over a database seeded once: two houses billed for `2026-09` through the real
 * issuance path, one of them paid off, one Pembayaran still waiting, an opening balance in the month
 * before and two Transaksi Kas inside the month, two Keluhan, and three Post of which one is a draft.
 *
 * Two things this file is careful about:
 *
 * 1. **The invoice figures are compared, never memorised.** `the invoice figures agree with
 *    invoiceStatus` reads the same rows back and folds them with `invoiceStatus` itself, so the test
 *    fails if the service ever starts deciding "lunas" or "menunggak" its own way, not only if the
 *    numbers move.
 * 2. **Every figure is pinned to a fake `Clock`**, including the WIB month boundary: half past
 *    midnight on 1 September in Jakarta is still 31 August in UTC, and the summary must be
 *    September's either way.
 */

const testDb = testDatabase();

/** The Periode every Tagihan in this file belongs to. */
const MONTH = '2026-09';

/** 10.00 WIB on 20 September 2026 — well inside the month, and past the 5th. */
const DURING_MONTH = '2026-09-20T03:00:00.000Z';

/** 00.30 WIB on 1 September 2026, which is still 31 August in UTC. */
const WIB_MONTH_EDGE = '2026-08-31T17:30:00.000Z';

/** The Tarif in force, and so the amount of every Tagihan issued for `MONTH`. */
const MONTHLY_RATE = rupiah(150_000);

/** The cash the complex already had when it started using the application, dated before `MONTH`. */
const OPENING_BALANCE = rupiah(5_000_000);

/** The one income Transaksi Kas recorded inside `MONTH`. */
const MONTH_INCOME = rupiah(300_000);

/** The one expense Transaksi Kas recorded inside `MONTH`. */
const MONTH_EXPENSE = rupiah(125_000);

/** The Pembayaran nobody has decided on yet. */
const PENDING_AMOUNT = rupiah(75_000);

/** A Keluhan category. Never asserted on, only required by the table. */
const COMPLAINT_CATEGORY = 'Fasilitas umum';

/** The title of the one Keluhan that is still running. */
const OPEN_COMPLAINT_TITLE = 'Lampu jalan blok depan mati';

/** One account, the `residents` row that points at it, and the roles it holds. */
interface Person {
	readonly userId: string;
	readonly residentId: string;
}

let pengurus: Person;
let wargaLunas: Person;
let wargaMenunggak: Person;
let wargaTanpaUnit: Person;
let unitLunas: { id: string; block: string; number: string };
let unitMenunggak: { id: string; block: string; number: string };
let newerPostId: string;
let olderPostId: string;

/** An account with a `residents` row, holding `roles` on top of the trigger's default `resident`. */
async function insertPerson(name: string, roles: readonly Role[] = []): Promise<Person> {
	const userId = randomUUID();
	const now = new Date(DURING_MONTH);
	await testDb.db.insert(user).values({
		id: userId,
		name,
		email: `${userId}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	for (const role of roles) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: now });
	}
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: now })
		.returning();
	return { userId, residentId: resident.id };
}

/** A house, active so that issuance bills it. */
async function insertUnit(block: string): Promise<{ id: string; block: string; number: string }> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block, number: '1', createdAt: new Date(DURING_MONTH) })
		.returning();
	return { id: row.id, block: row.block, number: row.number };
}

/** A running Masa Huni, written straight into `occupancies` as the issuance tests do. */
async function insertOccupancy(unitId: string, residentId: string): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: '2026-01-01',
		endedOn: null,
		createdAt: new Date(DURING_MONTH)
	});
}

/** The Tagihan issued for `unitId` in `MONTH`. */
async function invoiceOf(unitId: string): Promise<{ id: string; amount: Rupiah }> {
	const [row] = await testDb.db
		.select({ id: invoices.id, amount: invoices.amount })
		.from(invoices)
		.where(and(eq(invoices.unitId, unitId), eq(invoices.period, MONTH)));
	return row;
}

/** A Keluhan, written straight into `complaints` — this file tests reading, not the state machine. */
async function insertComplaint(
	reporterId: string,
	title: string,
	status: ComplaintStatus,
	createdAt: string
): Promise<void> {
	await testDb.db.insert(complaints).values({
		reporterId,
		title,
		category: COMPLAINT_CATEGORY,
		description: 'Sudah tiga malam gelap sekali.',
		status,
		visibility: COMPLAINT_VISIBILITY.private,
		createdAt: new Date(createdAt),
		statusChangedAt: new Date(createdAt)
	});
}

/** A Post, written straight into `posts`. `publishedAt` is null on a draft. */
async function insertPost(
	authorId: string,
	title: string,
	status: PostStatus,
	publishedAt: string | null
): Promise<string> {
	const [row] = await testDb.db
		.insert(posts)
		.values({
			type: POST_TYPE.announcement,
			title,
			summary: 'Ringkasan singkat.',
			bodyHtml: '<p>Isi pengumuman.</p>',
			category: 'Pengumuman',
			status,
			authorId,
			publishedAt: publishedAt === null ? null : new Date(publishedAt),
			createdAt: new Date('2026-09-01T00:00:00.000Z')
		})
		.returning();
	return row.id;
}

/** The cash book, seeded through its own services so the append-only rules hold. */
async function seedCashBook(): Promise<void> {
	const clock = new FakeClock(DURING_MONTH);
	const fileStore = new FakeFileStore(clock);

	const incomeCategory = await createCashCategory(testDb.db, clock, {
		actorId: pengurus.userId,
		name: 'Sumbangan kegiatan warga',
		type: CASH_CATEGORY_TYPE.income
	});
	const expenseCategory = await createCashCategory(testDb.db, clock, {
		actorId: pengurus.userId,
		name: 'Perbaikan fasilitas umum',
		type: CASH_CATEGORY_TYPE.expense
	});

	await recordOpeningBalance(testDb.db, clock, {
		actorId: pengurus.userId,
		amount: OPENING_BALANCE,
		occurredOn: '2026-08-01'
	});
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: pengurus.userId,
		occurredOn: '2026-09-10',
		categoryId: incomeCategory.id,
		amount: MONTH_INCOME,
		description: 'Sumbangan tujuh belasan'
	});
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: pengurus.userId,
		occurredOn: '2026-09-12',
		categoryId: expenseCategory.id,
		amount: MONTH_EXPENSE,
		description: 'Perbaikan pompa air'
	});
}

beforeAll(async () => {
	pengurus = await insertPerson('Pengurus Beranda', [ROLE.admin, ROLE.superuser]);
	wargaLunas = await insertPerson('Warga Sudah Bayar');
	wargaMenunggak = await insertPerson('Warga Belum Bayar');
	wargaTanpaUnit = await insertPerson('Warga Tanpa Rumah');

	unitLunas = await insertUnit('BRD-A');
	unitMenunggak = await insertUnit('BRD-B');
	await insertOccupancy(unitLunas.id, wargaLunas.residentId);
	await insertOccupancy(unitMenunggak.id, wargaMenunggak.residentId);

	await testDb.db.insert(duesRates).values({
		amount: MONTHLY_RATE,
		effectiveFrom: '2026-01-01',
		createdAt: new Date(DURING_MONTH)
	});
	await issueInvoicesForPeriod(testDb.db, new FakeClock(DURING_MONTH), MONTH);

	// One house pays its Tagihan in full: a verified Pembayaran and the Alokasi that answers it.
	const paidInvoice = await invoiceOf(unitLunas.id);
	const [verified] = await testDb.db
		.insert(payments)
		.values({
			unitId: unitLunas.id,
			recordedBy: wargaLunas.residentId,
			amount: paidInvoice.amount,
			receivedOn: '2026-09-03',
			method: PAYMENT_METHOD.transfer,
			status: PAYMENT_STATUS.verified,
			verifiedBy: pengurus.residentId,
			verifiedAt: new Date('2026-09-04T02:00:00.000Z'),
			createdAt: new Date('2026-09-03T02:00:00.000Z')
		})
		.returning();
	await testDb.db.insert(allocations).values({
		paymentId: verified.id,
		invoiceId: paidInvoice.id,
		amount: paidInvoice.amount,
		createdAt: new Date('2026-09-04T02:00:00.000Z')
	});

	// The other house has reported a Pembayaran that nobody has decided on yet.
	await testDb.db.insert(payments).values({
		unitId: unitMenunggak.id,
		recordedBy: wargaMenunggak.residentId,
		amount: PENDING_AMOUNT,
		receivedOn: '2026-09-18',
		method: PAYMENT_METHOD.transfer,
		status: PAYMENT_STATUS.pending,
		createdAt: new Date('2026-09-18T02:00:00.000Z')
	});

	await seedCashBook();

	await insertComplaint(
		wargaLunas.residentId,
		OPEN_COMPLAINT_TITLE,
		COMPLAINT_STATUS.new,
		'2026-09-15T02:00:00.000Z'
	);
	await insertComplaint(
		wargaMenunggak.residentId,
		'Pagar belakang sudah diperbaiki',
		COMPLAINT_STATUS.resolved,
		'2026-09-08T02:00:00.000Z'
	);

	olderPostId = await insertPost(
		pengurus.residentId,
		'Kerja bakti bulan ini',
		POST_STATUS.published,
		'2026-09-05T02:00:00.000Z'
	);
	newerPostId = await insertPost(
		pengurus.residentId,
		'Jadwal ronda diperbarui',
		POST_STATUS.published,
		'2026-09-15T02:00:00.000Z'
	);
	await insertPost(pengurus.residentId, 'Draf rapat warga', POST_STATUS.draft, null);
});

describe('adminDashboard', () => {
	it('summarises the WIB month the clock is in', async () => {
		const summary = await adminDashboard(testDb.db, new FakeClock(DURING_MONTH), pengurus.userId);

		expect(summary.month).toBe(MONTH);
		expect(summary.invoices).toEqual({
			issuedCount: 2,
			issuedAmount: rupiah(2 * MONTHLY_RATE),
			paidCount: 1,
			paidAmount: MONTHLY_RATE,
			overdueCount: 1,
			overdueAmount: MONTHLY_RATE
		});
		expect(summary.pendingPayments).toEqual({ count: 1, amount: PENDING_AMOUNT });
		expect(summary.cash).toEqual({
			balance: rupiah(OPENING_BALANCE + MONTH_INCOME - MONTH_EXPENSE),
			incomeThisMonth: MONTH_INCOME,
			expenseThisMonth: MONTH_EXPENSE
		});
		expect(summary.complaints).toEqual({ new: 1, reviewing: 0, working: 0 });
	});

	it('lists the three newest published Post, newest first, and never a draft', async () => {
		const summary = await adminDashboard(testDb.db, new FakeClock(DURING_MONTH), pengurus.userId);

		expect(summary.latestPosts.map((post) => post.id)).toEqual([newerPostId, olderPostId]);
		expect(summary.latestPosts[0]).toMatchObject({
			title: 'Jadwal ronda diperbarui',
			type: POST_TYPE.announcement
		});
	});

	it('reports every registered job, with no run behind it yet', async () => {
		const summary = await adminDashboard(testDb.db, new FakeClock(DURING_MONTH), pengurus.userId);

		const prune = summary.jobs?.find((job) => job.name === JOB_RUN_PRUNE_JOB_NAME);
		expect(prune).toEqual({ name: JOB_RUN_PRUNE_JOB_NAME, lastRunAt: null, status: null });
	});

	it('still reads September from half past midnight WIB, which is 31 August in UTC', async () => {
		const summary = await adminDashboard(testDb.db, new FakeClock(WIB_MONTH_EDGE), pengurus.userId);

		expect(summary.month).toBe(MONTH);
		expect(summary.invoices.issuedCount).toBe(2);
		// August would carry the opening balance instead, which is the point of dating it 1 August.
		expect(summary.cash?.incomeThisMonth).toBe(MONTH_INCOME);
		// Nothing is menunggak yet on 1 September: the Tagihan fall due on the 5th.
		expect(summary.invoices.overdueCount).toBe(0);
		expect(summary.invoices.paidCount).toBe(1);
	});

	it('agrees with invoiceStatus computed over the same rows', async () => {
		const clock = new FakeClock(DURING_MONTH);
		const summary = await adminDashboard(testDb.db, clock, pengurus.userId);
		const expected = await invoiceFiguresFromInvoiceStatus(clock);

		expect(summary.invoices).toEqual(expected);
	});
});

describe('residentDashboard', () => {
	it('carries the house a Warga lives in, with nothing owed once it is paid', async () => {
		const summary = await residentDashboard(
			testDb.db,
			new FakeClock(DURING_MONTH),
			wargaLunas.residentId
		);

		expect(summary.hasUnit).toBe(true);
		expect(summary.units).toEqual([
			{
				unitId: unitLunas.id,
				label: `Blok ${unitLunas.block} No ${unitLunas.number}`,
				openInvoices: { count: 0, amount: rupiah(0), overdueCount: 0 },
				creditBalance: rupiah(0)
			}
		]);
	});

	it('counts what is still owed, and a pending Pembayaran is not Saldo Titipan', async () => {
		const summary = await residentDashboard(
			testDb.db,
			new FakeClock(DURING_MONTH),
			wargaMenunggak.residentId
		);

		expect(summary.units).toEqual([
			{
				unitId: unitMenunggak.id,
				label: `Blok ${unitMenunggak.block} No ${unitMenunggak.number}`,
				openInvoices: { count: 1, amount: MONTHLY_RATE, overdueCount: 1 },
				creditBalance: rupiah(0)
			}
		]);
	});

	it('says so rather than showing zeroes when the Warga has no house yet', async () => {
		const summary = await residentDashboard(
			testDb.db,
			new FakeClock(DURING_MONTH),
			wargaTanpaUnit.residentId
		);

		expect(summary).toMatchObject({ hasUnit: false, units: [], complaints: [] });
		expect(summary.latestPosts).toHaveLength(2);
	});

	it('carries only this Warga’s own unfinished Keluhan', async () => {
		const clock = new FakeClock(DURING_MONTH);

		const reporter = await residentDashboard(testDb.db, clock, wargaLunas.residentId);
		const neighbour = await residentDashboard(testDb.db, clock, wargaMenunggak.residentId);

		expect(reporter.complaints).toEqual([
			{
				id: expect.any(String),
				title: OPEN_COMPLAINT_TITLE,
				status: COMPLAINT_STATUS.new
			}
		]);
		// The neighbour's own Keluhan is resolved, and the open one above is not theirs.
		expect(neighbour.complaints).toEqual([]);
	});
});

/**
 * The same six figures, worked out here from the rows in the database and `invoiceStatus` itself.
 *
 * Deliberately not a copy of the service's shape: it reads the Tagihan and the Alokasi back, asks
 * `invoiceStatus` what each one is, and adds them up, so the comparison proves the service uses that
 * definition rather than proving it still returns the numbers somebody typed into this file.
 */
async function invoiceFiguresFromInvoiceStatus(clock: FakeClock) {
	const rows = await testDb.db
		.select({ id: invoices.id, amount: invoices.amount, dueDate: invoices.dueDate })
		.from(invoices)
		.where(eq(invoices.period, MONTH));
	const allocated = await testDb.db
		.select({ invoiceId: allocations.invoiceId, amount: allocations.amount })
		.from(allocations)
		.where(
			inArray(
				allocations.invoiceId,
				rows.map((row) => row.id)
			)
		);

	const today = civilDayOf(clock.now());

	let issuedAmount = 0;
	let paidCount = 0;
	let paidAmount = 0;
	let overdueCount = 0;
	let overdueAmount = 0;
	for (const row of rows) {
		const allocatedAmount = rupiah(
			allocated
				.filter((allocation) => allocation.invoiceId === row.id)
				.reduce((total, allocation) => total + allocation.amount, 0)
		);
		issuedAmount += row.amount;
		const status = invoiceStatus(
			{ amount: row.amount, allocatedAmount, dueDate: row.dueDate, voidedAt: null },
			today
		);
		if (status === INVOICE_STATUS.paid) {
			paidCount += 1;
			paidAmount += row.amount;
		}
		if (status === INVOICE_STATUS.overdue) {
			overdueCount += 1;
			overdueAmount += row.amount - allocatedAmount;
		}
	}

	return {
		issuedCount: rows.length,
		issuedAmount: rupiah(issuedAmount),
		paidCount,
		paidAmount: rupiah(paidAmount),
		overdueCount,
		overdueAmount: rupiah(overdueAmount)
	};
}
