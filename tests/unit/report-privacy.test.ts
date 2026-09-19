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
	cashCategories
} from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { invoices } from '$lib/server/db/schema/invoice';
import { payments, PAYMENT_METHOD, PAYMENT_STATUS } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
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
	expenseCategory: randomUUID()
} as const;

let clock: FakeClock;
let duesCategoryId: string;

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
	await testDb.db.insert(cashCategories).values({
		id: IDS.expenseCategory,
		name: 'Perbaikan lampu jalan komplek',
		type: CASH_CATEGORY_TYPE.expense,
		createdAt: new Date(START)
	});
	await recordCashTransaction(testDb.db, clock, fileStore, {
		actorId: IDS.adminUser,
		occurredOn: `${PERIOD}-12`,
		categoryId: IDS.expenseCategory,
		amount: rupiah(325_000),
		description: 'Penggantian delapan lampu jalan'
	});

	await publishReport(testDb.db, clock, { actorId: IDS.adminUser, period: PERIOD });
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

describe('drilling into a category', () => {
	it('opens an ordinary category and shows the rows behind its line', async () => {
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.expenseCategory
		});

		expect(view?.drilldown).toMatchObject({
			categoryId: IDS.expenseCategory,
			name: 'Perbaikan lampu jalan komplek',
			frozenExpenseTotal: 325_000,
			liveExpenseTotal: 325_000,
			changedSincePublication: false
		});
		expect(view?.drilldown?.entries).toHaveLength(1);
		expect(view?.drilldown?.entries[0]).toMatchObject({
			occurredOn: `${PERIOD}-12`,
			amount: 325_000,
			isCorrection: false
		});
	});

	it('carries no recorder and no receipt on a drilled-into row', async () => {
		// `CashBookEntry` has both; the shape a warga is handed deliberately does not. A nota is a
		// photograph of a piece of paper, and who typed a row is an account.
		const view = await reportForPeriod(testDb.db, {
			period: PERIOD,
			categoryId: IDS.expenseCategory
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
	});

	it('refuses to open the iuran category, and says so on the line itself', async () => {
		// One row of "Iuran warga" is one house's payment on one day, so the list of them read against
		// the count of houses that have not paid is the daftar penunggak arrived at by subtraction —
		// the screen `docs/spec-kas-laporan-v1.md` puts behind admin alone.
		const view = await reportForPeriod(testDb.db, { period: PERIOD, categoryId: duesCategoryId });

		expect(view?.drilldown).toBeNull();
		const duesLine = view?.report.income.find((line) => line.categoryId === duesCategoryId);
		expect(duesLine).toMatchObject({ total: 150_000, mayDrillDown: false });
	});

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
