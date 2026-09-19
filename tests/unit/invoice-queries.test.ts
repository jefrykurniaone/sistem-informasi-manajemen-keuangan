import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { allocations } from '$lib/server/db/schema/allocation';
import { invoices } from '$lib/server/db/schema/invoice';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { payments, PAYMENT_METHOD, PAYMENT_STATUS } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	INVOICE_STATUS,
	invoiceHistoryForUnit,
	invoiceStatus,
	invoicesForUser,
	listOverdueUnits,
	UnitNotFoundError
} from '$lib/server/services/dues/queries';
import { PermissionDeniedError } from '$lib/errors';

/**
 * `invoiceStatus`'s comparison table, a warga's own list filtered by Masa Huni, admin's daftar
 * penunggak, and admin's per-unit history — `docs/spec-iuran-v1.md`'s "saya masih harus bayar
 * berapa" and "siapa saja yang menunggak".
 *
 * `tests/unit/overdue-privacy.test.ts` is the other half: the direct proof that a `resident` cannot
 * reach `listOverdueUnits` or `invoiceHistoryForUnit` at the service layer.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/**
 * `listOverdueUnits` scans every Tagihan in the schema, with no unit filter — that is the whole
 * point of a daftar penunggak. So, unlike `invoicesForUser`'s tests, which are naturally isolated
 * per resident, a Tagihan left behind by an earlier test in this file would leak into a later one's
 * count. Cleared in dependency order: an Alokasi points at a Pembayaran and a Tagihan, so it goes
 * first.
 */
beforeEach(async () => {
	await testDb.db.delete(allocations);
	await testDb.db.delete(payments);
	await testDb.db.delete(invoices);
});

/** Makes every block this file writes different from every other one. */
let sequence = 0;
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

/** An account together with the `residents` row that points at it. */
async function insertResident(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = await insertUser(name);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return { userId, residentId: row.id };
}

/**
 * An account holding `admin`, with the `residents` row a `voidedBy` column needs — `userId` acts as
 * `actorId`, `residentId` is who a cancellation is attributed to.
 */
async function insertAdmin(name: string): Promise<{ userId: string; residentId: string }> {
	const { userId, residentId } = await insertResident(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.admin, createdAt: new Date(START) });
	return { userId, residentId };
}

/** An account holding `superuser` but not `admin`, for the "not just any pengurus role" case. */
async function insertSuperuser(name: string): Promise<string> {
	const userId = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.superuser, createdAt: new Date(START) });
	return userId;
}

/** A house. */
async function insertUnitRow(): Promise<{ id: string; block: string; number: string }> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '1', createdAt: new Date(START) })
		.returning();
	return row;
}

/** One stay, written directly. */
async function insertOccupancyRow(
	unitId: string,
	residentId: string,
	startedOn: string,
	endedOn: string | null
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn,
		endedOn,
		createdAt: new Date(START)
	});
}

/** One Tagihan, written directly — this file tests reading, not `issueInvoice`. */
async function insertInvoiceRow(
	unitId: string,
	overrides: Partial<{
		period: string;
		amount: Rupiah;
		dueDate: string;
		issuedAt: Date;
		voidedAt: Date | null;
		voidReason: string | null;
		voidedBy: string | null;
	}> = {}
): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({
			unitId,
			period: overrides.period ?? '2026-03',
			amount: overrides.amount ?? rupiah(150_000),
			dueDate: overrides.dueDate ?? '2026-03-05',
			issuedAt: overrides.issuedAt ?? new Date('2026-03-01T00:00:00.000Z'),
			voidedAt: overrides.voidedAt ?? null,
			voidReason: overrides.voidReason ?? null,
			voidedBy: overrides.voidedBy ?? null
		})
		.returning();
	return row.id;
}

/** A verified Pembayaran, written directly, so an Alokasi has something to point at. */
async function insertPaymentRow(
	unitId: string,
	recordedBy: string,
	amount: Rupiah
): Promise<string> {
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy,
			amount,
			receivedOn: '2026-03-02',
			method: PAYMENT_METHOD.transfer,
			status: PAYMENT_STATUS.verified,
			verifiedBy: recordedBy,
			verifiedAt: new Date('2026-03-02T00:00:00.000Z'),
			createdAt: new Date('2026-03-02T00:00:00.000Z')
		})
		.returning();
	return row.id;
}

/** An Alokasi of `amount` from `paymentId` to `invoiceId`. */
async function allocate(paymentId: string, invoiceId: string, amount: Rupiah): Promise<void> {
	await testDb.db
		.insert(allocations)
		.values({ paymentId, invoiceId, amount, createdAt: new Date('2026-03-02T00:00:00.000Z') });
}

describe('invoiceStatus', () => {
	const AMOUNT = rupiah(150_000);
	const DUE_DATE = '2026-03-05';
	const BEFORE_DUE = '2026-03-04';
	const AFTER_DUE = '2026-03-06';

	it('is paid once the allocated amount reaches the invoice amount', () => {
		expect(
			invoiceStatus(
				{ amount: AMOUNT, allocatedAmount: AMOUNT, dueDate: DUE_DATE, voidedAt: null },
				AFTER_DUE
			)
		).toBe(INVOICE_STATUS.paid);
	});

	it('is unpaid before the due date with nothing allocated', () => {
		expect(
			invoiceStatus(
				{ amount: AMOUNT, allocatedAmount: rupiah(0), dueDate: DUE_DATE, voidedAt: null },
				BEFORE_DUE
			)
		).toBe(INVOICE_STATUS.unpaid);
	});

	it('is partial before the due date with something, but not everything, allocated', () => {
		expect(
			invoiceStatus(
				{ amount: AMOUNT, allocatedAmount: rupiah(50_000), dueDate: DUE_DATE, voidedAt: null },
				BEFORE_DUE
			)
		).toBe(INVOICE_STATUS.partial);
	});

	it('is not yet overdue on the due date itself — "lewat" means the date has passed', () => {
		expect(
			invoiceStatus(
				{ amount: AMOUNT, allocatedAmount: rupiah(0), dueDate: DUE_DATE, voidedAt: null },
				DUE_DATE
			)
		).toBe(INVOICE_STATUS.unpaid);
	});

	it('is overdue, not partial, once an unpaid balance is also past due', () => {
		expect(
			invoiceStatus(
				{ amount: AMOUNT, allocatedAmount: rupiah(50_000), dueDate: DUE_DATE, voidedAt: null },
				AFTER_DUE
			)
		).toBe(INVOICE_STATUS.overdue);
	});

	it('is overdue with nothing allocated at all, once past due', () => {
		expect(
			invoiceStatus(
				{ amount: AMOUNT, allocatedAmount: rupiah(0), dueDate: DUE_DATE, voidedAt: null },
				AFTER_DUE
			)
		).toBe(INVOICE_STATUS.overdue);
	});

	it('is void whatever the amounts say, once cancelled', () => {
		expect(
			invoiceStatus(
				{
					amount: AMOUNT,
					allocatedAmount: rupiah(0),
					dueDate: DUE_DATE,
					voidedAt: new Date(START)
				},
				AFTER_DUE
			)
		).toBe(INVOICE_STATUS.void);
	});
});

describe('invoicesForUser', () => {
	it('is empty for a signed-in account with no residents row at all', async () => {
		const userId = await insertUser('Warga Baru');

		expect(await invoicesForUser(testDb.db, new FakeClock(START), userId)).toEqual({
			invoices: [],
			totalOverdue: rupiah(0)
		});
	});

	it('is empty for a resident who has never occupied a house', async () => {
		const { userId } = await insertResident('Warga Tanpa Rumah');

		expect(await invoicesForUser(testDb.db, new FakeClock(START), userId)).toEqual({
			invoices: [],
			totalOverdue: rupiah(0)
		});
	});

	it('leaves out a voided Tagihan entirely', async () => {
		const { userId, residentId } = await insertResident('Warga Dibatalkan');
		const unit = await insertUnitRow();
		await insertOccupancyRow(unit.id, residentId, '2026-01-01', null);
		const admin = await insertAdmin('Admin Pembatal');
		await insertInvoiceRow(unit.id, {
			voidedAt: new Date('2026-03-10T00:00:00.000Z'),
			voidReason: 'Salah terbit',
			voidedBy: admin.residentId
		});

		const view = await invoicesForUser(
			testDb.db,
			new FakeClock('2026-06-01T00:00:00.000Z'),
			userId
		);

		expect(view.invoices).toEqual([]);
	});

	it('sums remaining balances of overdue invoices into one total tunggakan', async () => {
		const { userId, residentId } = await insertResident('Warga Menunggak');
		const unit = await insertUnitRow();
		await insertOccupancyRow(unit.id, residentId, '2026-01-01', null);
		await insertInvoiceRow(unit.id, {
			period: '2026-01',
			amount: rupiah(150_000),
			dueDate: '2026-01-05',
			issuedAt: new Date('2026-01-01T00:00:00.000Z')
		});
		const partiallyPaid = await insertInvoiceRow(unit.id, {
			period: '2026-02',
			amount: rupiah(150_000),
			dueDate: '2026-02-05',
			issuedAt: new Date('2026-02-01T00:00:00.000Z')
		});
		const payment = await insertPaymentRow(unit.id, residentId, rupiah(50_000));
		await allocate(payment, partiallyPaid, rupiah(50_000));
		// Not yet due at the read clock below — must not count towards the total.
		await insertInvoiceRow(unit.id, {
			period: '2026-06',
			amount: rupiah(150_000),
			dueDate: '2026-06-05',
			issuedAt: new Date('2026-06-01T00:00:00.000Z')
		});

		const view = await invoicesForUser(
			testDb.db,
			new FakeClock('2026-03-01T00:00:00.000Z'),
			userId
		);

		expect(view.invoices).toHaveLength(3);
		expect(view.invoices.find((row) => row.period === '2026-01')?.status).toBe(
			INVOICE_STATUS.overdue
		);
		expect(view.invoices.find((row) => row.period === '2026-02')?.status).toBe(
			INVOICE_STATUS.overdue
		);
		expect(view.invoices.find((row) => row.period === '2026-06')?.status).toBe(
			INVOICE_STATUS.unpaid
		);
		expect(view.totalOverdue).toBe(rupiah(150_000 + (150_000 - 50_000)));
	});

	describe('a tenant turnover', () => {
		/** The old occupant's stay, and the Tagihan issued each side of it moving out. */
		async function turnover() {
			const unit = await insertUnitRow();
			const leaving = await insertResident('Warga Lama');
			const arriving = await insertResident('Warga Baru');
			await insertOccupancyRow(unit.id, leaving.residentId, '2026-01-01', '2026-03-31');
			await insertOccupancyRow(unit.id, arriving.residentId, '2026-04-01', null);

			const beforeMove = await insertInvoiceRow(unit.id, {
				period: '2026-02',
				dueDate: '2026-02-05',
				issuedAt: new Date('2026-02-01T00:00:00.000Z')
			});
			const afterMove = await insertInvoiceRow(unit.id, {
				period: '2026-05',
				dueDate: '2026-05-05',
				issuedAt: new Date('2026-05-01T00:00:00.000Z')
			});

			return { unit, leaving, arriving, beforeMove, afterMove };
		}

		it('hides the previous occupant’s months from the resident who moved in later', async () => {
			const { arriving, afterMove } = await turnover();

			const view = await invoicesForUser(
				testDb.db,
				new FakeClock('2026-06-01T00:00:00.000Z'),
				arriving.userId
			);

			expect(view.invoices.map((row) => row.invoiceId)).toEqual([afterMove]);
		});

		it('leaves the old occupant their own months and nothing issued after they left', async () => {
			const { leaving, beforeMove } = await turnover();

			const view = await invoicesForUser(
				testDb.db,
				new FakeClock('2026-06-01T00:00:00.000Z'),
				leaving.userId
			);

			expect(view.invoices.map((row) => row.invoiceId)).toEqual([beforeMove]);
		});
	});
});

describe('listOverdueUnits', () => {
	it('refuses a caller who does not hold ACTION.readOverdue', async () => {
		const { userId } = await insertResident('Warga Iseng');

		await expect(listOverdueUnits(testDb.db, new FakeClock(START), userId)).rejects.toBeInstanceOf(
			PermissionDeniedError
		);
	});

	it('lists only houses still owed money past their due date, largest total first', async () => {
		const admin = await insertAdmin('Admin Penagih');
		const smallDebt = await insertUnitRow();
		const bigDebt = await insertUnitRow();
		const paidUp = await insertUnitRow();
		const notYetDue = await insertUnitRow();

		await insertInvoiceRow(smallDebt.id, { dueDate: '2026-02-05', amount: rupiah(100_000) });
		await insertInvoiceRow(bigDebt.id, { dueDate: '2026-02-05', amount: rupiah(150_000) });
		await insertInvoiceRow(bigDebt.id, {
			period: '2026-01',
			dueDate: '2026-01-05',
			amount: rupiah(150_000)
		});
		const paidInvoice = await insertInvoiceRow(paidUp.id, {
			dueDate: '2026-02-05',
			amount: rupiah(100_000)
		});
		const { residentId } = await insertResident('Warga Lunas');
		const payment = await insertPaymentRow(paidUp.id, residentId, rupiah(100_000));
		await allocate(payment, paidInvoice, rupiah(100_000));
		await insertInvoiceRow(notYetDue.id, { period: '2026-06', dueDate: '2026-06-05' });

		const overdue = await listOverdueUnits(
			testDb.db,
			new FakeClock('2026-03-01T00:00:00.000Z'),
			admin.userId
		);

		expect(overdue.map((row) => row.unitId)).toEqual([bigDebt.id, smallDebt.id]);
		expect(overdue[0]).toMatchObject({ overdueInvoiceCount: 2, totalOverdue: rupiah(300_000) });
		expect(overdue[1]).toMatchObject({ overdueInvoiceCount: 1, totalOverdue: rupiah(100_000) });
	});

	it('reads "sudah lewat jatuh tempo" in the complex\'s own zone, not in UTC', async () => {
		// 2026-03-05T20:00:00Z is already 03:00 on 6 March in Jakarta (UTC+7) — genuinely past a
		// 5 March due date locally, even though the UTC calendar day is still the 5th.
		const admin = await insertAdmin('Admin Zona Waktu');
		const unit = await insertUnitRow();
		await insertInvoiceRow(unit.id, { dueDate: '2026-03-05' });

		const stillOnTime = await listOverdueUnits(
			testDb.db,
			new FakeClock('2026-03-05T10:00:00.000Z'),
			admin.userId
		);
		const overdueLocally = await listOverdueUnits(
			testDb.db,
			new FakeClock('2026-03-05T20:00:00.000Z'),
			admin.userId
		);

		expect(stillOnTime).toEqual([]);
		expect(overdueLocally.map((row) => row.unitId)).toEqual([unit.id]);
	});
});

describe('invoiceHistoryForUnit', () => {
	it('refuses a caller who does not hold ACTION.readOverdue', async () => {
		const { userId } = await insertResident('Warga Ingin Tahu');
		const unit = await insertUnitRow();

		await expect(
			invoiceHistoryForUnit(testDb.db, new FakeClock(START), userId, unit.id)
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it('throws UnitNotFoundError for an id naming no house', async () => {
		const admin = await insertAdmin('Admin Salah Alamat');

		await expect(
			invoiceHistoryForUnit(testDb.db, new FakeClock(START), admin.userId, randomUUID())
		).rejects.toBeInstanceOf(UnitNotFoundError);
	});

	it('shows the whole history of a house, including Tagihan from before the current occupant', async () => {
		const admin = await insertAdmin('Admin Riwayat');
		const unit = await insertUnitRow();
		const oldOccupant = await insertResident('Penghuni Lama');
		const newOccupant = await insertResident('Penghuni Baru');
		await insertOccupancyRow(unit.id, oldOccupant.residentId, '2026-01-01', '2026-03-31');
		await insertOccupancyRow(unit.id, newOccupant.residentId, '2026-04-01', null);
		const old = await insertInvoiceRow(unit.id, { period: '2026-02', dueDate: '2026-02-05' });
		const recent = await insertInvoiceRow(unit.id, { period: '2026-05', dueDate: '2026-05-05' });

		const history = await invoiceHistoryForUnit(
			testDb.db,
			new FakeClock('2026-06-01T00:00:00.000Z'),
			admin.userId,
			unit.id
		);

		expect(history).toMatchObject({ unitId: unit.id, block: unit.block, number: unit.number });
		expect(history.invoices.map((row) => row.invoiceId)).toEqual([recent, old]);
	});

	it('includes a voided Tagihan, with its reason and INVOICE_STATUS.void', async () => {
		const admin = await insertAdmin('Admin Pembatal Riwayat');
		const unit = await insertUnitRow();
		await insertInvoiceRow(unit.id, {
			voidedAt: new Date('2026-03-10T00:00:00.000Z'),
			voidReason: 'Salah terbit',
			voidedBy: admin.residentId
		});

		const history = await invoiceHistoryForUnit(
			testDb.db,
			new FakeClock('2026-06-01T00:00:00.000Z'),
			admin.userId,
			unit.id
		);

		expect(history.invoices).toHaveLength(1);
		expect(history.invoices[0]).toMatchObject({
			status: INVOICE_STATUS.void,
			voidReason: 'Salah terbit'
		});
	});

	it('refuses a superuser who is not also an admin, the same as the daftar penunggak does', async () => {
		const superuser = await insertSuperuser('Superuser Bukan Admin');
		const unit = await insertUnitRow();

		await expect(
			invoiceHistoryForUnit(testDb.db, new FakeClock(START), superuser, unit.id)
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});
});
