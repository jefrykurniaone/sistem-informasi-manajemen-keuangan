import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { invoices } from '$lib/server/db/schema/invoice';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { openInvoicesOfUnit } from '$lib/server/services/dues/allocation';
import {
	ALLOCATION_RELEASED_ACTION,
	AllocationNotFoundError,
	RELEASE_RULE,
	ReleaseRuleError,
	releaseAllocation
} from '$lib/server/services/dues/allocation-release';
import {
	creditBalanceOfUnit,
	lockUnallocatedVerifiedPayments
} from '$lib/server/services/dues/credit-balance';

/**
 * Pelepasan Alokasi — user story 22 of `docs/spec-iuran-v1.md`, and #30's second correction: the
 * row is deleted, its value is the Unit's saldo titipan again by definition, the Tagihan is open
 * again, and **no cash row moves**. Against a real PostgreSQL, because "the cash book did not
 * change" is a statement about committed rows.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-03-10T09:00:00.000Z';

/** The Periode most Tagihan in this file are for. */
const PERIOD = '2026-03';

const RELEASE_REASON = 'Uangnya untuk bulan lain; peruntukannya salah pilih.';

/** Makes every house and every email in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${unique(id)}@komplek.local`,
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

/** One house. Returns its id. */
async function insertUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'AR', number: unique('1'), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One standing Tagihan of `amount`. Returns its id. */
async function insertInvoice(unitId: string, amount: Rupiah): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({ unitId, period: PERIOD, amount, dueDate: `${PERIOD}-05`, issuedAt: new Date(START) })
		.returning();
	return row.id;
}

/** One verified Pembayaran of `amount`. Returns its id. */
async function insertVerifiedPayment(unitId: string, amount: Rupiah): Promise<string> {
	const userId = await insertUser('Warga Pelepasan');
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy: resident.id,
			amount,
			receivedOn: '2026-03-03',
			method: PAYMENT_METHOD.transfer,
			proofFileKey: null,
			status: PAYMENT_STATUS.verified,
			verifiedBy: resident.id,
			verifiedAt: new Date(START),
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** One Alokasi, written directly. Returns its id. */
async function insertAllocation(
	paymentId: string,
	invoiceId: string,
	amount: Rupiah
): Promise<string> {
	const [row] = await testDb.db
		.insert(allocations)
		.values({ paymentId, invoiceId, amount, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** Every row of the cash book, in a stable order, for a before-and-after comparison. */
async function allCashRows() {
	return testDb.db.select().from(cashTransactions).orderBy(asc(cashTransactions.id));
}

describe('releaseAllocation', () => {
	it('deletes the row, restores the balance, and reopens the Tagihan — one act, by definition', async () => {
		const actorId = await insertUserWithRole('Pengurus Pelepas', ROLE.superuser);
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId, rupiah(150_000));
		const paymentId = await insertVerifiedPayment(unitId, rupiah(150_000));
		const allocationId = await insertAllocation(paymentId, invoiceId, rupiah(150_000));
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);

		const released = await releaseAllocation(testDb.db, new FakeClock(START), {
			actorId,
			allocationId,
			reason: RELEASE_REASON
		});

		// The returned Alokasi is the row as it stood when it was released.
		expect(released).toMatchObject({ id: allocationId, paymentId, invoiceId, amount: 150_000 });

		// The row is gone, and its value answers nothing again: the balance rose by exactly it,
		// the payment's remainder is whole again, and the Tagihan is open and fully unpaid.
		expect(
			await testDb.db.select().from(allocations).where(eq(allocations.id, allocationId))
		).toHaveLength(0);
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(150_000);
		const remainders = await testDb.db.transaction(async (transaction) =>
			lockUnallocatedVerifiedPayments(transaction, unitId)
		);
		expect(remainders).toEqual([expect.objectContaining({ paymentId, remainder: 150_000 })]);
		expect(await openInvoicesOfUnit(testDb.db, unitId)).toEqual([
			expect.objectContaining({ invoiceId, allocatedAmount: 0, remainingAmount: 150_000 })
		]);
	});

	it('changes no cash row — uang tetap di kas, hanya peruntukannya yang berubah', async () => {
		const actorId = await insertUserWithRole('Pengurus Pelepas Kas', ROLE.superuser);
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId, rupiah(100_000));
		const paymentId = await insertVerifiedPayment(unitId, rupiah(100_000));
		const allocationId = await insertAllocation(paymentId, invoiceId, rupiah(100_000));
		const before = await allCashRows();

		await releaseAllocation(testDb.db, new FakeClock(START), {
			actorId,
			allocationId,
			reason: RELEASE_REASON
		});

		// Byte for byte, row for row: the release touched nothing in the buku kas.
		expect(await allCashRows()).toEqual(before);
	});

	it('records one audit row keeping everything the deleted Alokasi said', async () => {
		// The audit log is the only place a released Alokasi survives — the design
		// `src/lib/server/db/schema/allocation.ts` records — so the row carries the whole content.
		const actorId = await insertUserWithRole('Pengurus Pelepas Audit', ROLE.superuser);
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId, rupiah(150_000));
		const paymentId = await insertVerifiedPayment(unitId, rupiah(150_000));
		const allocationId = await insertAllocation(paymentId, invoiceId, rupiah(150_000));

		await releaseAllocation(testDb.db, new FakeClock(START), {
			actorId,
			allocationId,
			reason: RELEASE_REASON
		});

		const entries = await auditEntriesFor(testDb.db, allocationId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId,
			action: ALLOCATION_RELEASED_ACTION,
			targetId: allocationId,
			before: { paymentId, invoiceId, amount: 150_000, createdAt: START },
			after: { unitId, reason: RELEASE_REASON }
		});
	});

	it('refuses an empty reason', async () => {
		const actorId = await insertUserWithRole('Pengurus Pelepas Tanpa Alasan', ROLE.superuser);
		const unitId = await insertUnit();
		const allocationId = await insertAllocation(
			await insertVerifiedPayment(unitId, rupiah(100_000)),
			await insertInvoice(unitId, rupiah(100_000)),
			rupiah(100_000)
		);

		const refusal: unknown = await releaseAllocation(testDb.db, new FakeClock(START), {
			actorId,
			allocationId,
			reason: '   '
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ReleaseRuleError);
		expect(refusal).toMatchObject({ rule: RELEASE_RULE.reasonMissing });
		expect(
			await testDb.db.select().from(allocations).where(eq(allocations.id, allocationId))
		).toHaveLength(1);
	});

	it('refuses an id that names no Alokasi — including one already released', async () => {
		const actorId = await insertUserWithRole('Pengurus Pelepas Hantu', ROLE.superuser);
		const unitId = await insertUnit();
		const allocationId = await insertAllocation(
			await insertVerifiedPayment(unitId, rupiah(100_000)),
			await insertInvoice(unitId, rupiah(100_000)),
			rupiah(100_000)
		);
		await releaseAllocation(testDb.db, new FakeClock(START), {
			actorId,
			allocationId,
			reason: RELEASE_REASON
		});

		await expect(
			releaseAllocation(testDb.db, new FakeClock(START), {
				actorId,
				allocationId,
				reason: 'Sekali lagi.'
			})
		).rejects.toThrow(AllocationNotFoundError);
		await expect(
			releaseAllocation(testDb.db, new FakeClock(START), {
				actorId,
				allocationId: randomUUID(),
				reason: RELEASE_REASON
			})
		).rejects.toThrow(AllocationNotFoundError);
	});

	it('refuses an admin who is not a superuser, and a resident, and deletes nothing', async () => {
		const adminId = await insertUserWithRole('Pengurus Harian Pelepas', ROLE.admin);
		const residentId = await insertUser('Warga Biasa Pelepas');
		const unitId = await insertUnit();
		const allocationId = await insertAllocation(
			await insertVerifiedPayment(unitId, rupiah(100_000)),
			await insertInvoice(unitId, rupiah(100_000)),
			rupiah(100_000)
		);

		for (const actorId of [adminId, residentId]) {
			await expect(
				releaseAllocation(testDb.db, new FakeClock(START), {
					actorId,
					allocationId,
					reason: RELEASE_REASON
				})
			).rejects.toThrow(PermissionDeniedError);
		}

		expect(
			await testDb.db.select().from(allocations).where(eq(allocations.id, allocationId))
		).toHaveLength(1);
		expect(await auditEntriesFor(testDb.db, allocationId)).toHaveLength(0);
	});
});
