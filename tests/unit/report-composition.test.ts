import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	CASH_CATEGORY_TYPE,
	SYSTEM_CATEGORY_KEY,
	cashCategories,
	type CashCategoryType
} from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { invoices } from '$lib/server/db/schema/invoice';
import { payments, PAYMENT_METHOD, PAYMENT_STATUS } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { cashBook } from '$lib/server/services/cash/balance';
import { createCashCategory } from '$lib/server/services/cash/category';
import { recordCashCorrection } from '$lib/server/services/cash/correction';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';
import {
	composeReportFigures,
	currentReportPeriod,
	transactionsInCategory
} from '$lib/server/services/report/composition';

/**
 * What a Laporan Bulanan says, worked out from the buku kas and that month's Tagihan —
 * `docs/spec-kas-laporan-v1.md`'s "laporan bulanan dihasilkan dari buku kas, bukan diketik".
 *
 * The two things this file exists to pin down are the ones a reader would otherwise have to take on
 * trust: that the four headline figures really are the cash book's own arithmetic rather than a
 * second, hopeful copy of it, and that the spec's "dua angka yang berbeda" are genuinely two
 * different numbers under the late-payment scenario the spec names — "tagihan Januari dilunasi 20
 * Februari".
 *
 * `tests/unit/report-revision.test.ts` is the other half: what happens when the figures below are
 * frozen, and what stops them from being frozen twice.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** One minute between rows, so `createdAt` orders them exactly as they were recorded. */
const STEP_MILLISECONDS = 60_000;

/** The month most of this file's assertions are about. */
const JANUARY = '2026-01';

/** Where a January Tagihan is settled, on the spec's own late-payment date. */
const FEBRUARY = '2026-02';

let sequence = 0;

/** Makes every name and block this file writes different from every other one. */
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

/** An account together with the `residents` row a Pembayaran is recorded by. */
async function insertResidentRow(userId: string): Promise<string> {
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** A house. */
async function insertUnitRow(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** The migration's "Iuran warga" row, looked up by its system key rather than by its name. */
async function duesCategoryId(): Promise<string> {
	const [row] = await testDb.db
		.select({ id: cashCategories.id })
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	return row.id;
}

let adminId: string;
let superuserId: string;
let clock: FakeClock;
let fileStore: FakeFileStore;

beforeEach(async () => {
	// Every figure this file checks is a sum over the whole schema — the cash book has no per-test
	// scoping — so rows left behind by an earlier test would land in a later one's totals. Cleared in
	// dependency order: an Alokasi points at a Pembayaran and a Tagihan, so it goes first.
	await testDb.db.delete(allocations);
	await testDb.db.delete(payments);
	await testDb.db.delete(invoices);
	await testDb.db.delete(cashTransactions);

	adminId = await insertUserWithRole(unique('Pengurus Laporan'), ROLE.admin);
	superuserId = await insertUserWithRole(unique('Pengurus Kategori Laporan'), ROLE.superuser);
	clock = new FakeClock(START);
	fileStore = new FakeFileStore(clock);
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

/** One Transaksi Kas through the service, so the Periode and the rules behave as they really do. */
async function record(
	categoryId: string,
	occurredOn: string,
	amount: number,
	description = 'Baris buku kas'
): Promise<void> {
	clock.advance(STEP_MILLISECONDS);
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: adminId,
		occurredOn,
		categoryId,
		amount: rupiah(amount),
		description
	});
}

/**
 * One kas masuk in the "Iuran warga" system category, written straight into the table.
 *
 * `recordCashTransaction` refuses this category by design — the spec's user story 7, "sistem menolak
 * saya mencatat kas masuk pada kategori Iuran warga secara manual" — and its only real writer is
 * #29's payment verification, which runs on another branch. Inserting the row directly is the same
 * thing every other service-layer test in this repository does for data another ticket owns.
 */
async function recordDuesCashIn(occurredOn: string, amount: number): Promise<void> {
	clock.advance(STEP_MILLISECONDS);
	await testDb.db.insert(cashTransactions).values({
		occurredOn,
		type: CASH_CATEGORY_TYPE.income,
		categoryId: await duesCategoryId(),
		amount: rupiah(amount),
		description: 'Verifikasi pembayaran iuran',
		recordedBy: adminId,
		createdAt: clock.now()
	});
}

/**
 * One Tagihan for one house in one Periode.
 *
 * `voidedBy` is a `residents.id` and all three cancellation columns move together, because
 * `invoices_void_check` is all-or-nothing — so cancelling one here takes a resident row to attribute
 * it to, exactly as the real cancellation path does.
 */
async function issueInvoiceRow(
	unitId: string,
	period: string,
	amount: number,
	voidedBy?: string
): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({
			unitId,
			period,
			amount: rupiah(amount),
			dueDate: `${period}-05`,
			issuedAt: new Date(`${period}-01T00:00:00.000Z`),
			voidedAt: voidedBy === undefined ? null : new Date(`${period}-10T00:00:00.000Z`),
			voidReason: voidedBy === undefined ? null : 'Rumah kosong sepanjang bulan itu.',
			voidedBy: voidedBy ?? null
		})
		.returning();
	return row.id;
}

/** A verified Pembayaran with an Alokasi against `invoiceId`. */
async function settle(
	unitId: string,
	residentId: string,
	invoiceId: string,
	amount: number,
	receivedOn: string
): Promise<void> {
	const [payment] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy: residentId,
			amount: rupiah(amount),
			receivedOn,
			method: PAYMENT_METHOD.transfer,
			status: PAYMENT_STATUS.verified,
			verifiedBy: residentId,
			verifiedAt: new Date(`${receivedOn}T00:00:00.000Z`),
			createdAt: new Date(`${receivedOn}T00:00:00.000Z`)
		})
		.returning();
	await testDb.db.insert(allocations).values({
		paymentId: payment.id,
		invoiceId,
		amount: rupiah(amount),
		createdAt: new Date(`${receivedOn}T00:00:00.000Z`)
	});
}

/** The figures for one month, at the clock this file's setup left running. */
async function figuresFor(period: string) {
	return composeReportFigures(testDb.db, clock, period);
}

/** One breakdown line, found by category and direction. */
function lineFor(
	lines: readonly { categoryId: string; type: string; total: Rupiah }[],
	categoryId: string,
	type: CashCategoryType
) {
	return lines.find((line) => line.categoryId === categoryId && line.type === type);
}

describe('the four headline figures', () => {
	it('carries everything dated before the month into the opening balance, and nothing dated inside it', async () => {
		const donations = await addCategory('Sumbangan warga', CASH_CATEGORY_TYPE.income);
		const repairs = await addCategory('Perbaikan gerbang', CASH_CATEGORY_TYPE.expense);

		// Before January: a net 700_000 the month opens on.
		await record(donations, '2025-12-10', 1_000_000);
		await record(repairs, '2025-12-20', 300_000);
		// Inside January.
		await record(donations, '2026-01-05', 500_000);
		await record(repairs, '2026-01-18', 200_000);
		// After January — must not reach any of the four.
		await record(donations, '2026-02-03', 9_000_000);

		const figures = await figuresFor(JANUARY);

		expect(figures.openingBalance).toBe(700_000);
		expect(figures.totalIncome).toBe(500_000);
		expect(figures.totalExpense).toBe(200_000);
		expect(figures.closingBalance).toBe(1_000_000);
	});

	it('satisfies the identity the database checks, on a month with nothing in it at all', async () => {
		const figures = await figuresFor('2026-07');

		expect(figures).toMatchObject({
			openingBalance: 0,
			totalIncome: 0,
			totalExpense: 0,
			closingBalance: 0,
			duesCollected: 0,
			duesUnitsPaid: 0,
			duesUnitsUnpaid: 0,
			categoryBreakdown: []
		});
	});

	it('includes the first and the last day of the month, February included', async () => {
		// February is the month a range built by hand gets wrong, and `monthDayRange` is the one
		// definition both the cash book and the report read it through.
		const donations = await addCategory('Sumbangan Februari', CASH_CATEGORY_TYPE.income);
		await record(donations, '2026-01-31', 11_000);
		await record(donations, '2026-02-01', 100_000);
		await record(donations, '2026-02-28', 200_000);
		await record(donations, '2026-03-01', 22_000);

		const figures = await figuresFor(FEBRUARY);

		expect(figures.openingBalance).toBe(11_000);
		expect(figures.totalIncome).toBe(300_000);
		expect(figures.closingBalance).toBe(311_000);
	});

	it('refuses a period that is not a calendar month', async () => {
		await expect(figuresFor('2026-13')).rejects.toThrow(TypeError);
	});
});

describe('the per-category breakdown', () => {
	it('has one line per category per direction, with the name as it read at publication', async () => {
		const donations = await addCategory('Sumbangan rincian', CASH_CATEGORY_TYPE.income);
		const repairs = await addCategory('Perbaikan rincian', CASH_CATEGORY_TYPE.expense);
		await record(donations, '2026-01-04', 250_000);
		await record(donations, '2026-01-09', 150_000);
		await record(repairs, '2026-01-11', 75_000);

		const figures = await figuresFor(JANUARY);

		expect(lineFor(figures.categoryBreakdown, donations, CASH_CATEGORY_TYPE.income)?.total).toBe(
			400_000
		);
		expect(lineFor(figures.categoryBreakdown, repairs, CASH_CATEGORY_TYPE.expense)?.total).toBe(
			75_000
		);
		expect(figures.categoryBreakdown).toHaveLength(2);
		expect(figures.categoryBreakdown.map((line) => line.name)).toEqual(
			[...figures.categoryBreakdown].map((line) => line.name).sort((a, b) => a.localeCompare(b))
		);
	});

	it('shows a Koreksi as an opposite-direction line in the same category, never netted away', async () => {
		// `src/lib/server/db/schema/monthly-report.ts`: "sebuah Koreksi adalah baris bertipe
		// berlawanan pada kategori yang sama, jadi ia muncul di bagian laporan yang berlawanan alih-alih
		// diam-diam saling meniadakan" — the spec's "buku kas menampilkan keduanya" carried up.
		const repairs = await addCategory('Perbaikan dikoreksi', CASH_CATEGORY_TYPE.expense);
		await record(repairs, '2026-01-06', 500_000);
		const [written] = await testDb.db
			.select()
			.from(cashTransactions)
			.where(eq(cashTransactions.categoryId, repairs));
		clock.advance(STEP_MILLISECONDS);
		await recordCashCorrection(testDb.db, clock, {
			actorId: adminId,
			transactionId: written.id,
			reason: 'Nota itu ternyata sudah dicatat bulan lalu.'
		});

		const figures = await figuresFor(JANUARY);

		expect(lineFor(figures.categoryBreakdown, repairs, CASH_CATEGORY_TYPE.expense)?.total).toBe(
			500_000
		);
		expect(lineFor(figures.categoryBreakdown, repairs, CASH_CATEGORY_TYPE.income)?.total).toBe(
			500_000
		);
		// Both lines are visible, and the month still nets to nothing.
		expect(figures.totalIncome).toBe(500_000);
		expect(figures.totalExpense).toBe(500_000);
		expect(figures.closingBalance).toBe(figures.openingBalance);
	});

	it('adds its lines up to the two headline totals, so the report cannot disagree with itself', async () => {
		const donations = await addCategory('Sumbangan jumlah', CASH_CATEGORY_TYPE.income);
		const hall = await addCategory('Sewa aula jumlah', CASH_CATEGORY_TYPE.income);
		const wages = await addCategory('Gaji satpam jumlah', CASH_CATEGORY_TYPE.expense);
		await record(donations, '2026-01-02', 120_000);
		await record(hall, '2026-01-12', 380_000);
		await record(wages, '2026-01-25', 1_100_000);

		const figures = await figuresFor(JANUARY);

		const sumOf = (type: CashCategoryType): number =>
			figures.categoryBreakdown
				.filter((line) => line.type === type)
				.reduce((total, line) => total + line.total, 0);
		expect(sumOf(CASH_CATEGORY_TYPE.income)).toBe(figures.totalIncome);
		expect(sumOf(CASH_CATEGORY_TYPE.expense)).toBe(figures.totalExpense);
	});
});

describe('the two different iuran figures', () => {
	it('puts a January Tagihan settled on 20 February in January collected and February cash in', async () => {
		// `docs/spec-kas-laporan-v1.md`'s own testing decision, verbatim: "tagihan Januari dilunasi 20
		// Februari, dan pengujian membuktikan … kas masuk muncul di Februari, dan kedua angka ringkasan
		// iuran benar."
		const unitId = await insertUnitRow();
		const residentId = await insertResidentRow(await insertUser(unique('Warga Telat')));
		const invoiceId = await issueInvoiceRow(unitId, JANUARY, 150_000);
		await settle(unitId, residentId, invoiceId, 150_000, '2026-02-20');
		await recordDuesCashIn('2026-02-20', 150_000);

		const january = await figuresFor(JANUARY);
		const february = await figuresFor(FEBRUARY);
		const dues = await duesCategoryId();

		// January's billing is settled in full, whenever the money came.
		expect(january.duesCollected).toBe(150_000);
		expect(january.duesUnitsPaid).toBe(1);
		expect(january.duesUnitsUnpaid).toBe(0);
		// But no cash reached the complex in January.
		expect(january.totalIncome).toBe(0);
		expect(lineFor(january.categoryBreakdown, dues, CASH_CATEGORY_TYPE.income)).toBeUndefined();

		// February is the mirror image: the cash is here, and February's own billing is untouched.
		expect(lineFor(february.categoryBreakdown, dues, CASH_CATEGORY_TYPE.income)?.total).toBe(
			150_000
		);
		expect(february.totalIncome).toBe(150_000);
		expect(february.duesCollected).toBe(0);
		expect(february.duesUnitsPaid).toBe(0);
		expect(february.duesUnitsUnpaid).toBe(0);
	});

	it('counts a house that has paid part of its Tagihan as belum lunas', async () => {
		const unitId = await insertUnitRow();
		const residentId = await insertResidentRow(await insertUser(unique('Warga Sebagian')));
		const invoiceId = await issueInvoiceRow(unitId, JANUARY, 150_000);
		await settle(unitId, residentId, invoiceId, 50_000, '2026-01-12');

		const figures = await figuresFor(JANUARY);

		expect(figures.duesCollected).toBe(50_000);
		expect(figures.duesUnitsPaid).toBe(0);
		expect(figures.duesUnitsUnpaid).toBe(1);
	});

	it('leaves a voided Tagihan out of every one of the three numbers', async () => {
		const paidUnit = await insertUnitRow();
		const voidedUnit = await insertUnitRow();
		const residentId = await insertResidentRow(await insertUser(unique('Warga Batal')));
		const paidInvoice = await issueInvoiceRow(paidUnit, JANUARY, 150_000);
		await settle(paidUnit, residentId, paidInvoice, 150_000, '2026-01-03');
		await issueInvoiceRow(voidedUnit, JANUARY, 150_000, residentId);

		const figures = await figuresFor(JANUARY);

		// A cancelled Tagihan is neither lunas nor belum lunas: nothing is owed on it at all.
		expect(figures.duesCollected).toBe(150_000);
		expect(figures.duesUnitsPaid).toBe(1);
		expect(figures.duesUnitsUnpaid).toBe(0);
	});

	it('counts every house of the Periode, paid and unpaid, and only that Periode', async () => {
		const first = await insertUnitRow();
		const second = await insertUnitRow();
		const third = await insertUnitRow();
		const residentId = await insertResidentRow(await insertUser(unique('Warga Hitung')));
		const paid = await issueInvoiceRow(first, JANUARY, 150_000);
		await settle(first, residentId, paid, 150_000, '2026-01-04');
		await issueInvoiceRow(second, JANUARY, 150_000);
		// February's Tagihan must not reach January's counts.
		await issueInvoiceRow(third, FEBRUARY, 150_000);

		const figures = await figuresFor(JANUARY);

		expect(figures.duesUnitsPaid).toBe(1);
		expect(figures.duesUnitsUnpaid).toBe(1);
	});
});

/**
 * This module reads `cash_transactions` itself rather than calling `cashBook`, and the reason is
 * recorded in `composition.ts`: `cashBook` is guarded by `ACTION.recordCashTransactions`, and
 * `tests/unit/cash-transaction.test.ts:148` pins that module's export list to exactly two names, so
 * neither loosening its guard nor adding an unguarded read beside it is available to this ticket.
 *
 * Duplicated arithmetic that nothing checks is how a report and a cash book start disagreeing, so
 * every piece of the duplication is compared to `cashBook`'s own answer here. These are the tests
 * that fail the day the two conventions drift apart.
 */
describe('the report and the buku kas, on the same rows', () => {
	it('opens a month on exactly the balance the cash book carries into it', async () => {
		// The sign convention, restated in `OPENING_BALANCE_TOTAL` and pinned here against
		// `SIGNED_TOTAL`. Money in and money out in both directions, before and inside the month.
		const donations = await addCategory('Sumbangan banding saldo', CASH_CATEGORY_TYPE.income);
		const repairs = await addCategory('Perbaikan banding saldo', CASH_CATEGORY_TYPE.expense);
		await record(donations, '2025-11-04', 2_400_000);
		await record(repairs, '2025-11-19', 900_000);
		await record(repairs, '2025-12-27', 150_000);
		await record(donations, '2026-01-07', 60_000);

		for (const month of [JANUARY, FEBRUARY, '2025-12']) {
			const figures = await figuresFor(month);
			const book = await cashBook(testDb.db, adminId, { month });

			expect(figures.openingBalance).toBe(book.openingBalance);
		}
	});

	it('spans February exactly as the cash book does, leap year rule or not', async () => {
		// The month boundary is half-open here and inclusive there; February is where a second
		// leap-year rule would show. 2026 is not a leap year and 2028 is, so both are checked.
		const donations = await addCategory('Sumbangan banding Februari', CASH_CATEGORY_TYPE.income);
		for (const day of ['2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01']) {
			await record(donations, day, 10_000);
		}
		for (const day of ['2028-01-31', '2028-02-01', '2028-02-29', '2028-03-01']) {
			await record(donations, day, 10_000);
		}

		for (const month of ['2026-02', '2028-02']) {
			const slice = await transactionsInCategory(testDb.db, month, donations);
			const book = await cashBook(testDb.db, adminId, { month, categoryId: donations });

			expect(slice.entries.map((entry) => entry.id)).toEqual(book.entries.map((entry) => entry.id));
			expect(slice.entries.map((entry) => entry.occurredOn)).toEqual(
				book.entries.map((entry) => entry.occurredOn)
			);
		}
	});

	it('returns the drill-down rows in the order the cash book lists them, corrections included', async () => {
		const repairs = await addCategory('Perbaikan banding urutan', CASH_CATEGORY_TYPE.expense);
		// Two rows on one day, which is what the `createdAt` tiebreak in the ordering exists for.
		await record(repairs, '2026-01-14', 300_000);
		await record(repairs, '2026-01-14', 120_000);
		await record(repairs, '2026-01-02', 75_000);
		const [first] = await testDb.db
			.select()
			.from(cashTransactions)
			.where(eq(cashTransactions.categoryId, repairs))
			.orderBy(cashTransactions.createdAt);
		clock.advance(STEP_MILLISECONDS);
		await recordCashCorrection(testDb.db, clock, {
			actorId: adminId,
			transactionId: first.id,
			reason: 'Nota itu keliru dicatat dua kali.'
		});

		const slice = await transactionsInCategory(testDb.db, JANUARY, repairs);
		const book = await cashBook(testDb.db, adminId, { month: JANUARY, categoryId: repairs });

		expect(slice.entries.map((entry) => entry.id)).toEqual(book.entries.map((entry) => entry.id));
		expect(slice.incomeTotal).toBe(300_000);
		expect(slice.expenseTotal).toBe(495_000);
		expect(slice.entries.filter((entry) => entry.isCorrection)).toHaveLength(1);
	});

	it('adds a category up to the very totals the report froze for it', async () => {
		const repairs = await addCategory('Perbaikan banding jumlah', CASH_CATEGORY_TYPE.expense);
		await record(repairs, '2026-01-09', 250_000);
		await record(repairs, '2026-01-23', 175_000);

		const figures = await figuresFor(JANUARY);
		const slice = await transactionsInCategory(testDb.db, JANUARY, repairs);

		expect(slice.expenseTotal).toBe(
			lineFor(figures.categoryBreakdown, repairs, CASH_CATEGORY_TYPE.expense)?.total
		);
	});

	it('carries no recorder, no receipt and no running balance on a drill-down row', async () => {
		// Every field `CashBookEntry` has that a Warga has no business seeing, plus the balance column
		// that would mean a third thing here.
		const repairs = await addCategory('Perbaikan banding bentuk', CASH_CATEGORY_TYPE.expense);
		await record(repairs, '2026-01-16', 40_000);

		const slice = await transactionsInCategory(testDb.db, JANUARY, repairs);

		expect(Object.keys(slice.entries[0]).sort()).toEqual([
			'amount',
			'description',
			'id',
			'isCorrection',
			'occurredOn',
			'type'
		]);
	});

	it('answers an empty month with no rows and two zeros, and refuses a month that is not one', async () => {
		const repairs = await addCategory('Perbaikan banding kosong', CASH_CATEGORY_TYPE.expense);

		expect(await transactionsInCategory(testDb.db, '2026-08', repairs)).toEqual({
			entries: [],
			incomeTotal: 0,
			expenseTotal: 0
		});
		await expect(transactionsInCategory(testDb.db, '2026-13', repairs)).rejects.toThrow(TypeError);
	});

	it('rolls December over into the next January rather than into month 13', async () => {
		const donations = await addCategory('Sumbangan Desember', CASH_CATEGORY_TYPE.income);
		await record(donations, '2026-12-31', 500_000);
		await record(donations, '2027-01-01', 700_000);

		const december = await transactionsInCategory(testDb.db, '2026-12', donations);

		expect(december.entries.map((entry) => entry.occurredOn)).toEqual(['2026-12-31']);
		expect(december.incomeTotal).toBe(500_000);
	});
});

describe('the month the complex is in', () => {
	it('is read in Asia/Jakarta, so the turn of the month is not seven hours late', async () => {
		// 31 December 2025 at 17:00 UTC is already 1 January 2026 in the complex. A default read in
		// UTC would offer an admin December as the periode berjalan at exactly the moment they are
		// most likely to publish — see the argument in `composition.ts`.
		expect(currentReportPeriod(new FakeClock('2025-12-31T17:00:00.000Z'))).toBe('2026-01');
		expect(currentReportPeriod(new FakeClock('2025-12-31T16:59:59.000Z'))).toBe('2025-12');
		expect(currentReportPeriod(new FakeClock('2026-06-15T03:00:00.000Z'))).toBe('2026-06');
	});
});
