import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { cashCategories, SYSTEM_CATEGORY_KEY } from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { invoices } from '$lib/server/db/schema/invoice';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import type { Clock } from '$lib/server/ports/clock';
import { FakeClock } from '$lib/server/ports/fakes';
import { lockPeriod, PeriodLockedError } from '$lib/server/services/cash/period';
import { creditBalanceOfUnit } from '$lib/server/services/dues/credit-balance';
import { UnitNotFoundError } from '$lib/server/services/dues/queries';
import {
	PAYMENT_REJECTED_ACTION,
	PAYMENT_VERIFIED_ACTION,
	PaymentNotFoundError,
	VERIFICATION_RULE,
	VerificationRuleError,
	listPendingPayments,
	recordCashPayment,
	rejectPayment,
	verifyPayment
} from '$lib/server/services/dues/verification';
import { PAYMENT_RECORDED_ACTION } from '$lib/server/services/dues/payment';

/**
 * Verifikasi Pembayaran: the one transaction that flips the status, writes the cash row into
 * "Iuran warga" dated on the day the money was received, and creates the Alokasi — all together or
 * not at all. Against a real PostgreSQL, because "nothing was half-written" is a statement about
 * committed rows, and the atomicity test below injects a failure at every step in turn and reads
 * the tables back.
 */

const testDb = testDatabase();

/** The instant every working clock in this file starts at. */
const START = '2026-02-10T00:00:00.000Z';

/** The day the money moved in most of these tests — comfortably in the past, in an open month. */
const RECEIVED_ON = '2026-02-03';

/** The message the failure-injecting clock throws, so a test can tell its failure from a real one. */
const CLOCK_FAILURE = 'Injected clock failure, on purpose, from the atomicity test.';

/**
 * A clock that works `failAt - 1` times and then throws — the injected mid-transaction failure the
 * acceptance criteria asks for. Every write inside the verification transaction reads the clock
 * (the verification instant, the Periode row, the cash row, the allocations, the audit row), so
 * walking `failAt` upward drives the failure through every seam of the transaction in turn. The
 * same move `FailingClock` in `tests/unit/import-csv.test.ts` makes.
 */
class FailingClock implements Clock {
	#calls = 0;
	readonly #failAt: number;

	constructor(failAt: number) {
		this.#failAt = failAt;
	}

	now(): Date {
		this.#calls += 1;
		if (this.#calls === this.#failAt) {
			throw new Error(CLOCK_FAILURE);
		}
		return new Date(START);
	}
}

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
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

/** The `residents` row an account needs before money can be attributed to it. */
async function insertResident(userId: string): Promise<string> {
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, phone: null, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** An admin with a `residents` row — the shape a verifying admin needs, per `payments.verifiedBy`. */
async function insertAdmin(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = await insertUserWithRole(name, ROLE.admin);
	const residentId = await insertResident(userId);
	return { userId, residentId };
}

/** One house. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'V', number: String(sequence), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One payer: an account, its resident row, and a house of their own. */
async function insertPayer(name: string): Promise<{ residentId: string; unitId: string }> {
	const userId = await insertUser(name);
	const residentId = await insertResident(userId);
	const unitId = await insertUnit();
	return { residentId, unitId };
}

/** A Tagihan written straight into `invoices`, the way the issuance fixtures do. */
async function insertInvoice(
	unitId: string,
	period: string,
	amount: Rupiah = rupiah(100_000)
): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({
			unitId,
			period,
			amount,
			dueDate: `${period}-05`,
			issuedAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** A pending Pembayaran written straight into `payments` — the row #28 leaves for verification. */
async function insertPendingPayment(
	unitId: string,
	recordedBy: string,
	amount: Rupiah,
	receivedOn: string = RECEIVED_ON
): Promise<string> {
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy,
			amount,
			receivedOn,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: `payments/${randomUUID()}/proof.jpg`,
			status: PAYMENT_STATUS.pending,
			createdAt: new Date(START)
		})
		.returning();
	return row.id;
}

/** The id of the seeded system category "Iuran warga". */
async function duesCategoryId(): Promise<string> {
	const [row] = await testDb.db
		.select({ id: cashCategories.id })
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	return row.id;
}

/** Every cash row filed under "Iuran warga", oldest first — the whole schema's, for deltas. */
async function allDuesCashRows() {
	return testDb.db
		.select()
		.from(cashTransactions)
		.where(eq(cashTransactions.categoryId, await duesCategoryId()))
		.orderBy(asc(cashTransactions.createdAt), asc(cashTransactions.id));
}

/**
 * The dues cash rows whose keterangan names `paymentId` — the row a verification of that payment
 * wrote, and the only row that could have. Scoped this way because this file's tests share one
 * schema and run in sequence, so a bare count would see every earlier test's verifications.
 */
async function duesCashRowsFor(paymentId: string) {
	const rows = await allDuesCashRows();
	return rows.filter((row) => row.description.includes(paymentId));
}

/** Every allocation of one payment, keyed by invoice. */
async function allocationsOf(paymentId: string) {
	return testDb.db
		.select()
		.from(allocations)
		.where(eq(allocations.paymentId, paymentId))
		.orderBy(asc(allocations.id));
}

/** The one payment row, read back. */
async function paymentRow(paymentId: string) {
	const [row] = await testDb.db.select().from(payments).where(eq(payments.id, paymentId));
	return row;
}

describe('verifyPayment', () => {
	it('flips the status, writes one dues cash row dated on receivedOn, and allocates oldest-first', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Utama');
		const payer = await insertPayer('Warga Bayar Tiga Bulan');
		const november = await insertInvoice(payer.unitId, '2025-11');
		const december = await insertInvoice(payer.unitId, '2025-12');
		const january = await insertInvoice(payer.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(300_000));

		const outcome = await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId
		});

		expect(outcome.payment).toMatchObject({
			id: paymentId,
			status: PAYMENT_STATUS.verified,
			verifiedBy: admin.residentId
		});
		expect(outcome.payment.verifiedAt).toEqual(new Date(START));

		// One cash row, in the system category, dated the day the money was received — never today.
		const cashRows = await duesCashRowsFor(paymentId);
		expect(cashRows).toHaveLength(1);
		expect(cashRows[0]).toMatchObject({
			id: outcome.cashTransaction.id,
			occurredOn: RECEIVED_ON,
			type: 'income',
			amount: 300_000,
			recordedBy: admin.userId,
			attachmentKey: null,
			correctionOf: null
		});

		// Rp300.000 against three Rp100.000 invoices settles all three and leaves saldo titipan at
		// exactly zero: the spec's "alokasi banyak-ke-satu" case. Asserted per invoice rather than in
		// row order — the rows share one instant, so the table has no order to lean on; that the walk
		// really runs oldest-first is what the explicit-choice and partial-amount tests below pin.
		const byInvoice = new Map(
			(await allocationsOf(paymentId)).map((row) => [row.invoiceId, row.amount])
		);
		expect(byInvoice).toEqual(
			new Map([
				[november, 100_000],
				[december, 100_000],
				[january, 100_000]
			])
		);
		expect(await creditBalanceOfUnit(testDb.db, payer.unitId)).toBe(0);
	});

	it('leaves what no invoice can absorb as the unit saldo titipan, never as a stored column', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Titipan');
		const payer = await insertPayer('Warga Bayar Di Muka');
		const only = await insertInvoice(payer.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(300_000));

		await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId
		});

		const rows = await allocationsOf(paymentId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ invoiceId: only, amount: 100_000 });
		// Computed as the difference the rows leave behind — there is no column this could be read from.
		expect(await creditBalanceOfUnit(testDb.db, payer.unitId)).toBe(200_000);
	});

	it('serves the explicitly chosen Tagihan first, then continues oldest-first with the rest', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Pilihan');
		const payer = await insertPayer('Warga Pilih Bulan');
		const november = await insertInvoice(payer.unitId, '2025-11');
		const december = await insertInvoice(payer.unitId, '2025-12');
		const january = await insertInvoice(payer.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(150_000));

		await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId,
			invoiceIds: [january]
		});

		// January is honoured first and fully; the remaining Rp50.000 then runs by the automatic
		// rule, which starts at November. December gets nothing.
		const byInvoice = new Map(
			(await allocationsOf(paymentId)).map((row) => [row.invoiceId, row.amount])
		);
		expect(byInvoice.get(january)).toBe(100_000);
		expect(byInvoice.get(november)).toBe(50_000);
		expect(byInvoice.has(december)).toBe(false);
	});

	it('never allocates past an invoice amount and never past the payment amount', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Batas');
		const payer = await insertPayer('Warga Bayar Sebagian');
		const november = await insertInvoice(payer.unitId, '2025-11');
		const december = await insertInvoice(payer.unitId, '2025-12');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(150_000));

		await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId
		});

		const rows = await allocationsOf(paymentId);
		const total = rows.reduce((sum, row) => sum + row.amount, 0);
		expect(total).toBe(150_000);
		const byInvoice = new Map(rows.map((row) => [row.invoiceId, row.amount]));
		expect(byInvoice.get(november)).toBe(100_000);
		expect(byInvoice.get(december)).toBe(50_000);
	});

	it('never allocates to a cancelled Tagihan', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Batal');
		const payer = await insertPayer('Warga Tagihan Batal');
		const voided = await insertInvoice(payer.unitId, '2025-11');
		await testDb.db
			.update(invoices)
			.set({
				voidedAt: new Date(START),
				voidReason: 'Rumahnya sedang dibebaskan.',
				voidedBy: payer.residentId
			})
			.where(eq(invoices.id, voided));
		const standing = await insertInvoice(payer.unitId, '2025-12');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));

		await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId
		});

		const rows = await allocationsOf(paymentId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ invoiceId: standing, amount: 100_000 });
	});

	it('records exactly one audit row, naming the cash row and every allocation it made', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Beraudit');
		const payer = await insertPayer('Warga Verifikasi Beraudit');
		const invoiceId = await insertInvoice(payer.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(150_000));

		const outcome = await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId
		});

		const entries = await auditEntriesFor(testDb.db, paymentId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: admin.userId,
			action: PAYMENT_VERIFIED_ACTION,
			targetId: paymentId,
			before: { status: PAYMENT_STATUS.pending },
			after: {
				status: PAYMENT_STATUS.verified,
				cashTransactionId: outcome.cashTransaction.id,
				allocations: [{ invoiceId, amount: 100_000 }],
				unallocatedRemainder: 50_000
			}
		});
	});

	it('refuses a payment that has already been decided', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Dua Kali');
		const payer = await insertPayer('Warga Verifikasi Dua Kali');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));
		await verifyPayment(testDb.db, new FakeClock(START), { actorId: admin.userId, paymentId });

		const refusal: unknown = await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VerificationRuleError);
		expect(refusal).toMatchObject({ rule: VERIFICATION_RULE.alreadyDecided });
		// Still exactly one cash row for this unit's one verification: nothing was written twice.
		expect(await allocationsOf(paymentId)).toHaveLength(0);
	});

	it('answers an id that names no payment with the named 404', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Hilang');

		await expect(
			verifyPayment(testDb.db, new FakeClock(START), {
				actorId: admin.userId,
				paymentId: randomUUID()
			})
		).rejects.toThrow(PaymentNotFoundError);
	});

	it.each([
		{ label: 'a resident', role: undefined },
		{ label: 'a superuser who is not an admin', role: ROLE.superuser }
	])('refuses $label with PermissionDeniedError, before anything is read', async ({ role }) => {
		const callerId = role
			? await insertUserWithRole(`Bukan Pengurus ${role}`, role)
			: await insertUser('Bukan Pengurus Warga');
		const payer = await insertPayer(`Warga Ditolak ${role ?? 'resident'}`);
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));

		await expect(
			verifyPayment(testDb.db, new FakeClock(START), { actorId: callerId, paymentId })
		).rejects.toThrow(PermissionDeniedError);

		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.pending);
	});

	it('refuses an admin with no residents row, because verifiedBy has nowhere to point', async () => {
		const adminWithoutResident = await insertUserWithRole('Pengurus Tanpa Warga', ROLE.admin);
		const payer = await insertPayer('Warga Pengurus Tanpa Warga');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));

		const refusal: unknown = await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: adminWithoutResident,
			paymentId
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VerificationRuleError);
		expect(refusal).toMatchObject({ rule: VERIFICATION_RULE.actorNotRegistered });
		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.pending);
	});

	it('refuses an explicit invoice that is not one of the unit open invoices, and writes nothing', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Tagihan Asing');
		const payer = await insertPayer('Warga Tagihan Asing');
		await insertInvoice(payer.unitId, '2026-01');
		const otherHouse = await insertPayer('Warga Rumah Lain');
		const foreignInvoice = await insertInvoice(otherHouse.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));

		const refusal: unknown = await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId,
			invoiceIds: [foreignInvoice]
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VerificationRuleError);
		expect(refusal).toMatchObject({ rule: VERIFICATION_RULE.unknownInvoiceSelected });
		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.pending);
		expect(await allocationsOf(paymentId)).toHaveLength(0);
	});

	it('refuses money received in a locked Periode, leaving the payment pending and the book untouched', async () => {
		const admin = await insertAdmin('Pengurus Verifikasi Terkunci');
		const payer = await insertPayer('Warga Bulan Terkunci');
		await insertInvoice(payer.unitId, '2026-01');
		// A month of this test's own — this file's tests share one schema, and locking the month the
		// other tests date their money in would refuse every verification after this one.
		const paymentId = await insertPendingPayment(
			payer.unitId,
			payer.residentId,
			rupiah(100_000),
			'2026-01-15'
		);
		await testDb.db.transaction(async (transaction) => {
			await lockPeriod(transaction, new FakeClock(START), {
				actorId: admin.userId,
				year: 2026,
				month: 1,
				reason: 'Laporan bulan Januari sudah terbit.'
			});
		});

		await expect(
			verifyPayment(testDb.db, new FakeClock(START), { actorId: admin.userId, paymentId })
		).rejects.toThrow(PeriodLockedError);

		// The whole transaction rolled back: the status flip that ran before the period check is gone.
		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.pending);
		expect(await duesCashRowsFor(paymentId)).toHaveLength(0);
		expect(await allocationsOf(paymentId)).toHaveLength(0);
	});

	it('leaves the payment pending, with no cash row and no allocation, wherever a failure lands mid-verification', async () => {
		// The acceptance criterion verbatim: "kegagalan yang disuntikkan di tengah verifikasi
		// meninggalkan pembayaran tetap menunggu, tanpa transaksi kas dan tanpa alokasi". The clock is
		// read at every step of the transaction, so failing its n-th call in turn walks the failure
		// through every seam — after the status flip, inside the period row, at the cash row, at the
		// allocations, at the audit row — and each attempt must roll back to an untouched database.
		const admin = await insertAdmin('Pengurus Verifikasi Setengah Jalan');
		const payer = await insertPayer('Warga Verifikasi Setengah Jalan');
		await insertInvoice(payer.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(300_000));

		let failuresSeen = 0;
		let succeeded = false;
		// More attempts than the transaction has clock reads, so the loop always reaches success.
		for (let failAt = 1; failAt <= 10 && !succeeded; failAt += 1) {
			try {
				await verifyPayment(testDb.db, new FailingClock(failAt), {
					actorId: admin.userId,
					paymentId
				});
				succeeded = true;
			} catch (caught) {
				expect((caught as Error).message).toBe(CLOCK_FAILURE);
				failuresSeen += 1;

				expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.pending);
				expect(await duesCashRowsFor(paymentId)).toHaveLength(0);
				expect(await allocationsOf(paymentId)).toHaveLength(0);
			}
		}

		expect(failuresSeen).toBeGreaterThan(0);
		expect(succeeded).toBe(true);
		// And once nothing fails, the same request commits whole.
		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.verified);
		expect(await duesCashRowsFor(paymentId)).toHaveLength(1);
	});
});

describe('rejectPayment', () => {
	it('turns the payment down with a reason and moves no money at all', async () => {
		const admin = await insertAdmin('Pengurus Tolak Pembayaran');
		const payer = await insertPayer('Warga Ditolak Pembayarannya');
		await insertInvoice(payer.unitId, '2026-01');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));

		const rejected = await rejectPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId,
			reason: 'Nominalnya tidak cocok dengan mutasi bank.'
		});

		expect(rejected).toMatchObject({
			status: PAYMENT_STATUS.rejected,
			rejectionReason: 'Nominalnya tidak cocok dengan mutasi bank.',
			verifiedBy: null,
			verifiedAt: null
		});
		// "Tidak membentuk transaksi kas apa pun" — and no allocation either.
		expect(await duesCashRowsFor(paymentId)).toHaveLength(0);
		expect(await allocationsOf(paymentId)).toHaveLength(0);

		const entries = await auditEntriesFor(testDb.db, paymentId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: admin.userId,
			action: PAYMENT_REJECTED_ACTION,
			targetId: paymentId,
			after: {
				status: PAYMENT_STATUS.rejected,
				reason: 'Nominalnya tidak cocok dengan mutasi bank.'
			}
		});
	});

	it.each(['', '   '])(
		'refuses the reason %j, because the payer is owed the why',
		async (reason) => {
			const admin = await insertAdmin(`Pengurus Tolak Tanpa Alasan ${reason.length}`);
			const payer = await insertPayer(`Warga Tolak Tanpa Alasan ${reason.length}`);
			const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));

			const refusal: unknown = await rejectPayment(testDb.db, new FakeClock(START), {
				actorId: admin.userId,
				paymentId,
				reason
			}).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(VerificationRuleError);
			expect(refusal).toMatchObject({ rule: VERIFICATION_RULE.reasonMissing });
			expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.pending);
		}
	);

	it('refuses a payment that has already been verified', async () => {
		const admin = await insertAdmin('Pengurus Tolak Terverifikasi');
		const payer = await insertPayer('Warga Tolak Terverifikasi');
		const paymentId = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));
		await verifyPayment(testDb.db, new FakeClock(START), { actorId: admin.userId, paymentId });

		const refusal: unknown = await rejectPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId,
			reason: 'Terlambat menolak.'
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VerificationRuleError);
		expect(refusal).toMatchObject({ rule: VERIFICATION_RULE.alreadyDecided });
		expect((await paymentRow(paymentId)).status).toBe(PAYMENT_STATUS.verified);
	});
});

describe('recordCashPayment', () => {
	it('records the deposit already verified, through the exact same flow a transfer takes', async () => {
		const admin = await insertAdmin('Pengurus Terima Tunai');
		const payer = await insertPayer('Warga Setor Tunai');
		const invoiceId = await insertInvoice(payer.unitId, '2026-01');

		const outcome = await recordCashPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			unitId: payer.unitId,
			amount: rupiah(150_000),
			receivedOn: RECEIVED_ON
		});

		expect(outcome.payment).toMatchObject({
			unitId: payer.unitId,
			// User story 17: the admin typed the row, so the admin's residents row is the pencatat.
			recordedBy: admin.residentId,
			amount: 150_000,
			receivedOn: RECEIVED_ON,
			method: PAYMENT_METHOD.cash,
			// Money handed over in person has no transfer receipt to photograph.
			proofFileKey: null,
			status: PAYMENT_STATUS.verified,
			verifiedBy: admin.residentId
		});

		// The same three writes a transfer's verification makes: the cash row dated on the day the
		// money was received, the oldest-first allocation, and the saldo titipan as the difference.
		const cashRows = await duesCashRowsFor(outcome.payment.id);
		expect(cashRows).toHaveLength(1);
		expect(cashRows[0]).toMatchObject({ occurredOn: RECEIVED_ON, amount: 150_000 });
		const rows = await allocationsOf(outcome.payment.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ invoiceId, amount: 100_000 });
		expect(await creditBalanceOfUnit(testDb.db, payer.unitId)).toBe(50_000);

		// Two audit rows, exactly as a transfer's history reads: recorded, then verified.
		const entries = await auditEntriesFor(testDb.db, outcome.payment.id);
		expect(entries.map((entry) => entry.action).sort((a, b) => a.localeCompare(b))).toEqual([
			PAYMENT_RECORDED_ACTION,
			PAYMENT_VERIFIED_ACTION
		]);
	});

	it.each([
		{
			name: 'a zero amount',
			overrides: { amount: rupiah(0) },
			rule: VERIFICATION_RULE.amountNotPositive
		},
		{
			name: 'a day that is not on the calendar',
			overrides: { receivedOn: '2026-02-31' },
			rule: VERIFICATION_RULE.notACalendarDay
		},
		{
			name: 'a day that has not arrived',
			overrides: { receivedOn: '2027-01-01' },
			rule: VERIFICATION_RULE.receivedInTheFuture
		}
	])('refuses $name by name, and writes nothing at all', async ({ overrides, rule }) => {
		const admin = await insertAdmin(`Pengurus Tunai Tolak ${rule}`);
		const payer = await insertPayer(`Warga Tunai Tolak ${rule}`);
		const duesRowsBefore = (await allDuesCashRows()).length;

		const refusal: unknown = await recordCashPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			unitId: payer.unitId,
			amount: rupiah(150_000),
			receivedOn: RECEIVED_ON,
			...overrides
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(VerificationRuleError);
		expect(refusal).toMatchObject({ rule });
		expect(
			await testDb.db.select().from(payments).where(eq(payments.unitId, payer.unitId))
		).toHaveLength(0);
		expect((await allDuesCashRows()).length).toBe(duesRowsBefore);
	});

	it('refuses a unit that does not exist', async () => {
		const admin = await insertAdmin('Pengurus Tunai Rumah Hilang');

		await expect(
			recordCashPayment(testDb.db, new FakeClock(START), {
				actorId: admin.userId,
				unitId: randomUUID(),
				amount: rupiah(150_000),
				receivedOn: RECEIVED_ON
			})
		).rejects.toThrow(UnitNotFoundError);
	});

	it('refuses a resident with PermissionDeniedError', async () => {
		const residentId = await insertUser('Warga Coba Catat Tunai');
		const payer = await insertPayer('Warga Setoran Orang Lain');

		await expect(
			recordCashPayment(testDb.db, new FakeClock(START), {
				actorId: residentId,
				unitId: payer.unitId,
				amount: rupiah(150_000),
				receivedOn: RECEIVED_ON
			})
		).rejects.toThrow(PermissionDeniedError);
	});
});

describe('listPendingPayments', () => {
	it('answers the pending rows only, oldest first, each with its unit open invoices', async () => {
		const admin = await insertAdmin('Pengurus Baca Antrean');
		const payer = await insertPayer('Warga Antre');
		const invoiceId = await insertInvoice(payer.unitId, '2026-01');
		const older = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(100_000));
		// A later pending payment, and one of each decided kind that must stay off the queue.
		await testDb.db
			.update(payments)
			.set({ createdAt: new Date('2026-02-09T00:00:00.000Z') })
			.where(eq(payments.id, older));
		const newer = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(50_000));
		const verified = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(25_000));
		await verifyPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId: verified
		});
		const rejected = await insertPendingPayment(payer.unitId, payer.residentId, rupiah(10_000));
		await rejectPayment(testDb.db, new FakeClock(START), {
			actorId: admin.userId,
			paymentId: rejected,
			reason: 'Bukti tidak terbaca.'
		});

		const queue = await listPendingPayments(testDb.db, admin.userId);

		const ours = queue.filter((row) => row.unitId === payer.unitId);
		expect(ours.map((row) => row.paymentId)).toEqual([older, newer]);
		expect(ours[0]).toMatchObject({
			recordedByName: 'Warga Antre',
			amount: 100_000,
			receivedOn: RECEIVED_ON,
			method: PAYMENT_METHOD.transfer
		});
		// The invoice arrives with what the earlier verification already consumed accounted for.
		expect(ours[0].openInvoices).toEqual([
			expect.objectContaining({ invoiceId, allocatedAmount: 25_000, remainingAmount: 75_000 })
		]);
	});

	it('refuses a resident with PermissionDeniedError', async () => {
		const residentId = await insertUser('Warga Baca Antrean');

		await expect(listPendingPayments(testDb.db, residentId)).rejects.toThrow(PermissionDeniedError);
	});
});
