import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import {
	allocations,
	duesRates,
	exemptions,
	invoices,
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	residents,
	units,
	user,
	type NewExemption,
	type NewInvoice,
	type NewPayment
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The iuran schema (Tarif, Tagihan, Pembebasan, Pembayaran, Alokasi), tested against PostgreSQL
 * rather than against a service that does not exist yet — the same discipline
 * `tests/unit/schema-complaint.test.ts` and `tests/unit/schema-resident-unit.test.ts` follow. Every
 * rejection is asserted on PostgreSQL's own `SQLSTATE` and on the name of the constraint that
 * produced it, so a migration that silently drops one of these rules fails here rather than in
 * production.
 *
 * What is deliberately not tested here, because `docs/spec-iuran-v1.md` puts it at the service
 * layer and this ticket builds no service: that issuance skips an exempt Unit, that a Tagihan with
 * an Alokasi cannot be cancelled, that the allocations of one Pembayaran never exceed its amount,
 * that the allocations of one Tagihan never exceed its amount, and that verification is one
 * transaction. Each of those is a fact about rows in another table or about a sum across rows, and
 * a PostgreSQL `CHECK` sees neither.
 */

const testDb = testDatabase();

/** Every instant this file writes that is not under test. No row here has a database default. */
const NOW = new Date('2026-03-10T09:00:00.000Z');

/** The Periode most Tagihan in this file are for. */
const PERIOD = '2026-03';

/** A different Periode, for the tests about what the unique index does and does not refuse. */
const OTHER_PERIOD = '2026-04';

/** `docs/spec-iuran-v1.md`'s "jatuh tempo tanggal 5", for `PERIOD`. */
const DUE_DATE = '2026-03-05';

/** The day the money changed hands. Deliberately earlier than `NOW`, as it usually is. */
const RECEIVED_ON = '2026-03-03';

/** The monthly iuran amount this file bills and pays. */
const MONTHLY = rupiah(150000);

/** One rupiah less than nothing — what every money column has to refuse. */
const NEGATIVE = rupiah(-1);

/** The first day of a Pembebasan. */
const STARTED_ON = '2026-03-01';

/** The last day of a Pembebasan, well after `STARTED_ON`. */
const ENDED_ON = '2026-05-31';

/** A day before `STARTED_ON`, for the date-order test. */
const BEFORE_START = '2026-02-28';

const EXEMPTION_REASON = 'Rumah ditinggalkan pemiliknya sejak Maret.';
const VOID_REASON = 'Tagihan terbit untuk rumah yang sudah dibebaskan.';
const REJECTION_REASON = 'Nominal pada bukti transfer tidak sama dengan yang dicatat.';
const PROOF_KEY = 'payments/2026-03/bukti-transfer.jpg';

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** PostgreSQL's `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/** PostgreSQL's `check_violation`. */
const CHECK_VIOLATION = '23514';

/** What PostgreSQL said when it refused a statement. */
interface DatabaseRefusal {
	readonly code: string;
	readonly constraint: string | undefined;
}

/** The two rows an Alokasi points at, for the tests about what may not be deleted out from under it. */
interface AllocatedRow {
	readonly invoiceId: string;
	readonly paymentId: string;
}

/** Makes every house and every email in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** The index or constraint PostgreSQL named in an error, when it named one. */
function constraintName(error: Error): string | undefined {
	if ('constraint' in error && typeof error.constraint === 'string') {
		return error.constraint;
	}
	return undefined;
}

/**
 * Takes the `SQLSTATE` and the offending constraint off a PostgreSQL error. Drizzle wraps driver
 * errors inside its own, so both live on the `cause` chain rather than on the outermost error.
 */
function databaseRefusal(error: unknown): DatabaseRefusal {
	let current: unknown = error;
	while (current instanceof Error) {
		if ('code' in current && typeof current.code === 'string') {
			return { code: current.code, constraint: constraintName(current) };
		}
		current = current.cause;
	}
	throw new TypeError(`Not a PostgreSQL error: ${String(error)}`);
}

/** Runs a statement that must fail, and reports how the database refused it. */
async function refused(statement: Promise<unknown>): Promise<DatabaseRefusal> {
	try {
		await statement;
	} catch (error) {
		return databaseRefusal(error);
	}
	throw new Error('The database accepted a statement it was supposed to refuse.');
}

/** One account, and the `residents` row that points at it. Returns the resident's id. */
async function createResident(): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(user).values({
		id,
		name: 'Warga Uji',
		email: `${unique('warga')}@komplek.local`,
		createdAt: NOW,
		updatedAt: NOW
	});
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId: id, createdAt: NOW })
		.returning();
	return row.id;
}

/** One house. Returns its id. */
async function createUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: 'C', number: unique('12'), createdAt: NOW })
		.returning();
	return row.id;
}

/** A Tagihan every constraint accepts, for a test to spoil one field of. */
function invoice(unitId: string, overrides: Partial<NewInvoice> = {}): NewInvoice {
	return {
		unitId,
		period: PERIOD,
		amount: MONTHLY,
		dueDate: DUE_DATE,
		issuedAt: NOW,
		...overrides
	};
}

/** Inserts a Tagihan every constraint accepts. Returns its id. */
async function createInvoice(unitId: string, overrides: Partial<NewInvoice> = {}): Promise<string> {
	const [row] = await testDb.db.insert(invoices).values(invoice(unitId, overrides)).returning();
	return row.id;
}

/** A Pembayaran every constraint accepts, for a test to spoil one field of. */
function payment(
	unitId: string,
	recordedBy: string,
	overrides: Partial<NewPayment> = {}
): NewPayment {
	return {
		unitId,
		recordedBy,
		amount: MONTHLY,
		receivedOn: RECEIVED_ON,
		method: PAYMENT_METHOD.transfer,
		proofFileKey: PROOF_KEY,
		status: PAYMENT_STATUS.pending,
		createdAt: NOW,
		...overrides
	};
}

/** Inserts a Pembayaran every constraint accepts. Returns its id. */
async function createPayment(overrides: Partial<NewPayment> = {}): Promise<string> {
	const unitId = await createUnit();
	const recordedBy = await createResident();
	const [row] = await testDb.db
		.insert(payments)
		.values(payment(unitId, recordedBy, overrides))
		.returning();
	return row.id;
}

/** A Pembebasan every constraint accepts, for a test to spoil one field of. */
function exemption(
	unitId: string,
	createdBy: string,
	overrides: Partial<NewExemption> = {}
): NewExemption {
	return {
		unitId,
		startedOn: STARTED_ON,
		endedOn: ENDED_ON,
		reason: EXEMPTION_REASON,
		createdBy,
		createdAt: NOW,
		...overrides
	};
}

describe('dues_rates', () => {
	it('stores the amount in whole rupiah and the day it starts applying', async () => {
		const [row] = await testDb.db
			.insert(duesRates)
			.values({ amount: MONTHLY, effectiveFrom: '2026-01-01', createdAt: NOW })
			.returning();

		expect(row).toMatchObject({ amount: MONTHLY, effectiveFrom: '2026-01-01' });
		expect(typeof row.amount).toBe('number');
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it('refuses a second Tarif starting on a day one already starts on', async () => {
		await testDb.db
			.insert(duesRates)
			.values({ amount: MONTHLY, effectiveFrom: '2026-02-01', createdAt: NOW });

		const refusal = await refused(
			testDb.db
				.insert(duesRates)
				.values({ amount: rupiah(175000), effectiveFrom: '2026-02-01', createdAt: NOW })
				.execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'dues_rates_effective_from_unique'
		});
	});

	it('accepts a later Tarif alongside the one before it, so the history is kept', async () => {
		await testDb.db
			.insert(duesRates)
			.values({ amount: MONTHLY, effectiveFrom: '2026-06-01', createdAt: NOW });
		await testDb.db
			.insert(duesRates)
			.values({ amount: rupiah(175000), effectiveFrom: '2026-07-01', createdAt: NOW });

		const rows = await testDb.db.select().from(duesRates);
		expect(rows.length).toBeGreaterThanOrEqual(2);
	});
});

describe('invoices', () => {
	it('stores the Unit, the Periode, the frozen amount, the due date and the issue instant', async () => {
		const unitId = await createUnit();

		const [row] = await testDb.db.insert(invoices).values(invoice(unitId)).returning();

		expect(row).toMatchObject({
			unitId,
			period: PERIOD,
			amount: MONTHLY,
			dueDate: DUE_DATE,
			voidedAt: null,
			voidReason: null,
			voidedBy: null
		});
		expect(row.issuedAt.getTime()).toBe(NOW.getTime());
	});

	it('refuses a second Tagihan for the same Unit and Periode', async () => {
		// The idempotence key `docs/spec-iuran-v1.md` relies on: running the issuance job twice for
		// one month leaves one Tagihan, because the database refuses the second insert outright.
		const unitId = await createUnit();
		await createInvoice(unitId);

		const refusal = await refused(testDb.db.insert(invoices).values(invoice(unitId)).execute());

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'invoices_unit_id_period_unique'
		});
	});

	it('accepts a second Tagihan when either the Unit or the Periode differs', async () => {
		const unitId = await createUnit();
		const otherUnitId = await createUnit();
		await createInvoice(unitId);

		await testDb.db.insert(invoices).values(invoice(unitId, { period: OTHER_PERIOD }));
		await testDb.db.insert(invoices).values(invoice(otherUnitId));

		const rows = await testDb.db.select().from(invoices).where(eq(invoices.unitId, unitId));
		expect(rows).toHaveLength(2);
	});

	it.each(['2026-3', '2026-13', '2026-00', '2026-03-01', 'Maret 2026', '202603'])(
		'refuses %s as a Periode',
		async (period) => {
			const unitId = await createUnit();

			const refusal = await refused(
				testDb.db.insert(invoices).values(invoice(unitId, { period })).execute()
			);

			expect(refusal).toEqual({
				code: CHECK_VIOLATION,
				constraint: 'invoices_period_shape_check'
			});
		}
	);

	it('accepts a cancellation carrying both its reason and its actor', async () => {
		const unitId = await createUnit();
		const actorId = await createResident();

		const [row] = await testDb.db
			.insert(invoices)
			.values(invoice(unitId, { voidedAt: NOW, voidReason: VOID_REASON, voidedBy: actorId }))
			.returning();

		expect(row).toMatchObject({ voidReason: VOID_REASON, voidedBy: actorId });
		expect(row.voidedAt?.getTime()).toBe(NOW.getTime());
	});

	it.each([
		{ what: 'an instant with no reason and no actor', partial: () => ({ voidedAt: NOW }) },
		{ what: 'a reason with no instant', partial: () => ({ voidReason: VOID_REASON }) },
		{ what: 'an actor with no instant', partial: (actorId: string) => ({ voidedBy: actorId }) },
		{
			what: 'an instant and a reason but no actor',
			partial: () => ({ voidedAt: NOW, voidReason: VOID_REASON })
		},
		{
			what: 'an instant and an actor but no reason',
			partial: (actorId: string) => ({ voidedAt: NOW, voidedBy: actorId })
		}
	])('refuses a cancellation recorded as $what', async ({ partial }) => {
		// The all-or-nothing rule: a Tagihan is never deleted, so a row marked cancelled with nobody
		// and no reason on it would be an obligation that vanished with no way left to ask why.
		const unitId = await createUnit();
		const actorId = await createResident();

		const refusal = await refused(
			testDb.db
				.insert(invoices)
				.values(invoice(unitId, partial(actorId)))
				.execute()
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'invoices_void_check' });
	});
});

describe('exemptions', () => {
	it('stores the Unit, the dates, the reason and who granted it', async () => {
		const unitId = await createUnit();
		const createdBy = await createResident();

		const [row] = await testDb.db
			.insert(exemptions)
			.values(exemption(unitId, createdBy))
			.returning();

		expect(row).toMatchObject({
			unitId,
			startedOn: STARTED_ON,
			endedOn: ENDED_ON,
			reason: EXEMPTION_REASON,
			createdBy
		});
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it.each([
		{ what: 'no end date at all, running until somebody ends it', endedOn: null },
		{ what: 'an end date on the day it started', endedOn: STARTED_ON }
	])('accepts a Pembebasan with $what', async ({ endedOn }) => {
		const unitId = await createUnit();
		const createdBy = await createResident();

		const [row] = await testDb.db
			.insert(exemptions)
			.values(exemption(unitId, createdBy, { endedOn }))
			.returning();

		expect(row.endedOn).toBe(endedOn);
	});

	it('refuses an end date earlier than the start date', async () => {
		const unitId = await createUnit();
		const createdBy = await createResident();

		const refusal = await refused(
			testDb.db
				.insert(exemptions)
				.values(exemption(unitId, createdBy, { endedOn: BEFORE_START }))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'exemptions_date_order_check'
		});
	});
});

describe('payments', () => {
	it('stores every column a Pembayaran uses', async () => {
		const unitId = await createUnit();
		const recordedBy = await createResident();

		const [row] = await testDb.db.insert(payments).values(payment(unitId, recordedBy)).returning();

		expect(row).toMatchObject({
			unitId,
			recordedBy,
			amount: MONTHLY,
			receivedOn: RECEIVED_ON,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: PROOF_KEY,
			status: PAYMENT_STATUS.pending,
			rejectionReason: null,
			verifiedBy: null,
			verifiedAt: null
		});
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it('accepts a tunai Pembayaran with no proof file, as user story 17 records one', async () => {
		const unitId = await createUnit();
		const recordedBy = await createResident();

		const [row] = await testDb.db
			.insert(payments)
			.values(payment(unitId, recordedBy, { method: PAYMENT_METHOD.cash, proofFileKey: null }))
			.returning();

		expect(row).toMatchObject({ method: PAYMENT_METHOD.cash, proofFileKey: null });
	});

	it.each([
		{
			what: 'a cara bayar outside transfer and tunai',
			method: 'bank-transfer',
			status: PAYMENT_STATUS.pending,
			constraint: 'payments_method_check'
		},
		{
			what: 'a status outside the three the domain defines',
			method: PAYMENT_METHOD.transfer,
			status: 'awaiting_verification',
			constraint: 'payments_status_check'
		}
	])('refuses $what', async ({ method, status, constraint }) => {
		// Written as SQL because the TypeScript type already refuses these values, and the rule under
		// test is the one in the database rather than the one in the type.
		const unitId = await createUnit();
		const recordedBy = await createResident();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into payments (unit_id, recorded_by, amount, received_on, method, status, created_at)
				    values (${unitId}, ${recordedBy}, ${MONTHLY}, ${RECEIVED_ON}, ${method}, ${status}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint });
	});

	it('accepts a rejection reason on a Pembayaran that was rejected', async () => {
		const unitId = await createUnit();
		const recordedBy = await createResident();

		const [row] = await testDb.db
			.insert(payments)
			.values(
				payment(unitId, recordedBy, {
					status: PAYMENT_STATUS.rejected,
					rejectionReason: REJECTION_REASON
				})
			)
			.returning();

		expect(row.rejectionReason).toBe(REJECTION_REASON);
	});

	it('refuses a rejection reason on a Pembayaran that was not rejected', async () => {
		const unitId = await createUnit();
		const recordedBy = await createResident();

		const refusal = await refused(
			testDb.db
				.insert(payments)
				.values(payment(unitId, recordedBy, { rejectionReason: REJECTION_REASON }))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'payments_rejection_reason_check'
		});
	});

	it('accepts a verifier and a verification instant on a verified Pembayaran', async () => {
		const unitId = await createUnit();
		const recordedBy = await createResident();
		const verifiedBy = await createResident();

		const [row] = await testDb.db
			.insert(payments)
			.values(
				payment(unitId, recordedBy, {
					status: PAYMENT_STATUS.verified,
					verifiedBy,
					verifiedAt: NOW
				})
			)
			.returning();

		expect(row).toMatchObject({ status: PAYMENT_STATUS.verified, verifiedBy });
		expect(row.verifiedAt?.getTime()).toBe(NOW.getTime());
	});

	it.each([
		{
			what: 'a verification instant with no verifier',
			partial: () => ({ status: PAYMENT_STATUS.verified, verifiedAt: NOW })
		},
		{
			what: 'a verifier with no verification instant',
			partial: (id: string) => ({ status: PAYMENT_STATUS.verified, verifiedBy: id })
		},
		{
			what: 'a verifier on a Pembayaran that is still waiting',
			partial: (id: string) => ({
				status: PAYMENT_STATUS.pending,
				verifiedBy: id,
				verifiedAt: NOW
			})
		},
		{
			what: 'a verifier on a Pembayaran that was rejected',
			partial: (id: string) => ({
				status: PAYMENT_STATUS.rejected,
				rejectionReason: REJECTION_REASON,
				verifiedBy: id,
				verifiedAt: NOW
			})
		}
	])('refuses $what', async ({ partial }) => {
		const unitId = await createUnit();
		const recordedBy = await createResident();
		const verifiedBy = await createResident();

		const refusal = await refused(
			testDb.db
				.insert(payments)
				.values(payment(unitId, recordedBy, partial(verifiedBy)))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'payments_verification_check'
		});
	});
});

describe('allocations', () => {
	it('stores the Pembayaran, the Tagihan and the amount', async () => {
		const unitId = await createUnit();
		const paymentId = await createPayment();
		const invoiceId = await createInvoice(unitId);

		const [row] = await testDb.db
			.insert(allocations)
			.values({ paymentId, invoiceId, amount: MONTHLY, createdAt: NOW })
			.returning();

		expect(row).toMatchObject({ paymentId, invoiceId, amount: MONTHLY });
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it('refuses a second Alokasi for the same Pembayaran and Tagihan', async () => {
		const unitId = await createUnit();
		const paymentId = await createPayment();
		const invoiceId = await createInvoice(unitId);
		await testDb.db
			.insert(allocations)
			.values({ paymentId, invoiceId, amount: rupiah(50000), createdAt: NOW });

		const refusal = await refused(
			testDb.db
				.insert(allocations)
				.values({ paymentId, invoiceId, amount: rupiah(100000), createdAt: NOW })
				.execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'allocations_payment_id_invoice_id_unique'
		});
	});

	it('accepts one Pembayaran against several Tagihan, and one Tagihan from several Pembayaran', async () => {
		// `docs/spec-iuran-v1.md`'s "warga membayar Rp300.000 untuk tiga bulan" and its opposite.
		const unitId = await createUnit();
		const paymentId = await createPayment();
		const otherPaymentId = await createPayment();
		const invoiceId = await createInvoice(unitId);
		const otherInvoiceId = await createInvoice(unitId, { period: OTHER_PERIOD });

		await testDb.db.insert(allocations).values([
			{ paymentId, invoiceId, amount: rupiah(100000), createdAt: NOW },
			{ paymentId, invoiceId: otherInvoiceId, amount: rupiah(50000), createdAt: NOW },
			{ paymentId: otherPaymentId, invoiceId, amount: rupiah(50000), createdAt: NOW }
		]);

		const rows = await testDb.db
			.select()
			.from(allocations)
			.where(eq(allocations.invoiceId, invoiceId));
		expect(rows).toHaveLength(2);
	});

	it.each([
		{
			what: 'a Tagihan',
			constraint: 'allocations_invoice_id_invoices_id_fk',
			remove: (ids: AllocatedRow) =>
				testDb.db.delete(invoices).where(eq(invoices.id, ids.invoiceId))
		},
		{
			what: 'a Pembayaran',
			constraint: 'allocations_payment_id_payments_id_fk',
			remove: (ids: AllocatedRow) =>
				testDb.db.delete(payments).where(eq(payments.id, ids.paymentId))
		}
	])('refuses removing $what that has an Alokasi', async ({ constraint, remove }) => {
		// Neither foreign key cascades. `docs/spec-iuran-v1.md:156-161` refuses to cancel a Tagihan
		// that has absorbed money precisely so that money never disappears from the Tagihan's side
		// without a trace; a cascade would perform that deletion silently.
		const unitId = await createUnit();
		const paymentId = await createPayment();
		const invoiceId = await createInvoice(unitId);
		await testDb.db
			.insert(allocations)
			.values({ paymentId, invoiceId, amount: MONTHLY, createdAt: NOW });

		const refusal = await refused(remove({ invoiceId, paymentId }).execute());

		expect(refusal).toEqual({ code: FOREIGN_KEY_VIOLATION, constraint });
	});

	it('lets an Alokasi be released, which is how the money becomes saldo titipan again', async () => {
		const unitId = await createUnit();
		const paymentId = await createPayment();
		const invoiceId = await createInvoice(unitId);
		await testDb.db
			.insert(allocations)
			.values({ paymentId, invoiceId, amount: MONTHLY, createdAt: NOW });

		await testDb.db.delete(allocations).where(eq(allocations.invoiceId, invoiceId));

		const rows = await testDb.db
			.select()
			.from(allocations)
			.where(eq(allocations.invoiceId, invoiceId));
		expect(rows).toHaveLength(0);
	});
});

describe('every money column', () => {
	it.each([
		{
			constraint: 'dues_rates_amount_check',
			insert: () =>
				testDb.db
					.insert(duesRates)
					.values({ amount: NEGATIVE, effectiveFrom: '2026-09-01', createdAt: NOW })
					.execute()
		},
		{
			constraint: 'invoices_amount_check',
			insert: async () => {
				const unitId = await createUnit();
				return testDb.db
					.insert(invoices)
					.values(invoice(unitId, { amount: NEGATIVE }))
					.execute();
			}
		},
		{
			constraint: 'payments_amount_check',
			insert: async () => {
				const unitId = await createUnit();
				const recordedBy = await createResident();
				return testDb.db
					.insert(payments)
					.values(payment(unitId, recordedBy, { amount: NEGATIVE }))
					.execute();
			}
		},
		{
			constraint: 'allocations_amount_check',
			insert: async () => {
				const unitId = await createUnit();
				const paymentId = await createPayment();
				const invoiceId = await createInvoice(unitId);
				return testDb.db
					.insert(allocations)
					.values({ paymentId, invoiceId, amount: NEGATIVE, createdAt: NOW })
					.execute();
			}
		}
	])('refuses a negative amount, as $constraint', async ({ constraint, insert }) => {
		const refusal = await refused(insert());

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint });
	});

	it.each(['dues_rates', 'invoices', 'payments', 'allocations'])(
		'stores %s.amount as bigint, never integer',
		async (tableName) => {
			// The `int4` ceiling is 2,147,483,647 rupiah, which one complex's cash book passes in a
			// decade or two. See `src/lib/money.ts`.
			const result = await testDb.db.execute<{ dataType: string }>(
				sql`select data_type as "dataType" from information_schema.columns
				    where table_schema = ${testDb.schemaName} and table_name = ${tableName}
				      and column_name = 'amount'`
			);

			expect(result.rows[0]?.dataType).toBe('bigint');
		}
	);
});

describe('the migration', () => {
	it.each(['dues_rates', 'invoices', 'exemptions', 'payments', 'allocations'])(
		'created %s',
		async (tableName) => {
			const result = await testDb.db.execute<{ total: string }>(
				sql`select count(*) as total from information_schema.tables
				    where table_schema = ${testDb.schemaName} and table_name = ${tableName}`
			);

			expect(result.rows[0]?.total).toBe('1');
		}
	);

	it.each([
		'dues_rates_effective_from_unique',
		'invoices_unit_id_period_unique',
		'exemptions_unit_id_idx',
		'payments_unit_id_idx',
		'payments_status_idx',
		'allocations_payment_id_invoice_id_unique',
		'allocations_invoice_id_idx'
	])('creates the %s index', async (indexName) => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from pg_indexes
			    where schemaname = ${testDb.schemaName} and indexname = ${indexName}`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it.each([
		['dues_rates_amount_check', 'CHECK ((amount >= 0))'],
		['invoices_amount_check', 'CHECK ((amount >= 0))'],
		['payments_amount_check', 'CHECK ((amount >= 0))'],
		['allocations_amount_check', 'CHECK ((amount >= 0))'],
		['invoices_period_shape_check', "CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))"],
		[
			'invoices_void_check',
			'CHECK ((((voided_at IS NULL) AND (void_reason IS NULL) AND (voided_by IS NULL)) OR ((voided_at IS NOT NULL) AND (void_reason IS NOT NULL) AND (voided_by IS NOT NULL))))'
		],
		['exemptions_date_order_check', 'CHECK (((ended_on IS NULL) OR (ended_on >= started_on)))'],
		['payments_method_check', "CHECK ((method = ANY (ARRAY['transfer'::text, 'cash'::text])))"],
		[
			'payments_status_check',
			"CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text])))"
		],
		[
			'payments_rejection_reason_check',
			"CHECK (((rejection_reason IS NULL) OR (status = 'rejected'::text)))"
		],
		[
			'payments_verification_check',
			"CHECK ((((verified_at IS NULL) AND (verified_by IS NULL)) OR ((verified_at IS NOT NULL) AND (verified_by IS NOT NULL) AND (status = 'verified'::text))))"
		]
	])('declares %s', async (name, definition) => {
		const result = await testDb.db.execute<{ definition: string }>(
			sql`select pg_get_constraintdef(constraints.oid) as definition
			    from pg_constraint constraints
			    join pg_namespace namespaces on namespaces.oid = constraints.connamespace
			    where namespaces.nspname = ${testDb.schemaName} and constraints.conname = ${name}`
		);

		expect(result.rows[0]?.definition).toBe(definition);
	});

	it.each([
		'allocations_payment_id_payments_id_fk',
		'allocations_invoice_id_invoices_id_fk',
		'invoices_unit_id_units_id_fk',
		'payments_unit_id_units_id_fk'
	])('leaves %s without a cascade, so no row is ever deleted by another', async (name) => {
		// `c` is `ON DELETE CASCADE`; `a` is `NO ACTION`, which is what every foreign key here has.
		const result = await testDb.db.execute<{ onDelete: string }>(
			sql`select constraints.confdeltype as "onDelete"
			    from pg_constraint constraints
			    join pg_namespace namespaces on namespaces.oid = constraints.connamespace
			    where namespaces.nspname = ${testDb.schemaName} and constraints.conname = ${name}`
		);

		expect(result.rows[0]?.onDelete).toBe('a');
	});

	it('creates no credit_balances table, because saldo titipan is computed', async () => {
		// `CONTEXT.md` says "dihitung, tanpa tabel", and `docs/spec-iuran-v1.md:138-140` says why: a
		// stored balance is a number that can drift from the transactions it is supposed to summarise.
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = 'credit_balances'`
		);

		expect(result.rows[0]?.total).toBe('0');
	});

	it('creates no status column on invoices, because a Tagihan status is computed', async () => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.columns
			    where table_schema = ${testDb.schemaName} and table_name = 'invoices'
			      and column_name = 'status'`
		);

		expect(result.rows[0]?.total).toBe('0');
	});

	it('runs again on a database that is already migrated, and changes nothing', async () => {
		const applied = async (): Promise<string | undefined> => {
			const result = await testDb.db.execute<{ total: string }>(
				sql`select count(*) as total from "__migrations__"`
			);
			return result.rows[0]?.total;
		};
		const before = await applied();

		await migrate(testDb.db, {
			migrationsFolder: path.resolve(process.cwd(), 'drizzle'),
			migrationsSchema: testDb.schemaName,
			// The name src/lib/server/db/test-helpers.ts gives the journal inside each test schema.
			migrationsTable: '__migrations__'
		});

		expect(Number(before)).toBeGreaterThan(0);
		expect(await applied()).toBe(before);
	});
});
