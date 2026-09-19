import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { invoices } from '$lib/server/db/schema/invoice';
import {
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	type PaymentStatus
} from '$lib/server/db/schema/payment';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import {
	PAYMENT_CANCELLED_ACTION,
	PAYMENT_RECORDED_ACTION,
	PAYMENT_RULE,
	PaymentRuleError,
	cancelOwnPayment,
	ownPayments,
	payableUnitsForUser,
	recordPayment,
	type RecordPaymentRequest
} from '$lib/server/services/dues/payment';

/**
 * A Warga recording that they have transferred money, and the line this ticket draws: the row is
 * written, and nothing else is. Against a real PostgreSQL, because "no cash transaction and no
 * allocation exist yet" is a statement about committed rows in other tables.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. Its UTC day is 2026-01-01. */
const START = '2026-01-01T00:00:00.000Z';

/** The day the money moved in most of these tests — comfortably in the past. */
const RECEIVED_ON = '2025-12-29';

/** The bytes a real JPEG starts with, followed by filler — enough for the signature check. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** One house, one resident living in it, and the account behind that resident. */
interface Household {
	readonly userId: string;
	readonly residentId: string;
	readonly unitId: string;
}

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

/** The `residents` row an account needs before it can own anything. */
async function insertResident(userId: string): Promise<string> {
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, phone: null, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One house. Block and number are unique together, so each test asks for its own. */
async function insertUnit(block: string, number: string): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block, number, createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** A stay: running by default, or ended on the day given, and starting long before the clock. */
async function insertOccupancy(
	unitId: string,
	residentId: string,
	endedOn: string | null = null,
	startedOn: string = '2025-01-01'
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn,
		endedOn,
		isPrimaryOccupant: false,
		createdAt: new Date(START)
	});
}

/** An account, its resident row, a house, and a running stay tying the three together. */
async function insertHousehold(name: string, block: string, number: string): Promise<Household> {
	const userId = await insertUser(name);
	const residentId = await insertResident(userId);
	const unitId = await insertUnit(block, number);
	await insertOccupancy(unitId, residentId);
	return { userId, residentId, unitId };
}

/** Records a payment with this file's defaults, overridden by whatever the test cares about. */
async function record(
	overrides: Partial<RecordPaymentRequest> & {
		readonly actorUserId: string;
		readonly unitId: string;
	},
	fileStore: FakeFileStore = new FakeFileStore(new FakeClock(START)),
	clock: FakeClock = new FakeClock(START)
) {
	return recordPayment(testDb.db, clock, fileStore, {
		amount: rupiah(150_000),
		receivedOn: RECEIVED_ON,
		proof: { contentType: 'image/jpeg', content: JPEG },
		...overrides
	});
}

/** Moves a payment out of `pending` the way verification or rejection would. */
async function decide(paymentId: string, status: PaymentStatus, verifierId: string): Promise<void> {
	if (status === PAYMENT_STATUS.verified) {
		await testDb.db
			.update(payments)
			// One statement, because `payments_verification_check` refuses the two halves apart.
			.set({ status, verifiedBy: verifierId, verifiedAt: new Date(START) })
			.where(eq(payments.id, paymentId));
		return;
	}
	await testDb.db
		.update(payments)
		.set({ status, rejectionReason: 'Nominalnya tidak cocok dengan mutasi bank.' })
		.where(eq(payments.id, paymentId));
}

describe('recordPayment', () => {
	it('writes one pending Pembayaran and moves no money at all', async () => {
		const household = await insertHousehold('Warga Catat Transfer', 'A', '1');
		const fileStore = new FakeFileStore(new FakeClock(START));

		const recorded = await record(
			{ actorUserId: household.userId, unitId: household.unitId },
			fileStore
		);

		expect(recorded).toMatchObject({
			unitId: household.unitId,
			recordedBy: household.residentId,
			amount: 150_000,
			receivedOn: RECEIVED_ON,
			// A resident has nobody to hand cash to through a web form.
			method: PAYMENT_METHOD.transfer,
			status: PAYMENT_STATUS.pending,
			rejectionReason: null,
			verifiedBy: null,
			verifiedAt: null,
			proofFileKey: `payments/${recorded.id}/proof.jpg`
		});
		expect(recorded.createdAt.getTime()).toBe(Date.parse(START));

		// The whole point of this ticket: recorded is not received. Both tables are still empty, so
		// neither saldo kas nor the status of any Tagihan has moved.
		expect(await testDb.db.select().from(cashTransactions)).toHaveLength(0);
		expect(await testDb.db.select().from(allocations)).toHaveLength(0);
	});

	it('records who did it, against the account rather than the residents row', async () => {
		const household = await insertHousehold('Warga Catat Beraudit', 'A', '2');

		const recorded = await record({
			actorUserId: household.userId,
			unitId: household.unitId
		});

		const entries = await auditEntriesFor(testDb.db, recorded.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: household.userId,
			action: PAYMENT_RECORDED_ACTION,
			targetId: recorded.id,
			after: { amount: 150_000, receivedOn: RECEIVED_ON, status: PAYMENT_STATUS.pending }
		});
	});

	it.each([rupiah(0), rupiah(-1)])(
		'refuses the amount %i at the service layer, which the database would have accepted',
		async (amount: Rupiah) => {
			// `payments_amount_check` is `amount >= 0`, so zero passes the database. The acceptance
			// criterion asks for it to be refused here, and here is where it is.
			const household = await insertHousehold(`Warga Nominal ${amount}`, 'B', String(amount));

			const refusal: unknown = await record({
				actorUserId: household.userId,
				unitId: household.unitId,
				amount
			}).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(PaymentRuleError);
			expect(refusal).toMatchObject({ rule: PAYMENT_RULE.amountNotPositive });
			expect(
				await testDb.db.select().from(payments).where(eq(payments.unitId, household.unitId))
			).toHaveLength(0);
		}
	);

	it.each(['29 Desember 2025', '2025-02-31'])(
		'refuses "%s", which is not a day on the calendar',
		async (receivedOn) => {
			const household = await insertHousehold(`Warga Tanggal ${receivedOn}`, 'C', receivedOn);

			const refusal: unknown = await record({
				actorUserId: household.userId,
				unitId: household.unitId,
				receivedOn
			}).catch((error: unknown) => error);

			expect(refusal).toMatchObject({ rule: PAYMENT_RULE.notACalendarDay });
		}
	);

	it('refuses a transfer dated after tomorrow, and accepts tomorrow itself', async () => {
		// The clock reads 2026-01-01 in UTC and the complex is at UTC+7, so the local day can already
		// be the 2nd while UTC still says the 1st. One day of slack is deliberate; two is a typo.
		const household = await insertHousehold('Warga Tanggal Depan', 'D', '1');

		const refusal: unknown = await record({
			actorUserId: household.userId,
			unitId: household.unitId,
			receivedOn: '2026-01-03'
		}).catch((error: unknown) => error);
		expect(refusal).toMatchObject({ rule: PAYMENT_RULE.receivedInTheFuture });

		const accepted = await record({
			actorUserId: household.userId,
			unitId: household.unitId,
			receivedOn: '2026-01-02'
		});
		expect(accepted.receivedOn).toBe('2026-01-02');
	});

	it('refuses a house the payer does not live in, and writes nothing', async () => {
		const mine = await insertHousehold('Warga Rumah Sendiri', 'E', '1');
		const theirs = await insertHousehold('Warga Rumah Tetangga', 'E', '2');
		const fileStore = new FakeFileStore(new FakeClock(START));

		await expect(
			record({ actorUserId: mine.userId, unitId: theirs.unitId }, fileStore)
		).rejects.toThrow(PermissionDeniedError);

		expect(
			await testDb.db.select().from(payments).where(eq(payments.unitId, theirs.unitId))
		).toHaveLength(0);
		// Refused before the upload, so no orphan blob is left behind either.
		expect(fileStore.keys).toEqual([]);
	});

	it('refuses a house the payer has moved out of', async () => {
		const userId = await insertUser('Warga Sudah Pindah');
		const residentId = await insertResident(userId);
		const unitId = await insertUnit('F', '1');
		await insertOccupancy(unitId, residentId, '2025-11-30');

		await expect(record({ actorUserId: userId, unitId })).rejects.toThrow(PermissionDeniedError);
	});

	it('accepts a payer whose move-out date has been written but has not arrived', async () => {
		// `isStillRunningOn` is `ended_on is null or ended_on >= today`, not `ended_on is null`. Somebody
		// who told the pengurus in December that they leave in March still lives there in January, and
		// still owes January's dues.
		const userId = await insertUser('Warga Pindah Nanti');
		const residentId = await insertResident(userId);
		const unitId = await insertUnit('F', '2');
		await insertOccupancy(unitId, residentId, '2026-03-31');

		const recorded = await record({ actorUserId: userId, unitId });

		expect(recorded.unitId).toBe(unitId);
	});

	it('refuses an account that has no residents row at all', async () => {
		// The normal state of somebody who signed up and is waiting to be admitted. There is nobody to
		// attribute the payment to, and no house of theirs to attribute it against.
		const userId = await insertUser('Warga Belum Disetujui');
		const unitId = await insertUnit('G', '1');

		await expect(record({ actorUserId: userId, unitId })).rejects.toThrow(PermissionDeniedError);
	});
});

describe('ownPayments', () => {
	it('lists only the caller’s own payments, newest first, with the reason one was turned down', async () => {
		const mine = await insertHousehold('Warga Daftar Sendiri', 'H', '1');
		const theirs = await insertHousehold('Warga Daftar Tetangga', 'H', '2');
		const older = await record({ actorUserId: mine.userId, unitId: mine.unitId });
		// An hour later, so that "newest first" is a claim about `createdAt` rather than about which
		// random uuid happened to sort higher.
		const newer = await record(
			{ actorUserId: mine.userId, unitId: mine.unitId, amount: rupiah(300_000) },
			new FakeFileStore(new FakeClock(START)),
			new FakeClock('2026-01-01T01:00:00.000Z')
		);
		await record({ actorUserId: theirs.userId, unitId: theirs.unitId });
		await decide(older.id, PAYMENT_STATUS.rejected, mine.residentId);

		const listed = await ownPayments(testDb.db, mine.userId);

		expect(listed.map((payment) => payment.paymentId)).toEqual([newer.id, older.id]);
		expect(listed[0]).toMatchObject({
			amount: 300_000,
			block: 'H',
			number: '1',
			status: PAYMENT_STATUS.pending,
			rejectionReason: null,
			canCancel: true
		});
		expect(listed[1]).toMatchObject({
			status: PAYMENT_STATUS.rejected,
			rejectionReason: 'Nominalnya tidak cocok dengan mutasi bank.',
			// A decided payment is no longer the payer's to withdraw.
			canCancel: false
		});
		// The key, never a URL: the page that renders it mints the short-lived link itself.
		expect(listed[0].proofFileKey).toBe(`payments/${newer.id}/proof.jpg`);
	});
});

describe('payableUnitsForUser', () => {
	it('offers every house the caller lives in today with its un-cancelled Tagihan, oldest first', async () => {
		const household = await insertHousehold('Warga Pilih Tagihan', 'I', '1');
		const [january, february, cancelled] = await testDb.db
			.insert(invoices)
			.values([
				{
					unitId: household.unitId,
					period: '2026-01',
					amount: rupiah(150_000),
					dueDate: '2026-01-05',
					issuedAt: new Date(START)
				},
				{
					unitId: household.unitId,
					period: '2025-12',
					amount: rupiah(150_000),
					dueDate: '2025-12-05',
					issuedAt: new Date(START)
				},
				{
					unitId: household.unitId,
					period: '2025-11',
					amount: rupiah(150_000),
					dueDate: '2025-11-05',
					issuedAt: new Date(START),
					voidedAt: new Date(START),
					voidReason: 'Rumah sedang bebas tagih.',
					voidedBy: household.residentId
				}
			])
			.returning();

		const offered = await payableUnitsForUser(testDb.db, new FakeClock(START), household.userId);

		expect(offered).toHaveLength(1);
		expect(offered[0]).toMatchObject({ unitId: household.unitId, block: 'I', number: '1' });
		// Oldest period first, and the cancelled Tagihan is not an obligation any more.
		expect(offered[0].invoices.map((invoice) => invoice.invoiceId)).toEqual([
			february.id,
			january.id
		]);
		expect(offered[0].invoices.map((invoice) => invoice.invoiceId)).not.toContain(cancelled.id);
		// No lunas, sebagian or menunggak figure anywhere on it: that arithmetic belongs to #27.
		expect(Object.keys(offered[0].invoices[0]).sort()).toEqual([
			'amount',
			'dueDate',
			'invoiceId',
			'period'
		]);
	});

	it('leaves out a Tagihan issued before the payer moved in, and keeps the one inside their stay', async () => {
		// `docs/spec-iuran-v1.md`: "Warga hanya melihat tagihan yang terbit dalam rentang masa
		// huninya". A Tagihan from before this resident moved in is the *previous* occupant's
		// obligation, and offering it in the picker discloses its period and its amount. The two
		// invoices below differ only in whether their period falls inside the stay, so this test fails
		// if the occupancy filter is ever dropped — it would then find both.
		const userId = await insertUser('Warga Tagihan Penghuni Lama');
		const residentId = await insertResident(userId);
		const unitId = await insertUnit('I', '4');
		await insertOccupancy(unitId, residentId, null, '2025-12-01');

		const [previousOccupants, theirOwn] = await testDb.db
			.insert(invoices)
			.values([
				{
					unitId,
					period: '2025-10',
					amount: rupiah(150_000),
					dueDate: '2025-10-05',
					issuedAt: new Date(START)
				},
				{
					unitId,
					period: '2025-12',
					amount: rupiah(150_000),
					dueDate: '2025-12-05',
					issuedAt: new Date(START)
				}
			])
			.returning();

		const offered = await payableUnitsForUser(testDb.db, new FakeClock(START), userId);

		expect(offered).toHaveLength(1);
		// `firstDayOfPeriod('2025-10')` is 2025-10-01, which is outside the stay that starts on
		// 2025-12-01; `firstDayOfPeriod('2025-12')` is 2025-12-01, its first day.
		expect(offered[0].invoices.map((invoice) => invoice.invoiceId)).toEqual([theirOwn.id]);
		expect(offered[0].invoices.map((invoice) => invoice.invoiceId)).not.toContain(
			previousOccupants.id
		);
		expect(offered[0].invoices.map((invoice) => invoice.period)).not.toContain('2025-10');
	});

	it('offers one entry per house even when the payer holds two running stays in it', async () => {
		// `occupancies` has no unique pair on unit and resident, so a superuser can record the same
		// person twice for one house — an owner row beside a tenant row, or a plain duplicate. Two
		// entries here would be a duplicate key in the form's `{#each}` and every Tagihan listed twice.
		const household = await insertHousehold('Warga Dua Masa Huni', 'I', '3');
		await insertOccupancy(household.unitId, household.residentId);
		await testDb.db.insert(invoices).values({
			unitId: household.unitId,
			period: '2026-01',
			amount: rupiah(150_000),
			dueDate: '2026-01-05',
			issuedAt: new Date(START)
		});

		const offered = await payableUnitsForUser(testDb.db, new FakeClock(START), household.userId);

		expect(offered).toHaveLength(1);
		expect(offered[0].invoices).toHaveLength(1);
	});

	it('offers nothing to somebody whose stay is over', async () => {
		const userId = await insertUser('Warga Pilih Setelah Pindah');
		const residentId = await insertResident(userId);
		const unitId = await insertUnit('I', '2');
		await insertOccupancy(unitId, residentId, '2025-10-31');

		expect(await payableUnitsForUser(testDb.db, new FakeClock(START), userId)).toEqual([]);
	});
});

describe('cancelOwnPayment', () => {
	it('deletes the pending row and its proof, leaving the audit entry behind as the only trace', async () => {
		// `CONTEXT.md` names exactly three Pembayaran statuses, so a fourth one marking a withdrawal is
		// a concept this ticket may not invent. A pending row has no allocation and no cash transaction
		// pointing at it, so deleting it restores the state exactly.
		const household = await insertHousehold('Warga Batalkan', 'J', '1');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const recorded = await record(
			{ actorUserId: household.userId, unitId: household.unitId },
			fileStore
		);
		expect(fileStore.keys).toHaveLength(1);

		// An hour later, so that the two audit entries carry different instants. `auditEntriesFor`
		// orders by `occurredAt` descending, and a frozen clock would give both the same one and leave
		// the order to whatever the heap happened to return.
		const cancelled = await cancelOwnPayment(
			testDb.db,
			new FakeClock('2026-01-01T01:00:00.000Z'),
			fileStore,
			{ actorUserId: household.userId, paymentId: recorded.id }
		);

		expect(cancelled.id).toBe(recorded.id);
		expect(await testDb.db.select().from(payments).where(eq(payments.id, recorded.id))).toEqual([]);
		expect(fileStore.keys).toEqual([]);

		// `audit_log.targetId` is plain text with no foreign key, so the entry outlives the row.
		// Newest first, which is the order `auditEntriesFor` documents.
		const entries = await auditEntriesFor(testDb.db, recorded.id);
		expect(entries.map((entry) => entry.action)).toEqual([
			PAYMENT_CANCELLED_ACTION,
			PAYMENT_RECORDED_ACTION
		]);
		expect(entries[0]).toMatchObject({
			actorId: household.userId,
			action: PAYMENT_CANCELLED_ACTION,
			before: { amount: 150_000, status: PAYMENT_STATUS.pending }
		});
	});

	it('refuses a payment somebody else recorded, and leaves it exactly where it was', async () => {
		const mine = await insertHousehold('Warga Batalkan Sendiri', 'K', '1');
		const theirs = await insertHousehold('Warga Batalkan Tetangga', 'K', '2');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const recorded = await record({ actorUserId: theirs.userId, unitId: theirs.unitId }, fileStore);

		await expect(
			cancelOwnPayment(testDb.db, new FakeClock(START), fileStore, {
				actorUserId: mine.userId,
				paymentId: recorded.id
			})
		).rejects.toThrow(PermissionDeniedError);

		expect(
			await testDb.db.select().from(payments).where(eq(payments.id, recorded.id))
		).toHaveLength(1);
		expect(fileStore.keys).toHaveLength(1);
	});

	it('answers an id that names no payment with the same refusal, and never a different one', async () => {
		// Telling "not yours" apart from "no such row" would make this an oracle for whether a given
		// id is a real payment.
		const household = await insertHousehold('Warga Batalkan Hantu', 'L', '1');

		await expect(
			cancelOwnPayment(testDb.db, new FakeClock(START), new FakeFileStore(new FakeClock(START)), {
				actorUserId: household.userId,
				paymentId: randomUUID()
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	it.each([PAYMENT_STATUS.verified, PAYMENT_STATUS.rejected])(
		'refuses to withdraw a payment that is already "%s", and keeps its proof',
		async (status) => {
			const household = await insertHousehold(`Warga Batalkan ${status}`, 'M', status);
			const fileStore = new FakeFileStore(new FakeClock(START));
			const recorded = await record(
				{ actorUserId: household.userId, unitId: household.unitId },
				fileStore
			);
			await decide(recorded.id, status, household.residentId);

			const refusal: unknown = await cancelOwnPayment(testDb.db, new FakeClock(START), fileStore, {
				actorUserId: household.userId,
				paymentId: recorded.id
			}).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(PaymentRuleError);
			expect(refusal).toMatchObject({ rule: PAYMENT_RULE.alreadyDecided });
			expect(
				await testDb.db.select().from(payments).where(eq(payments.id, recorded.id))
			).toHaveLength(1);
			expect(fileStore.keys).toHaveLength(1);
		}
	);
});
