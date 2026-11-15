import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '#lib/errors.ts';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { auditEntriesFor, recordAuditEntry } from '#lib/server/audit.ts';
import { allocations } from '#lib/server/db/schema/allocation.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles, type Role } from '#lib/server/db/schema/authz.ts';
import { invoices } from '#lib/server/db/schema/invoice.ts';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '#lib/server/db/schema/payment.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { units } from '#lib/server/db/schema/unit.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import * as allocationReleasePath from '#lib/server/services/dues/allocation-release.ts';
import { correctionsHistoryFor } from '#lib/server/services/dues/corrections-history.ts';
import * as creditRefundPath from '#lib/server/services/dues/credit-refund.ts';
import * as duesCorrection from '#lib/server/services/dues/dues-correction.ts';
import {
	ALLOCATION_RELEASED_ACTION,
	CREDIT_REFUNDED_ACTION,
	DUES_CORRECTION_ACTIONS,
	INVOICE_VOIDED_ACTION,
	REFUND_RULE,
	RELEASE_RULE,
	RefundRuleError,
	ReleaseRuleError,
	VOID_RULE,
	VoidRuleError,
	duesCorrectionSummary,
	readDuesCorrectionRecord,
	refundCredit,
	releaseAllocation,
	voidInvoice,
	type DuesCorrectionRecord,
	type StoredDuesCorrectionRow
} from '#lib/server/services/dues/dues-correction.ts';
import * as invoiceVoidPath from '#lib/server/services/dues/invoice-void.ts';

/**
 * The dues-correction module (#324, spec #308 decision 4): Pembatalan Tagihan, Pelepasan Alokasi
 * and Pengembalian behind one module, sharing one right, one reason rule and one typed Audit Log
 * record per action, and the corrections history reading those records through the same types.
 *
 * The history is read here from records the three actions really wrote, never from rows a test
 * made up: a field renamed in a record type is a compile error in the writer, in the record's check
 * and in its history summary, and a writer and reader that disagreed at run time would fail the
 * first test below. Each action's own refusals stay in its own file (`invoice-void.test.ts`,
 * `allocation-release.test.ts`, `credit-refund.test.ts`); this file holds what the three share.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. Its UTC day is 2026-03-10. */
const START = '2026-03-10T09:00:00.000Z';

/** One minute, for spacing the three corrections so the history has one order to show. */
const MINUTE = 60 * 1000;

/** The day the refunded money in this file was handed back. */
const REFUND_DAY = '2026-03-08';

const VOID_REASON = 'Tagihan terbit untuk rumah yang sedang dibebaskan.';
const RELEASE_REASON = 'Uangnya untuk bulan lain; peruntukannya salah pilih.';
const REFUND_REASON = 'Masa huninya berakhir dan saldo titipannya dikembalikan.';

/** The display name of the superuser who makes every correction in this file. */
const ACTOR_NAME = 'Pengurus Koreksi Iuran';

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

/** A superuser with a `residents` row, which a cancellation needs for `invoices.voidedBy`. */
async function insertRegisteredSuperuser(name: string): Promise<string> {
	const id = await insertUserWithRole(name, ROLE.superuser);
	await testDb.db.insert(residents).values({ userId: id, createdAt: new Date(START) });
	return id;
}

/** One house. Returns its id. */
async function insertUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'KR', number: unique('1'), createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One standing Tagihan. Returns its id. */
async function insertInvoice(unitId: string, period: string, amount: Rupiah): Promise<string> {
	const [row] = await testDb.db
		.insert(invoices)
		.values({ unitId, period, amount, dueDate: `${period}-05`, issuedAt: new Date(START) })
		.returning();
	return row.id;
}

/** One verified Pembayaran of `amount`, with the resident behind it. Returns its id. */
async function insertVerifiedPayment(unitId: string, amount: Rupiah): Promise<string> {
	const userId = await insertUser('Warga Koreksi Iuran');
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

/** One Alokasi, written directly as domain set-up. Returns its id. */
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

/**
 * One house that goes through all three corrections, a minute apart, every reason padded with
 * spaces: a Rp120.000 Tagihan for February cancelled, a Rp150.000 Alokasi of a Rp200.000
 * Pembayaran released, and Rp80.000 of the Saldo Titipan that leaves returned. Three different
 * amounts, so the history can only show each one by reading it from the right record and field.
 */
async function correctOneHouse() {
	const actorId = await insertRegisteredSuperuser(ACTOR_NAME);
	const unitId = await insertUnit();
	const voidedInvoiceId = await insertInvoice(unitId, '2026-02', rupiah(120_000));
	const paidInvoiceId = await insertInvoice(unitId, '2026-03', rupiah(150_000));
	const paymentId = await insertVerifiedPayment(unitId, rupiah(200_000));
	const allocationId = await insertAllocation(paymentId, paidInvoiceId, rupiah(150_000));
	const clock = new FakeClock(START);

	await voidInvoice(testDb.db, clock, {
		actorId,
		invoiceId: voidedInvoiceId,
		reason: `  ${VOID_REASON}  `
	});
	clock.advance(MINUTE);
	await releaseAllocation(testDb.db, clock, {
		actorId,
		allocationId,
		reason: `  ${RELEASE_REASON}  `
	});
	clock.advance(MINUTE);
	const refund = await refundCredit(testDb.db, clock, {
		actorId,
		unitId,
		amount: rupiah(80_000),
		occurredOn: REFUND_DAY,
		reason: `  ${REFUND_REASON}  `
	});

	return {
		actorId,
		unitId,
		voidedInvoiceId,
		paidInvoiceId,
		paymentId,
		allocationId,
		refundCashTransactionId: refund.portions[0].cashTransaction.id
	};
}

/** The one audit row filed against `targetId`. */
async function onlyAuditRowOf(targetId: string) {
	const entries = await auditEntriesFor(testDb.db, targetId);
	expect(entries).toHaveLength(1);
	return entries[0];
}

describe('the corrections history', () => {
	it('reads the records the three actions really wrote, newest first, one Unit only', async () => {
		const house = await correctOneHouse();
		// A correction on another house, which must not reach this house's history.
		const otherActorId = await insertRegisteredSuperuser('Pengurus Rumah Lain');
		const otherUnitId = await insertUnit();
		await voidInvoice(testDb.db, new FakeClock(START), {
			actorId: otherActorId,
			invoiceId: await insertInvoice(otherUnitId, '2026-02', rupiah(99_000)),
			reason: 'Rumah lain.'
		});

		const history = await correctionsHistoryFor(testDb.db, house.actorId, house.unitId);

		expect(
			history.map((entry) => ({
				action: entry.action,
				occurredAt: entry.occurredAt.toISOString(),
				actorName: entry.actorName,
				reason: entry.reason,
				amount: entry.amount,
				period: entry.period
			}))
		).toEqual([
			{
				action: CREDIT_REFUNDED_ACTION,
				occurredAt: '2026-03-10T09:02:00.000Z',
				actorName: ACTOR_NAME,
				reason: REFUND_REASON,
				amount: 80_000,
				period: null
			},
			{
				action: ALLOCATION_RELEASED_ACTION,
				occurredAt: '2026-03-10T09:01:00.000Z',
				actorName: ACTOR_NAME,
				reason: RELEASE_REASON,
				// The released Alokasi's amount, which its record keeps in `before`.
				amount: 150_000,
				period: null
			},
			{
				action: INVOICE_VOIDED_ACTION,
				occurredAt: '2026-03-10T09:00:00.000Z',
				actorName: ACTOR_NAME,
				reason: VOID_REASON,
				amount: 120_000,
				period: '2026-02'
			}
		]);

		// Each entry is keyed by the audit row it was read from.
		expect(history.map((entry) => entry.id)).toEqual([
			(await onlyAuditRowOf(house.unitId)).id,
			(await onlyAuditRowOf(house.allocationId)).id,
			(await onlyAuditRowOf(house.voidedInvoiceId)).id
		]);
	});

	it('reads every stored row back as exactly the record its writer wrote', async () => {
		const house = await correctOneHouse();

		const voided = readDuesCorrectionRecord(await onlyAuditRowOf(house.voidedInvoiceId));
		const released = readDuesCorrectionRecord(await onlyAuditRowOf(house.allocationId));
		const refunded = readDuesCorrectionRecord(await onlyAuditRowOf(house.unitId));

		expect(voided).toEqual({
			action: INVOICE_VOIDED_ACTION,
			targetId: house.voidedInvoiceId,
			before: { voidedAt: null },
			after: {
				unitId: house.unitId,
				period: '2026-02',
				amount: rupiah(120_000),
				reason: VOID_REASON
			}
		} satisfies DuesCorrectionRecord);
		expect(released).toEqual({
			action: ALLOCATION_RELEASED_ACTION,
			targetId: house.allocationId,
			before: {
				paymentId: house.paymentId,
				invoiceId: house.paidInvoiceId,
				amount: rupiah(150_000),
				createdAt: START
			},
			after: { unitId: house.unitId, reason: RELEASE_REASON }
		} satisfies DuesCorrectionRecord);
		expect(refunded).toEqual({
			action: CREDIT_REFUNDED_ACTION,
			targetId: house.unitId,
			before: null,
			after: {
				unitId: house.unitId,
				amount: rupiah(80_000),
				occurredOn: REFUND_DAY,
				reason: REFUND_REASON,
				refunds: [
					{
						paymentId: house.paymentId,
						cashTransactionId: house.refundCashTransactionId,
						amount: rupiah(80_000)
					}
				]
			}
		} satisfies DuesCorrectionRecord);
	});

	it('still lists a row that is not its action record, with the blank fields the old reader showed', async () => {
		// Unreachable through the module's writers; written straight through the audit module to
		// prove the history neither hides the row nor hands the screen an `undefined`.
		const actorId = await insertRegisteredSuperuser('Pengurus Baris Rusak');
		const unitId = await insertUnit();
		await recordAuditEntry(testDb.db, new FakeClock(START), {
			actorId,
			action: INVOICE_VOIDED_ACTION,
			targetId: randomUUID(),
			before: { voidedAt: null },
			after: { unitId, period: '2026-02', amount: 120_000, reason: 42 }
		});

		const history = await correctionsHistoryFor(testDb.db, actorId, unitId);

		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			action: INVOICE_VOIDED_ACTION,
			reason: '',
			amount: null,
			period: null
		});
	});

	it('asks for exactly the three actions this module writes', () => {
		expect([...DUES_CORRECTION_ACTIONS].sort()).toEqual(
			[ALLOCATION_RELEASED_ACTION, CREDIT_REFUNDED_ACTION, INVOICE_VOIDED_ACTION].sort()
		);
	});
});

describe('readDuesCorrectionRecord — every field checked against its record type', () => {
	/** A well-formed Pembatalan Tagihan row, for bending one field at a time. */
	function voidedRow(after: Record<string, unknown>, before: unknown = { voidedAt: null }) {
		return {
			action: INVOICE_VOIDED_ACTION,
			targetId: 'tagihan',
			before,
			after: { unitId: 'rumah', period: '2026-02', amount: 120_000, reason: 'alasan', ...after }
		} satisfies StoredDuesCorrectionRow;
	}

	/** A well-formed Pengembalian row with one portion, for bending the portion. */
	function refundedRow(portion: Record<string, unknown>): StoredDuesCorrectionRow {
		return {
			action: CREDIT_REFUNDED_ACTION,
			targetId: 'rumah',
			before: null,
			after: {
				unitId: 'rumah',
				amount: 80_000,
				occurredOn: REFUND_DAY,
				reason: 'alasan',
				refunds: [{ paymentId: 'bayar', cashTransactionId: 'kas', amount: 80_000, ...portion }]
			}
		};
	}

	it('reads a well-formed row, and ignores a field its type does not declare', () => {
		expect(readDuesCorrectionRecord(voidedRow({}))).toBeDefined();
		expect(readDuesCorrectionRecord(voidedRow({ catatan: 'tambahan' }))).toBeDefined();
		expect(readDuesCorrectionRecord(refundedRow({}))).toBeDefined();
	});

	it.each([
		{ what: 'a missing reason', row: voidedRow({ reason: undefined }) },
		{ what: 'a reason that is not text', row: voidedRow({ reason: 42 }) },
		{ what: 'an amount written as text', row: voidedRow({ amount: '120000' }) },
		{ what: 'a fractional amount', row: voidedRow({ amount: 120_000.5 }) },
		{ what: 'a before that is not the record', row: voidedRow({}, null) },
		{ what: 'an after that is an array', row: { ...voidedRow({}), after: [] } },
		{
			what: 'an action this module does not write',
			row: { ...voidedRow({}), action: 'role_change' }
		}
	])('reads $what as no record', ({ row }) => {
		expect(readDuesCorrectionRecord(row)).toBeUndefined();
	});

	it('checks every portion of a Pengembalian', () => {
		expect(readDuesCorrectionRecord(refundedRow({ amount: '80000' }))).toBeUndefined();
		expect(readDuesCorrectionRecord(refundedRow({ cashTransactionId: null }))).toBeUndefined();
	});

	it("summarises each record by its own action's fields", () => {
		const voided = readDuesCorrectionRecord(voidedRow({}));
		expect(voided && duesCorrectionSummary(voided)).toEqual({ amount: 120_000, period: '2026-02' });
		const refunded = readDuesCorrectionRecord(refundedRow({}));
		expect(refunded && duesCorrectionSummary(refunded)).toEqual({ amount: 80_000, period: null });
	});
});

/** One of the three actions, run against fresh rows, as the shared-run table below drives it. */
interface CorrectionCase {
	readonly name: string;
	/** The error class this action refuses an empty reason with, and the rule it names. */
	readonly reasonError: abstract new (...args: never[]) => Error;
	readonly rule: string;
	/** Arranges fresh rows and answers a run of the action for an actor and a reason. */
	readonly arrange: () => Promise<{
		readonly unitId: string;
		readonly run: (actorId: string, reason: string) => Promise<unknown>;
		/** The same action asked with one of its own rules also broken, besides the reason. */
		readonly runBrokenTwice: (actorId: string, reason: string) => Promise<unknown>;
	}>;
}

const CASES: readonly CorrectionCase[] = [
	{
		name: 'Pembatalan Tagihan',
		reasonError: VoidRuleError,
		rule: VOID_RULE.reasonMissing,
		arrange: async () => {
			const unitId = await insertUnit();
			const invoiceId = await insertInvoice(unitId, '2026-02', rupiah(120_000));
			return {
				unitId,
				run: (actorId, reason) =>
					voidInvoice(testDb.db, new FakeClock(START), { actorId, invoiceId, reason }),
				// A Tagihan that does not exist.
				runBrokenTwice: (actorId, reason) =>
					voidInvoice(testDb.db, new FakeClock(START), {
						actorId,
						invoiceId: randomUUID(),
						reason
					})
			};
		}
	},
	{
		name: 'Pelepasan Alokasi',
		reasonError: ReleaseRuleError,
		rule: RELEASE_RULE.reasonMissing,
		arrange: async () => {
			const unitId = await insertUnit();
			const allocationId = await insertAllocation(
				await insertVerifiedPayment(unitId, rupiah(150_000)),
				await insertInvoice(unitId, '2026-03', rupiah(150_000)),
				rupiah(150_000)
			);
			return {
				unitId,
				run: (actorId, reason) =>
					releaseAllocation(testDb.db, new FakeClock(START), { actorId, allocationId, reason }),
				// An Alokasi that does not exist.
				runBrokenTwice: (actorId, reason) =>
					releaseAllocation(testDb.db, new FakeClock(START), {
						actorId,
						allocationId: randomUUID(),
						reason
					})
			};
		}
	},
	{
		name: 'Pengembalian',
		reasonError: RefundRuleError,
		rule: REFUND_RULE.reasonMissing,
		arrange: async () => {
			const unitId = await insertUnit();
			await insertVerifiedPayment(unitId, rupiah(100_000));
			return {
				unitId,
				run: (actorId, reason) =>
					refundCredit(testDb.db, new FakeClock(START), {
						actorId,
						unitId,
						amount: rupiah(50_000),
						occurredOn: REFUND_DAY,
						reason
					}),
				// An amount that is not positive.
				runBrokenTwice: (actorId, reason) =>
					refundCredit(testDb.db, new FakeClock(START), {
						actorId,
						unitId,
						amount: rupiah(0),
						occurredOn: REFUND_DAY,
						reason
					})
			};
		}
	}
];

describe('the run every dues correction shares', () => {
	it.each(CASES)(
		'$name: refuses anyone but a superuser before it reads the reason, and writes nothing',
		async ({ arrange }) => {
			const { unitId, run } = await arrange();
			const adminId = await insertUserWithRole('Pengurus Harian Koreksi', ROLE.admin);
			const superuserId = await insertRegisteredSuperuser('Pengurus Koreksi Pembaca');

			await expect(run(adminId, REFUND_REASON)).rejects.toThrow(PermissionDeniedError);
			// An empty reason too: the right is checked first.
			await expect(run(adminId, '   ')).rejects.toThrow(PermissionDeniedError);
			expect(await correctionsHistoryFor(testDb.db, superuserId, unitId)).toEqual([]);
		}
	);

	it.each(CASES)(
		'$name: refuses an empty reason with its own rule, before any rule of its own',
		async ({ arrange, reasonError, rule }) => {
			const { unitId, run, runBrokenTwice } = await arrange();
			const superuserId = await insertRegisteredSuperuser('Pengurus Koreksi Tanpa Alasan');

			for (const attempt of [run, runBrokenTwice]) {
				const refusal: unknown = await attempt(superuserId, ' \t ').catch(
					(error: unknown) => error
				);
				expect(refusal).toBeInstanceOf(reasonError);
				expect(refusal).toMatchObject({ rule });
			}
			expect(await correctionsHistoryFor(testDb.db, superuserId, unitId)).toEqual([]);
		}
	);

	it.each(CASES)(
		'$name: leaves exactly one record, which reads back as its type',
		async ({ arrange }) => {
			const { unitId, run } = await arrange();
			const superuserId = await insertRegisteredSuperuser('Pengurus Koreksi Satu Catatan');

			await run(superuserId, `  ${REFUND_REASON}  `);

			const history = await correctionsHistoryFor(testDb.db, superuserId, unitId);
			expect(history).toHaveLength(1);
			expect(history[0].reason).toBe(REFUND_REASON);
			expect(history[0].amount).not.toBeNull();
		}
	);
});

describe('the old import paths of the three actions', () => {
	it('answer the very same objects as the module, so route-action.ts still recognises each class', () => {
		// `src/lib/server/route-action.ts` categorises these classes by identity, imported from the old
		// paths; a second copy of a class would fall through to a 500.
		expect(invoiceVoidPath.VoidRuleError).toBe(duesCorrection.VoidRuleError);
		expect(invoiceVoidPath.VoidRefusedAllocatedError).toBe(
			duesCorrection.VoidRefusedAllocatedError
		);
		expect(invoiceVoidPath.InvoiceNotFoundError).toBe(duesCorrection.InvoiceNotFoundError);
		expect(invoiceVoidPath.voidInvoice).toBe(duesCorrection.voidInvoice);
		expect(allocationReleasePath.ReleaseRuleError).toBe(duesCorrection.ReleaseRuleError);
		expect(allocationReleasePath.AllocationNotFoundError).toBe(
			duesCorrection.AllocationNotFoundError
		);
		expect(allocationReleasePath.releaseAllocation).toBe(duesCorrection.releaseAllocation);
		expect(creditRefundPath.RefundRuleError).toBe(duesCorrection.RefundRuleError);
		expect(creditRefundPath.refundCredit).toBe(duesCorrection.refundCredit);
	});
});
