import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { invoices } from '$lib/server/db/schema/invoice';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	applyCreditToInvoice,
	openInvoicesOfUnit,
	planAllocations,
	type AllocationTarget
} from '$lib/server/services/dues/allocation';

/**
 * Alokasi: the pure arithmetic that decides how money lands on Tagihan, and the two database reads
 * and writes around it. The two money invariants — a payment never over-spent, an invoice never
 * over-allocated — are arithmetic facts of `planAllocations` plus lock facts of its callers;
 * this file proves the arithmetic exhaustively and the reads and writes against real rows, while
 * `tests/unit/payment-verification.test.ts` and `tests/unit/invoice-issuance.test.ts` prove the
 * callers.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-02-10T00:00:00.000Z';

/** A target with just its two fields, for building plan cases tersely. */
function target(invoiceId: string, remaining: number): AllocationTarget {
	return { invoiceId, remaining: rupiah(remaining) };
}

describe('planAllocations — the arithmetic, without a database', () => {
	it('fills the targets in the order given until the money runs out', () => {
		const plan = planAllocations(rupiah(250_000), [
			target('a', 100_000),
			target('b', 100_000),
			target('c', 100_000)
		]);

		expect(plan).toEqual([
			{ invoiceId: 'a', amount: 100_000 },
			{ invoiceId: 'b', amount: 100_000 },
			{ invoiceId: 'c', amount: 50_000 }
		]);
	});

	it('never plans past a target remaining amount', () => {
		const plan = planAllocations(rupiah(300_000), [target('a', 100_000)]);

		expect(plan).toEqual([{ invoiceId: 'a', amount: 100_000 }]);
	});

	it('never plans more, in total, than the money it was given', () => {
		// Walked over a spread of budgets against one target list, because this sum is the "jumlah
		// alokasi sebuah pembayaran tidak pernah melebihi nominalnya" criterion in miniature.
		const targets = [target('a', 70_000), target('b', 30_000), target('c', 150_000)];
		for (const available of [1, 50_000, 100_000, 249_999, 250_000, 400_000]) {
			const plan = planAllocations(rupiah(available), targets);
			const total = plan.reduce((sum, planned) => sum + planned.amount, 0);
			expect(total).toBeLessThanOrEqual(available);
			// And it is never lazy either: everything the targets can absorb, up to the budget, lands.
			expect(total).toBe(Math.min(available, 250_000));
		}
	});

	it('passes over a target that is already fully paid', () => {
		const plan = planAllocations(rupiah(100_000), [target('paid', 0), target('open', 100_000)]);

		expect(plan).toEqual([{ invoiceId: 'open', amount: 100_000 }]);
	});

	it('serves a duplicated target once, so the unique pair index can never be violated', () => {
		const plan = planAllocations(rupiah(200_000), [target('a', 60_000), target('a', 60_000)]);

		expect(plan).toEqual([{ invoiceId: 'a', amount: 60_000 }]);
	});

	it('plans nothing for no targets, and nothing for no money', () => {
		expect(planAllocations(rupiah(100_000), [])).toEqual([]);
		expect(planAllocations(rupiah(0), [target('a', 100_000)])).toEqual([]);
	});
});

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** One house. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'AL', number: String(sequence), createdAt: new Date(START) })
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

/** A Tagihan written straight into `invoices`. */
async function insertInvoice(
	unitId: string,
	period: string,
	amount: Rupiah = rupiah(100_000)
): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({ unitId, period, amount, dueDate: `${period}-05`, issuedAt: new Date(START) })
		.returning();
	return row.id;
}

/** A verified Pembayaran — the kind whose remainder is a unit's saldo titipan. */
async function insertVerifiedPayment(
	unitId: string,
	residentId: string,
	amount: Rupiah,
	receivedOn: string
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
			status: PAYMENT_STATUS.verified,
			// The constraint wants the verifier and the instant together on a verified row.
			verifiedBy: residentId,
			verifiedAt: new Date(START),
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** An allocation written straight into the table, for arranging a partly spent payment. */
async function insertAllocation(
	paymentId: string,
	invoiceId: string,
	amount: Rupiah
): Promise<void> {
	await testDb.db
		.insert(allocations)
		.values({ paymentId, invoiceId, amount, createdAt: new Date(START) });
}

/** Every allocation pointing at one invoice, oldest row first. */
async function allocationsTo(invoiceId: string) {
	return testDb.db
		.select()
		.from(allocations)
		.where(eq(allocations.invoiceId, invoiceId))
		.orderBy(asc(allocations.createdAt), asc(allocations.id));
}

describe('openInvoicesOfUnit', () => {
	it('answers the standing invoices oldest first, with allocated and remaining amounts computed', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Baca Tagihan Terbuka');
		const january = await insertInvoice(unitId, '2026-01');
		const december = await insertInvoice(unitId, '2025-12');
		const voided = await insertInvoice(unitId, '2025-11');
		await testDb.db
			.update(invoices)
			.set({
				voidedAt: new Date(START),
				voidReason: 'Dibatalkan untuk pengujian.',
				voidedBy: residentId
			})
			.where(eq(invoices.id, voided));
		const paymentId = await insertVerifiedPayment(unitId, residentId, rupiah(40_000), '2025-12-10');
		await insertAllocation(paymentId, december, rupiah(40_000));

		const open = await openInvoicesOfUnit(testDb.db, unitId);

		expect(open.map((invoice) => invoice.invoiceId)).toEqual([december, january]);
		expect(open[0]).toMatchObject({
			period: '2025-12',
			amount: 100_000,
			allocatedAmount: 40_000,
			remainingAmount: 60_000
		});
		expect(open[1]).toMatchObject({
			period: '2026-01',
			allocatedAmount: 0,
			remainingAmount: 100_000
		});
	});

	it('keeps a fully paid invoice on the list, with zero remaining', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Tagihan Lunas Terlihat');
		const paid = await insertInvoice(unitId, '2026-01');
		const paymentId = await insertVerifiedPayment(
			unitId,
			residentId,
			rupiah(100_000),
			'2026-01-10'
		);
		await insertAllocation(paymentId, paid, rupiah(100_000));

		const open = await openInvoicesOfUnit(testDb.db, unitId);

		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({ invoiceId: paid, remainingAmount: 0 });
	});
});

describe('applyCreditToInvoice', () => {
	it('drains the oldest money first, across payments, until the invoice is covered', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Titipan Dua Setoran');
		const older = await insertVerifiedPayment(unitId, residentId, rupiah(100_000), '2026-01-02');
		const newer = await insertVerifiedPayment(unitId, residentId, rupiah(100_000), '2026-01-20');
		const invoiceId = await insertInvoice(unitId, '2026-02', rupiah(150_000));

		const applied = await testDb.db.transaction(async (transaction) =>
			applyCreditToInvoice(transaction, new FakeClock(START), {
				id: invoiceId,
				unitId,
				amount: rupiah(150_000)
			})
		);

		expect(applied).toBe(150_000);
		// Per payment, not in row order: both rows carry one FakeClock instant, so the table has no
		// meaningful order to assert on — "oldest first" is visible in the amounts, the older payment
		// drained whole and the newer only dented.
		const rows = await allocationsTo(invoiceId);
		const byPayment = new Map(rows.map((row) => [row.paymentId, row.amount]));
		expect(byPayment.get(older)).toBe(100_000);
		expect(byPayment.get(newer)).toBe(50_000);
		expect(rows).toHaveLength(2);
	});

	it('only spends what a payment has left, and leaves a partial allocation when the balance runs out', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Titipan Sebagian');
		const spent = await insertVerifiedPayment(unitId, residentId, rupiah(100_000), '2026-01-02');
		const earlier = await insertInvoice(unitId, '2026-01');
		await insertAllocation(spent, earlier, rupiah(70_000));
		const invoiceId = await insertInvoice(unitId, '2026-02', rupiah(100_000));

		const applied = await testDb.db.transaction(async (transaction) =>
			applyCreditToInvoice(transaction, new FakeClock(START), {
				id: invoiceId,
				unitId,
				amount: rupiah(100_000)
			})
		);

		// Only the Rp30.000 remainder existed, so only it landed: the invoice stays partly paid.
		expect(applied).toBe(30_000);
		const rows = await allocationsTo(invoiceId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ paymentId: spent, amount: 30_000 });
	});

	it('spends nothing from a pending payment, whatever its amount', async () => {
		const unitId = await insertUnit();
		const residentId = await insertResident('Warga Titipan Belum Sah');
		await testDb.db.insert(payments).values({
			unitId,
			recordedBy: residentId,
			amount: rupiah(500_000),
			receivedOn: '2026-01-02',
			method: PAYMENT_METHOD.transfer,
			proofFileKey: null,
			status: PAYMENT_STATUS.pending,
			createdAt: new Date(START)
		});
		const invoiceId = await insertInvoice(unitId, '2026-02');

		const applied = await testDb.db.transaction(async (transaction) =>
			applyCreditToInvoice(transaction, new FakeClock(START), {
				id: invoiceId,
				unitId,
				amount: rupiah(100_000)
			})
		);

		expect(applied).toBe(0);
		expect(await allocationsTo(invoiceId)).toHaveLength(0);
	});
});
