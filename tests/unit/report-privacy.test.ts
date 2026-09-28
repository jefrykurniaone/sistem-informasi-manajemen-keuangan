import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
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
import { recordCashCorrection } from '$lib/server/services/cash/correction';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';
import { publishReport } from '$lib/server/services/report/publication';
import { reportForPeriod } from '$lib/server/services/report/resident-payload';

/**
 * "Pengujian berparameter membuktikan muatan laporan untuk peran `warga` tidak pernah memuat nama
 * warga lain atau pengenal unit" — this ticket's own acceptance criterion, and
 * `docs/spec-kas-laporan-v1.md`'s testing decision: "privasi diuji sebagai tabel kasus peran
 * terhadap muatan laporan".
 *
 * ## It checks the payload, never the HTML
 *
 * The sweep below serialises what `reportForPeriod` returns and asserts that no name, no house and
 * no identifier of a person appears anywhere in it. That is deliberately a test of the *object* and
 * not of a rendering: a rule that held only in one `.svelte` file would stop holding the moment
 * somebody wrote a second one, added a JSON endpoint, or put the same data in an email.
 *
 * ## Why a sweep over roles, when the payload has no role in it
 *
 * Because that is the claim. `reportForPeriod` takes a database and a request and nothing else —
 * there is exactly one payload, the same one for a warga, an admin and a superuser, so the privacy
 * property cannot be true for one role and false for another. The sweep states that for every role
 * and every kind of forbidden value, and the test at the end pins the shape it rests on: the day
 * somebody gives this function a viewer, the sweep stops being a repetition and starts being a real
 * case table, and it is already written.
 *
 * The complex below is deliberately full of things that *could* leak: two houses with memorable
 * blocks and numbers, two named residents, Tagihan in both states, verified Pembayaran with their
 * Alokasi, and a kas masuk row in the "Iuran warga" category.
 *
 * ## The categories the drill-down is opened on
 *
 * Four ordinary expense categories, each there for one rule of `drilldownFor`:
 *
 * - **street light**: one expense, and a Koreksi of it recorded *after* publication, so its income
 *   direction has live rows and no line, and its expense direction has not changed.
 * - **fence**: two expenses and a Koreksi of one of them, all before publication, so it has a line
 *   in each table, the way "Perbaikan" does in Data Contoh.
 * - **drain**: only a Koreksi in this month, of an expense dated the month before, so its own type
 *   has no line and the other one does.
 * - **garden**: one expense before publication and one after, so its opened direction has changed.
 * - **gazebo**: a line in each table like fence, plus a further Koreksi planted on the income line
 *   *after* publication — the case `otherDirection`'s `published` kind is tested against: its total
 *   must stay the frozen income line's figure and not follow the buku kas past it.
 */

const testDb = testDatabase();

const START = '2026-05-01T00:00:00.000Z';

/** The month this file publishes and then reads back. */
const PERIOD = '2026-05';

/** A name no category, description or message in this repository contains. */
const NEIGHBOUR_NAME = 'Siti Rahmawati Nurhaliza';

/** A second one, for the house that has not paid. */
const DEBTOR_NAME = 'Bambang Kusumawardana';

/** Two houses whose block and number are unmistakable in a serialised payload. */
const PAID_HOUSE = { block: 'QZ', number: '4071' };
const UNPAID_HOUSE = { block: 'QX', number: '9182' };

/**
 * Every identifier this file plants in the database, minted here rather than read back after the
 * rows are written.
 *
 * `it.each` builds its case table when the file is *collected*, before any `beforeAll` has run, so a
 * sweep over "the id of the house that has not paid" cannot wait for an insert to return one. Every
 * row below is therefore written with an id chosen up front, which costs nothing — the columns have
 * database defaults precisely so that a caller who has a reason to pick one may.
 */
const IDS = {
	adminUser: randomUUID(),
	superuser: randomUUID(),
	neighbourUser: randomUUID(),
	neighbourResident: randomUUID(),
	debtorUser: randomUUID(),
	debtorResident: randomUUID(),
	paidUnit: randomUUID(),
	unpaidUnit: randomUUID(),
	paidInvoice: randomUUID(),
	unpaidInvoice: randomUUID(),
	payment: randomUUID(),
	expenseCategory: randomUUID(),
	fenceCategory: randomUUID(),
	drainCategory: randomUUID(),
	drainExpense: randomUUID(),
	gardenCategory: randomUUID(),
	gazeboCategory: randomUUID()
} as const;

let clock: FakeClock;
let duesCategoryId: string;

/** The day after publication a superuser has reopened the month to record into, in `PERIOD`. */
const AFTER_PUBLICATION_DAY = `${PERIOD}-25`;

/** An ordinary expense Kategori Kas, written straight into the table for the reason `IDS` gives. */
async function insertExpenseCategory(id: string, name: string): Promise<void> {
	await testDb.db.insert(cashCategories).values({
		id,
		name,
		type: CASH_CATEGORY_TYPE.expense,
		createdAt: new Date(START)
	});
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role. */
async function insertUser(id: string, name: string, role?: Role): Promise<void> {
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	if (role) {
		await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: now });
	}
}

/** An account and the `residents` row that points at it. */
async function insertResident(userId: string, residentId: string, name: string): Promise<void> {
	await insertUser(userId, name);
	await testDb.db.insert(residents).values({ id: residentId, userId, createdAt: new Date(START) });
}

/** A house. */
async function insertUnitRow(id: string, house: { block: string; number: string }): Promise<void> {
	await testDb.db.insert(units).values({ id, ...house, createdAt: new Date(START) });
}

/** One Tagihan of `PERIOD` for one house. */
async function insertInvoiceRow(id: string, unitId: string): Promise<void> {
	await testDb.db.insert(invoices).values({
		id,
		unitId,
		period: PERIOD,
		amount: rupiah(150_000),
		dueDate: `${PERIOD}-05`,
		issuedAt: new Date(`${PERIOD}-01T00:00:00.000Z`)
	});
}

beforeAll(async () => {
	clock = new FakeClock(START);
	const fileStore = new FakeFileStore(clock);

	await insertUser(IDS.adminUser, 'Pengurus Penerbit Laporan', ROLE.admin);
	await insertUser(IDS.superuser, 'Pengurus Kategori Privasi', ROLE.superuser);
	await insertResident(IDS.neighbourUser, IDS.neighbourResident, NEIGHBOUR_NAME);
	await insertResident(IDS.debtorUser, IDS.debtorResident, DEBTOR_NAME);
	await insertUnitRow(IDS.paidUnit, PAID_HOUSE);
	await insertUnitRow(IDS.unpaidUnit, UNPAID_HOUSE);

	// One house that has paid its Tagihan in full, and one that has not — so the counts the report
	// publishes are 1 and 1 rather than the degenerate 0 and 0.
	await insertInvoiceRow(IDS.paidInvoice, IDS.paidUnit);
	await insertInvoiceRow(IDS.unpaidInvoice, IDS.unpaidUnit);

	await testDb.db.insert(payments).values({
		id: IDS.payment,
		unitId: IDS.paidUnit,
		recordedBy: IDS.neighbourResident,
		amount: rupiah(150_000),
		receivedOn: `${PERIOD}-03`,
		method: PAYMENT_METHOD.transfer,
		status: PAYMENT_STATUS.verified,
		verifiedBy: IDS.neighbourResident,
		verifiedAt: new Date(`${PERIOD}-03T00:00:00.000Z`),
		createdAt: new Date(`${PERIOD}-03T00:00:00.000Z`)
	});
	await testDb.db.insert(allocations).values({
		paymentId: IDS.payment,
		invoiceId: IDS.paidInvoice,
		amount: rupiah(150_000),
		createdAt: new Date(`${PERIOD}-03T00:00:00.000Z`)
	});

	const [dues] = await testDb.db
		.select({ id: cashCategories.id })
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	duesCategoryId = dues.id;
	// The kas masuk row payment verification writes. Inserted directly because the cash service
	// refuses a manual entry in this category by design — see `tests/unit/report-composition.test.ts`.
	await testDb.db.insert(cashTransactions).values({
		occurredOn: `${PERIOD}-03`,
		type: CASH_CATEGORY_TYPE.income,
		categoryId: duesCategoryId,
		amount: rupiah(150_000),
		description: 'Verifikasi pembayaran iuran',
		recordedBy: IDS.adminUser,
		createdAt: new Date(`${PERIOD}-03T00:00:00.000Z`)
	});

	// Written straight into the table rather than through `createCashCategory`, for the reason the
	// `IDS` comment gives: the sweep needs this id before any insert has run.
	await insertExpenseCategory(IDS.expenseCategory, 'Perbaikan lampu jalan komplek');
	const streetLight = await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-12`,
		categoryId: IDS.expenseCategory,
		amount: rupiah(325_000),
		description: 'Penggantian delapan lampu jalan'
	});

	// A line in each table: two expenses, and a Koreksi of the second, which moves money in.
	await insertExpenseCategory(IDS.fenceCategory, 'Perbaikan pagar komplek');
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-08`,
		categoryId: IDS.fenceCategory,
		amount: rupiah(400_000),
		description: 'Pengecatan ulang pagar depan'
	});
	const hinge = await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-15`,
		categoryId: IDS.fenceCategory,
		amount: rupiah(180_000),
		description: 'Perbaikan engsel gerbang belakang'
	});
	await recordCashCorrection(testDb.db, clock, {
		actorId: IDS.adminUser,
		transactionId: hinge.id,
		reason: 'Engsel ternyata masih bergaransi'
	});

	// A Koreksi in this month of an expense dated in the month before, so the category's own type has
	// no line here. `recordCashCorrection` dates a Koreksi on its original's day and would not write
	// this, so both rows are planted directly: the fallback has to hold for whatever lines a frozen
	// breakdown carries, not only for the ones today's services produce.
	await insertExpenseCategory(IDS.drainCategory, 'Kebersihan saluran air');
	await testDb.db.insert(cashTransactions).values({
		id: IDS.drainExpense,
		occurredOn: '2026-04-20',
		type: CASH_CATEGORY_TYPE.expense,
		categoryId: IDS.drainCategory,
		amount: rupiah(120_000),
		description: 'Pengurasan saluran air',
		recordedBy: IDS.adminUser,
		createdAt: new Date('2026-04-20T00:00:00.000Z')
	});
	await testDb.db.insert(cashTransactions).values({
		occurredOn: `${PERIOD}-06`,
		type: CASH_CATEGORY_TYPE.income,
		categoryId: IDS.drainCategory,
		amount: rupiah(120_000),
		description: 'Pengurasan dibayar pengembang',
		recordedBy: IDS.adminUser,
		correctionOf: IDS.drainExpense,
		createdAt: new Date(`${PERIOD}-06T00:00:00.000Z`)
	});

	await insertExpenseCategory(IDS.gardenCategory, 'Perawatan taman komplek');
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-10`,
		categoryId: IDS.gardenCategory,
		amount: rupiah(90_000),
		description: 'Pemangkasan pohon taman'
	});

	// A line in each table, like fence: two expenses and a Koreksi of the second. The Koreksi gets a
	// further, later change after publication (below), which `otherDirection`'s `published` kind must
	// not follow.
	await insertExpenseCategory(IDS.gazeboCategory, 'Perbaikan gazebo komplek');
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-09`,
		categoryId: IDS.gazeboCategory,
		amount: rupiah(200_000),
		description: 'Pengecatan atap gazebo'
	});
	const gazeboDoor = await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-11`,
		categoryId: IDS.gazeboCategory,
		amount: rupiah(150_000),
		description: 'Penggantian pintu gazebo'
	});
	await recordCashCorrection(testDb.db, clock, {
		actorId: IDS.adminUser,
		transactionId: gazeboDoor.id,
		reason: 'Pintu diganti pemasok tanpa biaya'
	});

	await publishReport(testDb.db, clock, { actorId: IDS.adminUser, period: PERIOD });

	// After publication, the month is locked, so these are planted directly: what a superuser who
	// reopened the month would have recorded into it. One Koreksi on the street light's other
	// direction, one more expense on the garden's own, and a further Koreksi on the gazebo's income
	// line, already published, moving past what this revision froze for it.
	await testDb.db.insert(cashTransactions).values({
		occurredOn: streetLight.occurredOn,
		type: CASH_CATEGORY_TYPE.income,
		categoryId: IDS.expenseCategory,
		amount: rupiah(325_000),
		description: 'Lampu dikembalikan ke toko',
		recordedBy: IDS.adminUser,
		correctionOf: streetLight.id,
		createdAt: new Date(`${AFTER_PUBLICATION_DAY}T00:00:00.000Z`)
	});
	await testDb.db.insert(cashTransactions).values({
		occurredOn: AFTER_PUBLICATION_DAY,
		type: CASH_CATEGORY_TYPE.expense,
		categoryId: IDS.gardenCategory,
		amount: rupiah(10_000),
		description: 'Pupuk susulan taman',
		recordedBy: IDS.adminUser,
		createdAt: new Date(`${AFTER_PUBLICATION_DAY}T00:00:00.000Z`)
	});
	await testDb.db.insert(cashTransactions).values({
		occurredOn: AFTER_PUBLICATION_DAY,
		type: CASH_CATEGORY_TYPE.income,
		categoryId: IDS.gazeboCategory,
		amount: rupiah(40_000),
		description: 'Sebagian cat gazebo dikembalikan',
		recordedBy: IDS.adminUser,
		correctionOf: gazeboDoor.id,
		createdAt: new Date(`${AFTER_PUBLICATION_DAY}T00:00:00.000Z`)
	});
});

/** Every role a viewer of a report could hold, including holding none beyond the default. */
const VIEWER_ROLES: readonly string[] = ['warga', 'admin', 'superuser', 'admin dan superuser'];

/** The kinds of value that must never appear in a report payload, whoever is reading it. */
function forbiddenValues(): readonly { readonly kind: string; readonly value: string }[] {
	return [
		{ kind: 'nama warga lain', value: NEIGHBOUR_NAME },
		{ kind: 'nama warga yang menunggak', value: DEBTOR_NAME },
		{ kind: 'blok rumah yang lunas', value: PAID_HOUSE.block },
		{ kind: 'nomor rumah yang lunas', value: PAID_HOUSE.number },
		{ kind: 'blok rumah yang belum lunas', value: UNPAID_HOUSE.block },
		{ kind: 'nomor rumah yang belum lunas', value: UNPAID_HOUSE.number },
		{ kind: 'pengenal unit', value: IDS.paidUnit },
		{ kind: 'pengenal unit kedua', value: IDS.unpaidUnit },
		{ kind: 'pengenal warga', value: IDS.neighbourResident },
		{ kind: 'pengenal warga yang menunggak', value: IDS.debtorResident },
		{ kind: 'pengenal akun warga', value: IDS.neighbourUser },
		{ kind: 'pengenal akun penerbit', value: IDS.adminUser },
		{ kind: 'pengenal tagihan yang lunas', value: IDS.paidInvoice },
		{ kind: 'pengenal tagihan yang belum lunas', value: IDS.unpaidInvoice },
		{ kind: 'pengenal pembayaran', value: IDS.payment }
	];
}

/** Everything the payload would have to be hiding, spread across every role that could read it. */
function privacyCases() {
	return VIEWER_ROLES.flatMap((role) =>
		forbiddenValues().map((forbidden) => ({ role, kind: forbidden.kind, value: forbidden.value }))
	);
}

describe('the report payload a warga receives', () => {
	it('publishes the iuran summary as three numbers, which is the whole tunggakan surface', async () => {
		const view = await reportForPeriod(testDb.db, { period: PERIOD });

		expect(view?.report.dues).toEqual({
			collected: 150_000,
			cashIn: 150_000,
			unitsPaid: 1,
			unitsUnpaid: 1
		});
	});

	it.each(privacyCases())('read by a $role, carries no $kind', async ({ value }) => {
		const view = await reportForPeriod(testDb.db, { period: PERIOD });

		expect(JSON.stringify(view)).not.toContain(value);
	});

	it.each(privacyCases())(
		'read by a $role with a category opened, still carries no $kind',
		async ({ value }) => {
			const view = await reportForPeriod(testDb.db, {
				period: PERIOD,
				categoryId: IDS.expenseCategory
			});

			expect(view?.drilldown).not.toBeNull();
			expect(JSON.stringify(view)).not.toContain(value);
		}
	);

	it('takes no viewer at all, which is why one payload can be right for every role', async () => {
		// The shape the sweep above rests on, asserted rather than assumed — the same way
		// `tests/unit/audit.test.ts` asserts the absence of an update path. `reportForPeriod(db,
		// request)` is two parameters and neither is a caller, so "the payload for a warga" and "the
		// payload for an admin" are not two objects that could drift apart; they are one object.
		expect(reportForPeriod).toHaveLength(2);
	});
});

/** The published figure on one category's line in one direction, as the report's own row prints it. */
function lineFigure(
	view: Awaited<ReturnType<typeof reportForPeriod>>,
	direction: CashCategoryType,
	categoryId: string
): number | undefined {
	return view?.report[direction].find((line) => line.categoryId === categoryId)?.total;
}

describe('drilling into a category', () => {
	it('opens the expense side of an expense category with only its expense rows', async () => {
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.fenceCategory,
			direction: CASH_CATEGORY_TYPE.expense
		});

		expect(view?.drilldown).toMatchObject({
			categoryId: IDS.fenceCategory,
			name: 'Perbaikan pagar komplek',
			direction: CASH_CATEGORY_TYPE.expense,
			isOwnDirection: true,
			frozenTotal: 580_000,
			liveTotal: 580_000,
			changedSincePublication: false,
			otherDirection: { kind: 'published', total: 180_000 }
		});
		expect(view?.drilldown?.frozenTotal).toBe(
			lineFigure(view, CASH_CATEGORY_TYPE.expense, IDS.fenceCategory)
		);
		// The Koreksi side's own frozen line, so a reader on the expense side is told about it without
		// the buku kas's live figure ever entering the sentence.
		expect(view?.drilldown?.otherDirection).toMatchObject({
			total: lineFigure(view, CASH_CATEGORY_TYPE.income, IDS.fenceCategory)
		});
		const entries = view?.drilldown?.entries ?? [];
		expect(entries.map((entry) => entry.type)).toEqual([
			CASH_CATEGORY_TYPE.expense,
			CASH_CATEGORY_TYPE.expense
		]);
		expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(580_000);
	});

	it('opens the income side of the same category with only its Koreksi', async () => {
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.fenceCategory,
			direction: CASH_CATEGORY_TYPE.income
		});

		expect(view?.drilldown).toMatchObject({
			categoryId: IDS.fenceCategory,
			direction: CASH_CATEGORY_TYPE.income,
			isOwnDirection: false,
			frozenTotal: 180_000,
			liveTotal: 180_000,
			changedSincePublication: false,
			otherDirection: { kind: 'published', total: 580_000 }
		});
		expect(view?.drilldown?.frozenTotal).toBe(
			lineFigure(view, CASH_CATEGORY_TYPE.income, IDS.fenceCategory)
		);
		// Opening the Koreksi side, the other direction is the category's own expense line.
		expect(view?.drilldown?.otherDirection).toMatchObject({
			total: lineFigure(view, CASH_CATEGORY_TYPE.expense, IDS.fenceCategory)
		});
		expect(view?.drilldown?.entries).toHaveLength(1);
		expect(view?.drilldown?.entries[0]).toMatchObject({
			type: CASH_CATEGORY_TYPE.income,
			occurredOn: `${PERIOD}-15`,
			description: 'Engsel ternyata masih bergaransi',
			amount: 180_000,
			isCorrection: true
		});
	});

	it("opens the category's own type when no direction is asked for", async () => {
		// An old link, or an address typed by hand, lands on the ordinary side and not on the Koreksi.
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.fenceCategory
		});

		expect(view?.drilldown).toMatchObject({
			direction: CASH_CATEGORY_TYPE.expense,
			isOwnDirection: true,
			frozenTotal: 580_000
		});
	});

	it('falls to the direction that has a line when its own type has none', async () => {
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.drainCategory
		});

		expect(view?.report.expense.some((line) => line.categoryId === IDS.drainCategory)).toBe(false);
		expect(view?.drilldown).toMatchObject({
			categoryId: IDS.drainCategory,
			direction: CASH_CATEGORY_TYPE.income,
			isOwnDirection: false,
			frozenTotal: 120_000,
			liveTotal: 120_000,
			changedSincePublication: false,
			// No line, and no live row either: drain has never had an expense in this month.
			otherDirection: { kind: 'none' }
		});
		expect(view?.drilldown?.entries).toHaveLength(1);
		expect(view?.drilldown?.entries[0]).toMatchObject({ isCorrection: true, amount: 120_000 });
	});

	it.each([
		{ case: 'its own type', categoryId: IDS.drainCategory, direction: CASH_CATEGORY_TYPE.expense },
		{
			case: 'rows recorded only after publication',
			categoryId: IDS.expenseCategory,
			direction: CASH_CATEGORY_TYPE.income
		}
	])(
		'answers nothing for a direction with no line on this revision, even with $case',
		async ({ categoryId, direction }) => {
			// The same answer as a category that is not on the report: telling the two apart would say
			// which categories exist, which the report did not publish.
			const view = await reportForPeriod(testDb.db, { period: PERIOD, categoryId, direction });

			expect(view?.drilldown).toBeNull();
		}
	);

	it('opens an ordinary category and shows the rows behind its line', async () => {
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.expenseCategory
		});

		expect(view?.drilldown).toMatchObject({
			categoryId: IDS.expenseCategory,
			name: 'Perbaikan lampu jalan komplek',
			direction: CASH_CATEGORY_TYPE.expense,
			isOwnDirection: true,
			frozenTotal: 325_000
		});
		expect(view?.drilldown?.entries).toHaveLength(1);
		expect(view?.drilldown?.entries[0]).toMatchObject({
			occurredOn: `${PERIOD}-12`,
			amount: 325_000,
			isCorrection: false
		});
	});

	it('counts only the opened direction as changed since publication', async () => {
		// The street light's Koreksi was recorded after publication on its *income* side; the expense
		// line it is opened on has not moved, so nothing on that line needs explaining.
		const unchanged = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.expenseCategory,
			direction: CASH_CATEGORY_TYPE.expense
		});
		expect(unchanged?.drilldown).toMatchObject({
			frozenTotal: 325_000,
			liveTotal: 325_000,
			changedSincePublication: false,
			// No income line was ever published for the street light, but its Koreksi planted after
			// publication means the buku kas records one now.
			otherDirection: { kind: 'sinceRevision', total: 325_000 }
		});

		// The garden's extra expense was recorded on the direction it is opened on.
		const changed = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.gardenCategory,
			direction: CASH_CATEGORY_TYPE.expense
		});
		expect(changed?.drilldown).toMatchObject({
			frozenTotal: 90_000,
			liveTotal: 100_000,
			changedSincePublication: true,
			// The garden has never had an income row, published or live.
			otherDirection: { kind: 'none' }
		});
		expect(changed?.drilldown?.entries).toHaveLength(2);
	});

	it("keeps otherDirection's published total frozen even when the buku kas moves past it", async () => {
		// The gazebo's income line published 150_000; a further Koreksi planted after publication
		// (above) moved the live figure on, but the sentence built from `otherDirection` points at the
		// row printed in the other table, which is the published one.
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.gazeboCategory,
			direction: CASH_CATEGORY_TYPE.expense
		});

		expect(view?.drilldown).toMatchObject({
			categoryId: IDS.gazeboCategory,
			direction: CASH_CATEGORY_TYPE.expense,
			isOwnDirection: true,
			frozenTotal: 350_000,
			otherDirection: { kind: 'published', total: 150_000 }
		});
		expect(view?.drilldown?.otherDirection).toMatchObject({
			total: lineFigure(view, CASH_CATEGORY_TYPE.income, IDS.gazeboCategory)
		});
	});

	it.each([CASH_CATEGORY_TYPE.expense, CASH_CATEGORY_TYPE.income])(
		'carries no recorder and no receipt on a drilled-into %s row',
		async (direction) => {
			// `CashBookEntry` has both; the shape a warga is handed deliberately does not. A nota is a
			// photograph of a piece of paper, and who typed a row is an account.
			const view = await reportForPeriod(testDb.db, {
				period: PERIOD,
				categoryId: IDS.fenceCategory,
				direction
			});

			const entry = view?.drilldown?.entries[0] ?? {};
			expect(Object.keys(entry).sort()).toEqual([
				'amount',
				'description',
				'id',
				'isCorrection',
				'occurredOn',
				'type'
			]);
		}
	);

	it.each([
		{ asked: 'no direction', direction: undefined },
		{ asked: 'income', direction: CASH_CATEGORY_TYPE.income },
		{ asked: 'expense', direction: CASH_CATEGORY_TYPE.expense }
	])(
		'refuses to open the iuran category when asked for $asked, and says so on the line itself',
		async ({ direction }) => {
			// One row of "Iuran warga" is one house's payment on one day, so the list of them read
			// against the count of houses that have not paid is the daftar penunggak arrived at by
			// subtraction — the screen `docs/spec-kas-laporan-v1.md` puts behind admin alone.
			const view = await reportForPeriod(testDb.db, {
				period: PERIOD,
				categoryId: duesCategoryId,
				direction
			});

			expect(view?.drilldown).toBeNull();
			const duesLine = view?.report.income.find((line) => line.categoryId === duesCategoryId);
			expect(duesLine).toMatchObject({ total: 150_000, mayDrillDown: false });
		}
	);

	it('offers every other line, so a big number can still be checked', async () => {
		const view = await reportForPeriod(testDb.db, { period: PERIOD });

		expect(view?.report.expense.every((line) => line.mayDrillDown)).toBe(true);
	});

	it('answers nothing for a category that is not on this report', async () => {
		// Which keeps a report page from becoming a reader of the whole buku kas that needs no
		// permission, and never distinguishes "not on this report" from "not allowed".
		const view = await reportForPeriod(testDb.db, { period: PERIOD, categoryId: randomUUID() });

		expect(view?.drilldown).toBeNull();
	});
});

describe('reading a report that does not exist', () => {
	it('answers nothing for a month nobody has published', async () => {
		expect(await reportForPeriod(testDb.db, { period: '2026-09' })).toBeUndefined();
	});

	it('answers nothing for a revision nobody has published', async () => {
		expect(await reportForPeriod(testDb.db, { period: PERIOD, revision: 7 })).toBeUndefined();
	});
});
