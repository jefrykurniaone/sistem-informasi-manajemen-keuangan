import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '$lib/money';
import type { Allocation } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { emailQueue } from '$lib/server/db/schema/email';
import { invoices } from '$lib/server/db/schema/invoice';
import { OCCUPANCY_ROLE, occupancies } from '$lib/server/db/schema/occupancy';
import {
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	type Payment,
	type PaymentStatus
} from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { INVOICE_ISSUED_KIND } from '$lib/server/email/templates/invoice-issued';
import { PAYMENT_REJECTED_KIND } from '$lib/server/email/templates/payment-rejected';
import { PAYMENT_VERIFIED_KIND } from '$lib/server/email/templates/payment-verified';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	notifyInvoiceIssued,
	notifyPaymentRejected,
	notifyPaymentVerified
} from '$lib/server/services/dues/notification';
import {
	isMandatorySubscriptionKind,
	SUBSCRIPTION_KIND,
	subscriptionKindDefinition
} from '$lib/server/services/subscription/kinds';
import {
	MandatorySubscriptionKindError,
	setSubscriptionPreference
} from '$lib/server/services/subscription';

/**
 * `./notification.ts` in isolation: which recipient each of the three emails finds (or does not),
 * and what it queues for them. `tests/unit/invoice-issuance.test.ts` and
 * `tests/unit/payment-verification.test.ts` prove the wiring — that the right call site enqueues at
 * the right moment — so this file is the recipient-resolution rules and the payload shapes on their
 * own, plus the one acceptance criterion that belongs to neither: that `invoice-issued` and
 * `payment-verified` cannot be switched off, which is `subscription/kinds.ts` and
 * `subscription/index.ts`'s own behaviour (#22), proved here rather than reimplemented.
 */

const testDb = testDatabase();

/** The instant every clock in this file reads. */
const START = '2026-04-10T00:00:00.000Z';

/** "Today", as `notifyInvoiceIssued`'s primary-occupant lookup reads it off the clock. */
const TODAY = '2026-04-10';

/** Makes every block and email this file writes different from every other one. */
let sequence = 0;

/** A house. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({
			block: `NOTIFY-${String(sequence).padStart(3, '0')}`,
			number: '1',
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** An account and its `residents` row, with an email address this file can assert on. */
async function insertResident(name: string): Promise<{ residentId: string; email: string }> {
	const userId = randomUUID();
	const email = `${userId}@komplek.local`;
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id: userId,
		name,
		email,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: now })
		.returning();
	return { residentId: resident.id, email };
}

/** One occupancy of `unitId`, written straight into `occupancies`. */
async function insertOccupancy(
	unitId: string,
	residentId: string,
	options: { isPrimaryOccupant: boolean; startedOn: string; endedOn: string | null }
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: options.startedOn,
		endedOn: options.endedOn,
		isPrimaryOccupant: options.isPrimaryOccupant,
		createdAt: new Date(START)
	});
}

/** A Tagihan written straight into `invoices`, for a settlement's period to resolve against. */
async function insertInvoiceRow(unitId: string, period: string, amount: Rupiah): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({ unitId, period, amount, dueDate: `${period}-05`, issuedAt: new Date(START) })
		.returning();
	return row.id;
}

/** A Pembayaran written straight into `payments`, already decided one way or the other. */
async function insertPayment(
	unitId: string,
	recordedBy: string,
	overrides: Partial<{ amount: Rupiah; status: PaymentStatus; rejectionReason: string | null }> = {}
): Promise<Payment> {
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy,
			amount: overrides.amount ?? rupiah(150_000),
			receivedOn: '2026-04-01',
			method: PAYMENT_METHOD.transfer,
			proofFileKey: null,
			status: overrides.status ?? PAYMENT_STATUS.verified,
			rejectionReason: overrides.rejectionReason ?? null,
			verifiedBy: overrides.status === PAYMENT_STATUS.rejected ? null : recordedBy,
			verifiedAt: overrides.status === PAYMENT_STATUS.rejected ? null : new Date(START),
			createdAt: new Date(START)
		})
		.returning();
	return row;
}

/** An `Allocation`-shaped value, without a row in `allocations` — `notifyPaymentVerified` never reads that table itself. */
function allocationOf(paymentId: string, invoiceId: string, amount: Rupiah): Allocation {
	return { id: randomUUID(), paymentId, invoiceId, amount, createdAt: new Date(START) };
}

/** Every queued email of `kind` addressed to `recipient` — scoped so one test's rows never leak into another's. */
async function emailsTo(recipient: string, kind: string) {
	return testDb.db
		.select()
		.from(emailQueue)
		.where(eq(emailQueue.recipient, recipient))
		.then((rows) => rows.filter((row) => row.kind === kind));
}

describe('notifyInvoiceIssued', () => {
	it('queues to the active primary occupant and reports true', async () => {
		const unit = await insertUnit();
		const occupant = await insertResident('Warga Penanggung Jawab Notifikasi');
		await insertOccupancy(unit, occupant.residentId, {
			isPrimaryOccupant: true,
			startedOn: '2026-01-01',
			endedOn: null
		});

		const notified = await notifyInvoiceIssued(testDb.db, new FakeClock(START), {
			unitId: unit,
			block: 'A',
			number: '1',
			period: '2026-04',
			amount: rupiah(150_000),
			dueDate: '2026-04-05'
		});

		expect(notified).toBe(true);
		const rows = await emailsTo(occupant.email, INVOICE_ISSUED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			block: 'A',
			number: '1',
			period: '2026-04',
			amount: 150_000,
			dueDate: '2026-04-05',
			locale: 'id'
		});
	});

	it('reports false, and queues nothing, for a unit with no occupancy at all', async () => {
		const unit = await insertUnit();

		const notified = await notifyInvoiceIssued(testDb.db, new FakeClock(START), {
			unitId: unit,
			block: 'B',
			number: '1',
			period: '2026-04',
			amount: rupiah(150_000),
			dueDate: '2026-04-05'
		});

		expect(notified).toBe(false);
	});

	it('does not treat an occupant who is not the primary one as a recipient', async () => {
		const unit = await insertUnit();
		const occupant = await insertResident('Warga Bukan Penanggung Jawab');
		await insertOccupancy(unit, occupant.residentId, {
			isPrimaryOccupant: false,
			startedOn: '2026-01-01',
			endedOn: null
		});

		const notified = await notifyInvoiceIssued(testDb.db, new FakeClock(START), {
			unitId: unit,
			block: 'C',
			number: '1',
			period: '2026-04',
			amount: rupiah(150_000),
			dueDate: '2026-04-05'
		});

		expect(notified).toBe(false);
		expect(await emailsTo(occupant.email, INVOICE_ISSUED_KIND)).toEqual([]);
	});

	it('does not treat a primary occupant whose stay has already ended as active', async () => {
		const unit = await insertUnit();
		const occupant = await insertResident('Warga Penanggung Jawab Sudah Pindah');
		await insertOccupancy(unit, occupant.residentId, {
			isPrimaryOccupant: true,
			startedOn: '2025-01-01',
			endedOn: '2026-03-01'
		});

		const notified = await notifyInvoiceIssued(testDb.db, new FakeClock(START), {
			unitId: unit,
			block: 'D',
			number: '1',
			period: '2026-04',
			amount: rupiah(150_000),
			dueDate: '2026-04-05'
		});

		expect(notified).toBe(false);
	});

	it('treats a primary occupant whose end date has not arrived yet as still active', async () => {
		// The same `isStillRunningOn` gap `./occupancy/visibility.ts` documents: an end date in the
		// future does not free the slot early.
		const unit = await insertUnit();
		const occupant = await insertResident('Warga Penanggung Jawab Pindah Nanti');
		await insertOccupancy(unit, occupant.residentId, {
			isPrimaryOccupant: true,
			startedOn: '2025-01-01',
			endedOn: '2099-01-01'
		});
		expect(TODAY < '2099-01-01').toBe(true);

		const notified = await notifyInvoiceIssued(testDb.db, new FakeClock(START), {
			unitId: unit,
			block: 'E',
			number: '1',
			period: '2026-04',
			amount: rupiah(150_000),
			dueDate: '2026-04-05'
		});

		expect(notified).toBe(true);
		expect(await emailsTo(occupant.email, INVOICE_ISSUED_KIND)).toHaveLength(1);
	});
});

describe('notifyPaymentVerified', () => {
	it('queues to the recorder, with one settlement line per allocation, oldest given first', async () => {
		const unit = await insertUnit();
		const recorder = await insertResident('Warga Pencatat Verifikasi');
		const payment = await insertPayment(unit, recorder.residentId, { amount: rupiah(150_000) });
		const january = await insertInvoiceRow(unit, '2026-01', rupiah(100_000));
		const february = await insertInvoiceRow(unit, '2026-02', rupiah(50_000));

		await notifyPaymentVerified(testDb.db, new FakeClock(START), payment, [
			allocationOf(payment.id, january, rupiah(100_000)),
			allocationOf(payment.id, february, rupiah(50_000))
		]);

		const rows = await emailsTo(recorder.email, PAYMENT_VERIFIED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			amount: 150_000,
			settlements: [
				{ period: '2026-01', amount: 100_000 },
				{ period: '2026-02', amount: 50_000 }
			],
			locale: 'id'
		});
	});

	it('queues an empty settlements list when the payment settled no Tagihan at all', async () => {
		const unit = await insertUnit();
		const recorder = await insertResident('Warga Pencatat Titipan Penuh');
		const payment = await insertPayment(unit, recorder.residentId, { amount: rupiah(200_000) });

		await notifyPaymentVerified(testDb.db, new FakeClock(START), payment, []);

		const rows = await emailsTo(recorder.email, PAYMENT_VERIFIED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({ amount: 200_000, settlements: [] });
	});
});

describe('notifyPaymentRejected', () => {
	it('queues to the recorder, naming the rejection reason', async () => {
		const unit = await insertUnit();
		const recorder = await insertResident('Warga Pencatat Ditolak');
		const payment = await insertPayment(unit, recorder.residentId, {
			amount: rupiah(80_000),
			status: PAYMENT_STATUS.rejected,
			rejectionReason: 'Bukti transfer buram.'
		});

		await notifyPaymentRejected(testDb.db, new FakeClock(START), payment);

		const rows = await emailsTo(recorder.email, PAYMENT_REJECTED_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			amount: 80_000,
			reason: 'Bukti transfer buram.',
			locale: 'id'
		});
	});

	it('queues nothing for a row with no rejection reason, rather than throw', async () => {
		// `payments_rejection_reason_check` never lets this happen to a real rejected row; this is the
		// module refusing quietly on a shape it cannot render, not a state this application produces.
		const unit = await insertUnit();
		const recorder = await insertResident('Warga Pencatat Tanpa Alasan');
		const payment = await insertPayment(unit, recorder.residentId, {
			status: PAYMENT_STATUS.rejected,
			rejectionReason: null
		});

		await expect(
			notifyPaymentRejected(testDb.db, new FakeClock(START), payment)
		).resolves.toBeUndefined();
		expect(await emailsTo(recorder.email, PAYMENT_REJECTED_KIND)).toEqual([]);
	});
});

describe('invoice-issued and payment-verified cannot be switched off', () => {
	it.each([SUBSCRIPTION_KIND.invoiceIssued, SUBSCRIPTION_KIND.paymentVerified])(
		'refuses setSubscriptionPreference(..., { kind: "%s", enabled: false })',
		async (kind) => {
			const userId = randomUUID();
			const now = new Date(START);
			await testDb.db.insert(user).values({
				id: userId,
				name: `Warga Wajib ${kind}`,
				email: `${userId}@komplek.local`,
				emailVerified: true,
				createdAt: now,
				updatedAt: now
			});
			const [resident] = await testDb.db
				.insert(residents)
				.values({ userId, createdAt: now })
				.returning();

			await expect(
				setSubscriptionPreference(testDb.db, new FakeClock(START), {
					callerUserId: userId,
					residentId: resident.id,
					kind,
					enabled: false
				})
			).rejects.toBeInstanceOf(MandatorySubscriptionKindError);
		}
	);

	it('is true of invoice-issued and payment-verified in the registry itself', () => {
		expect(isMandatorySubscriptionKind(SUBSCRIPTION_KIND.invoiceIssued)).toBe(true);
		expect(isMandatorySubscriptionKind(SUBSCRIPTION_KIND.paymentVerified)).toBe(true);
	});

	it('is not true of payment-rejected, because it is transactional and not a subscription kind at all', () => {
		expect(isMandatorySubscriptionKind(PAYMENT_REJECTED_KIND)).toBe(false);
		expect(subscriptionKindDefinition(PAYMENT_REJECTED_KIND)).toBeUndefined();
	});
});
