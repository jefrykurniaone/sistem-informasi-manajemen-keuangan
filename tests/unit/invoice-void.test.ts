import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { invoices } from '$lib/server/db/schema/invoice';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { openInvoicesOfUnit } from '$lib/server/services/dues/allocation';
import { releaseAllocation } from '$lib/server/services/dues/allocation-release';
import { creditBalanceOfUnit } from '$lib/server/services/dues/credit-balance';
import {
	INVOICE_VOIDED_ACTION,
	InvoiceNotFoundError,
	VOID_RULE,
	VoidRefusedAllocatedError,
	VoidRuleError,
	voidInvoice
} from '$lib/server/services/dues/invoice-void';
import { INVOICE_STATUS, invoiceStatus } from '$lib/server/services/dues/queries';

/**
 * Pembatalan Tagihan — user stories 20 and 21 of `docs/spec-iuran-v1.md`, and #30's first
 * correction: a Tagihan is marked `void` with a reason and an actor, never deleted, and a Tagihan
 * that has absorbed money refuses by naming the Alokasi that must be released first. Against a
 * real PostgreSQL, because "the row is still there" and "nothing was written" are statements
 * about committed rows.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-03-10T09:00:00.000Z';

/** The Periode most Tagihan in this file are for. */
const PERIOD = '2026-03';

/** The monthly amount this file bills. */
const MONTHLY = rupiah(150_000);

const VOID_REASON = 'Tagihan terbit untuk rumah yang sedang dibebaskan.';

/** Makes every house and every email in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
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

/**
 * A superuser with a `residents` row — the actor a cancellation is attributed to, because
 * `invoices.voidedBy` references `residents.id`.
 */
async function insertRegisteredSuperuser(name: string): Promise<string> {
	const id = insertUserWithRole(name, ROLE.superuser);
	await testDb.db.insert(residents).values({ userId: await id, createdAt: new Date(START) });
	return id;
}

/** One house. Returns its id. */
async function insertUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'IV', number: unique('1'), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One standing Tagihan. Returns its id. */
async function insertInvoice(unitId: string, period: string = PERIOD): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({
			unitId,
			period,
			amount: MONTHLY,
			dueDate: `${period}-05`,
			issuedAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** One verified Pembayaran of `amount`, with the resident behind it. Returns its id. */
async function insertVerifiedPayment(unitId: string, amount: Rupiah): Promise<string> {
	const userId = await insertUser('Warga Pembatalan');
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

/** One Alokasi of `amount` from `paymentId` to `invoiceId`, written directly. Returns its id. */
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

describe('voidInvoice', () => {
	it('marks the Tagihan void — reason, actor and instant together — and never deletes it', async () => {
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);

		const voided = await voidInvoice(testDb.db, new FakeClock(START), {
			actorId,
			invoiceId,
			reason: `  ${VOID_REASON}  `
		});

		// All three markers in one update, the only combination `invoices_void_check` accepts —
		// and the reason arrives trimmed.
		expect(voided.voidedAt?.getTime()).toBe(Date.parse(START));
		expect(voided.voidReason).toBe(VOID_REASON);
		expect(voided.voidedBy).not.toBeNull();

		const [row] = await testDb.db.select().from(invoices).where(eq(invoices.id, invoiceId));
		expect(row).toBeDefined();
		expect(row.voidedAt).not.toBeNull();

		// The computed status reads it as void, and the open list no longer offers it.
		expect(
			invoiceStatus(
				{
					amount: row.amount,
					allocatedAmount: rupiah(0),
					dueDate: row.dueDate,
					voidedAt: row.voidedAt
				},
				'2026-03-10'
			)
		).toBe(INVOICE_STATUS.void);
		expect(await openInvoicesOfUnit(testDb.db, unitId)).toEqual([]);
	});

	it('records one audit row, filed against the Tagihan, carrying the unit and the reason', async () => {
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal Audit');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);

		await voidInvoice(testDb.db, new FakeClock(START), { actorId, invoiceId, reason: VOID_REASON });

		const entries = await auditEntriesFor(testDb.db, invoiceId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId,
			action: INVOICE_VOIDED_ACTION,
			targetId: invoiceId,
			before: { voidedAt: null },
			after: { unitId, period: PERIOD, amount: MONTHLY, reason: VOID_REASON }
		});
	});

	it('refuses a Tagihan that still has Alokasi, naming every one of them', async () => {
		// User story 21 verbatim: the refusal says which allocations must be released first.
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal Teralokasi');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);
		const paymentId = await insertVerifiedPayment(unitId, rupiah(200_000));
		const firstAllocation = await insertAllocation(paymentId, invoiceId, rupiah(100_000));
		const secondAllocation = await insertAllocation(
			await insertVerifiedPayment(unitId, rupiah(50_000)),
			invoiceId,
			rupiah(50_000)
		);

		const refusal: unknown = await voidInvoice(testDb.db, new FakeClock(START), {
			actorId,
			invoiceId,
			reason: VOID_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VoidRefusedAllocatedError);
		const named = (refusal as VoidRefusedAllocatedError).allocations.map(
			(allocation) => allocation.allocationId
		);
		expect(named.sort()).toEqual([firstAllocation, secondAllocation].sort());
		expect((refusal as VoidRefusedAllocatedError).allocations).toEqual(
			expect.arrayContaining([expect.objectContaining({ paymentId, amount: 100_000 })])
		);

		// Nothing happened: the Tagihan stands, and no audit row claims otherwise.
		const [row] = await testDb.db.select().from(invoices).where(eq(invoices.id, invoiceId));
		expect(row.voidedAt).toBeNull();
		expect(await auditEntriesFor(testDb.db, invoiceId)).toHaveLength(0);
	});

	it('succeeds once the Alokasi are released, and the released money is saldo titipan again', async () => {
		// The spec's own scenario, end to end through the real services: refused while allocated,
		// released, then voided — and the Unit's balance grew by exactly the released amount.
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal Beruntun');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);
		const paymentId = await insertVerifiedPayment(unitId, rupiah(150_000));
		const allocationId = await insertAllocation(paymentId, invoiceId, MONTHLY);
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(0);

		await expect(
			voidInvoice(testDb.db, new FakeClock(START), { actorId, invoiceId, reason: VOID_REASON })
		).rejects.toThrow(VoidRefusedAllocatedError);

		await releaseAllocation(testDb.db, new FakeClock(START), {
			actorId,
			allocationId,
			reason: 'Alokasinya dilepas supaya tagihannya bisa dibatalkan.'
		});
		expect(await creditBalanceOfUnit(testDb.db, unitId)).toBe(150_000);

		const voided = await voidInvoice(testDb.db, new FakeClock(START), {
			actorId,
			invoiceId,
			reason: VOID_REASON
		});
		expect(voided.voidedAt).not.toBeNull();
	});

	it('refuses an empty reason — pembatalan dengan alasan wajib', async () => {
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal Tanpa Alasan');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);

		const refusal: unknown = await voidInvoice(testDb.db, new FakeClock(START), {
			actorId,
			invoiceId,
			reason: '   '
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VoidRuleError);
		expect(refusal).toMatchObject({ rule: VOID_RULE.reasonMissing });
		const [row] = await testDb.db.select().from(invoices).where(eq(invoices.id, invoiceId));
		expect(row.voidedAt).toBeNull();
	});

	it('refuses a second cancellation of the same Tagihan', async () => {
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal Dua Kali');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);
		await voidInvoice(testDb.db, new FakeClock(START), { actorId, invoiceId, reason: VOID_REASON });

		const refusal: unknown = await voidInvoice(testDb.db, new FakeClock(START), {
			actorId,
			invoiceId,
			reason: 'Sekali lagi.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VoidRuleError);
		expect(refusal).toMatchObject({ rule: VOID_RULE.alreadyVoided });
	});

	it('refuses an id that names no Tagihan', async () => {
		const actorId = await insertRegisteredSuperuser('Pengurus Pembatal Hantu');

		await expect(
			voidInvoice(testDb.db, new FakeClock(START), {
				actorId,
				invoiceId: randomUUID(),
				reason: VOID_REASON
			})
		).rejects.toThrow(InvoiceNotFoundError);
	});

	it('refuses a superuser with no residents row, because voidedBy references residents.id', async () => {
		const actorId = await insertUserWithRole('Pengurus Tanpa Baris Warga', ROLE.superuser);
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);

		const refusal: unknown = await voidInvoice(testDb.db, new FakeClock(START), {
			actorId,
			invoiceId,
			reason: VOID_REASON
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VoidRuleError);
		expect(refusal).toMatchObject({ rule: VOID_RULE.actorNotRegistered });
	});

	it('refuses an admin who is not a superuser, and a resident, and writes nothing', async () => {
		// The acceptance criterion: `correctDues` is superuser's alone, and `isAllowed` has no
		// inheritance, so holding `admin` grants none of the three corrections.
		const adminId = await insertUserWithRole('Pengurus Harian Pembatal', ROLE.admin);
		const residentId = await insertUser('Warga Biasa Pembatal');
		const unitId = await insertUnit();
		const invoiceId = await insertInvoice(unitId);

		for (const actorId of [adminId, residentId]) {
			await expect(
				voidInvoice(testDb.db, new FakeClock(START), { actorId, invoiceId, reason: VOID_REASON })
			).rejects.toThrow(PermissionDeniedError);
		}

		const [row] = await testDb.db.select().from(invoices).where(eq(invoices.id, invoiceId));
		expect(row.voidedAt).toBeNull();
		expect(await auditEntriesFor(testDb.db, invoiceId)).toHaveLength(0);
	});
});
