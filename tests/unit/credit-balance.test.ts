import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { invoices } from '$lib/server/db/schema/invoice';
import {
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	type PaymentStatus
} from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import {
	creditBalanceOfUnit,
	lockUnallocatedVerifiedPayments
} from '$lib/server/services/dues/credit-balance';

/**
 * Saldo Titipan: a number computed from `payments` and `allocations`, never stored — so every test
 * here arranges rows and asks, and there is no column anywhere that could have been asserted on
 * instead. Against a real PostgreSQL, because the computation is two SQL aggregates.
 */

const testDb = testDatabase();

/** The instant every row in this file is stamped with. */
const START = '2026-02-10T00:00:00.000Z';

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** One house. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'CB', number: String(sequence), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One resident, with the bare account behind them. */
async function insertResident(name: string): Promise<string> {
	const userId = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id: userId,
		name,
		email: `${userId}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	const [row] = await testDb.db.insert(residents).values({ userId, createdAt: now }).returning();
	return row.id;
}

/** A Pembayaran in any status, written straight into the table. */
async function insertPayment(
	unitId: string,
	residentId: string,
	amount: Rupiah,
	status: PaymentStatus,
	receivedOn: string = '2026-02-01'
): Promise<string> {
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy: residentId,
			amount,
			receivedOn,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: null,
			status,
			rejectionReason: status === PAYMENT_STATUS.rejected ? 'Bukti tidak terbaca.' : null,
			verifiedBy: status === PAYMENT_STATUS.verified ? residentId : null,
			verifiedAt: status === PAYMENT_STATUS.verified ? new Date(START) : null,
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** A Tagihan plus an allocation of `amount` from `paymentId` to it, in one move. */
async function allocate(
	unitId: string,
	paymentId: string,
	amount: Rupiah,
	period: string
): Promise<void> {
	const [invoice] = await testDb.db
		.insert(invoices)
		.values({
			unitId,
			period,
			amount: rupiah(100_000),
			dueDate: `${period}-05`,
			issuedAt: new Date(START)
		})
		.returning();
	await testDb.db
		.insert(allocations)
		.values({ paymentId, invoiceId: invoice.id, amount, createdAt: new Date(START) });
}

describe('creditBalanceOfUnit', () => {
	it('is zero for a unit with no payments at all', async () => {
		const unitId = await insertUnit();

		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);
	});

	it('is the verified sum less the allocated sum — the prepayment case verbatim', async () => {
		// The spec's own worked example: Rp300.000 verified against one Rp100.000 Tagihan leaves
		// Rp200.000 as the house's saldo titipan.
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Titipan Dua Ratus');
		const paymentId = await insertPayment(unitId, residentId, rupiah(300_000), 'verified');
		await allocate(unitId, paymentId, rupiah(100_000), '2026-01');

		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(200_000);
	});

	it.each([PAYMENT_STATUS.pending, PAYMENT_STATUS.rejected] as const)(
		'counts no %s payment: unconfirmed or refused money lifts no balance',
		async (status) => {
			const unitId = await insertUnit();
			const residentId = await insertResident(`Warga Titipan ${status}`);
			await insertPayment(unitId, residentId, rupiah(500_000), status);

			expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);
		}
	);

	it('keeps each unit its own balance — milik Unit, bukan milik orang', async () => {
		const firstUnit = await insertUnit();
		const secondUnit = await insertUnit();
		// One person paying for two houses: the balances stay with the houses.
		const residentId = await insertResident('Warga Dua Rumah');
		await insertPayment(firstUnit, residentId, rupiah(50_000), 'verified');
		await insertPayment(secondUnit, residentId, rupiah(75_000), 'verified');

		expect(await creditBalanceOfUnit(testDb.db, firstUnit)).toBe(50_000);
		expect(await creditBalanceOfUnit(testDb.db, secondUnit)).toBe(75_000);
	});

	it('reads zero once every rupiah of every payment is allocated', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Titipan Habis');
		const paymentId = await insertPayment(unitId, residentId, rupiah(200_000), 'verified');
		await allocate(unitId, paymentId, rupiah(100_000), '2026-01');
		await allocate(unitId, paymentId, rupiah(100_000), '2026-02');

		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);
	});
});

describe('lockUnallocatedVerifiedPayments', () => {
	it('answers the verified payments oldest money first, each with its remainder', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Sisa Berurutan');
		const newer = await insertPayment(
			unitId,
			residentId,
			rupiah(100_000),
			'verified',
			'2026-02-05'
		);
		const older = await insertPayment(
			unitId,
			residentId,
			rupiah(100_000),
			'verified',
			'2026-01-03'
		);
		await insertPayment(unitId, residentId, rupiah(999_000), 'pending');
		await allocate(unitId, older, rupiah(60_000), '2026-01');

		const remainders = await testDb.db.transaction(async (transaction) =>
			lockUnallocatedVerifiedPayments(transaction, unitId)
		);

		expect(
			remainders.map((row) => ({ paymentId: row.paymentId, remainder: row.remainder }))
		).toEqual([
			{ paymentId: older, remainder: 40_000 },
			{ paymentId: newer, remainder: 100_000 }
		]);
	});

	it('keeps a fully spent payment on the list with a remainder of zero', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Sisa Nol');
		const paymentId = await insertPayment(unitId, residentId, rupiah(100_000), 'verified');
		await allocate(unitId, paymentId, rupiah(100_000), '2026-01');

		const remainders = await testDb.db.transaction(async (transaction) =>
			lockUnallocatedVerifiedPayments(transaction, unitId)
		);

		expect(remainders).toEqual([
			expect.objectContaining({ paymentId, amount: 100_000, remainder: 0 })
		]);
	});

	it('answers an empty list for a unit with nothing verified', async () => {
		const unitId = await insertUnit();

		const remainders = await testDb.db.transaction(async (transaction) =>
			lockUnallocatedVerifiedPayments(transaction, unitId)
		);

		expect(remainders).toEqual([]);
	});
});
