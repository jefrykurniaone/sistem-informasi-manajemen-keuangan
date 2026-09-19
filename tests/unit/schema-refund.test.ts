import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import {
	cashCategories,
	cashTransactions,
	PAYMENT_METHOD,
	PAYMENT_STATUS,
	payments,
	refunds,
	residents,
	SYSTEM_CATEGORY_KEY,
	units,
	user,
	type NewRefund
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The `refunds` schema (Pengembalian, #30), tested against PostgreSQL the way
 * `tests/unit/schema-dues.test.ts` tests the iuran tables: every database constraint is attacked
 * directly and must refuse, asserted on PostgreSQL's own `SQLSTATE` and on the name of the
 * constraint that produced it, so a migration that silently drops one of these rules fails here
 * rather than in production.
 *
 * What is deliberately not tested here, because it is a fact about sums across rows that a
 * PostgreSQL `CHECK` cannot see: that a refund never exceeds its payment's unallocated remainder,
 * and that a refund row's amount agrees with its cash row's. Both are the one writer's
 * (`src/lib/server/services/dues/credit-refund.ts`) and are held in
 * `tests/unit/credit-refund.test.ts`.
 */

const testDb = testDatabase();

/** Every instant this file writes that is not under test. */
const NOW = new Date('2026-03-10T09:00:00.000Z');

/** The day the refunded money in this file originally arrived. */
const RECEIVED_ON = '2026-03-03';

/** The day the refunds in this file were handed back. */
const REFUNDED_ON = '2026-03-08';

/** The amount most payments and refunds in this file carry. */
const AMOUNT = rupiah(150000);

const REFUND_REASON = 'Warga pindah dan saldo titipannya dikembalikan.';

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** PostgreSQL's `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/** PostgreSQL's `check_violation`. */
const CHECK_VIOLATION = '23514';

/** PostgreSQL's `not_null_violation`. */
const NOT_NULL_VIOLATION = '23502';

/** What PostgreSQL said when it refused a statement. */
interface DatabaseRefusal {
	readonly code: string;
	readonly constraint: string | undefined;
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

/** One account. Returns its id — `refunds.refundedBy` references `user.id` directly. */
async function createUser(): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(user).values({
		id,
		name: 'Pengurus Uji Pengembalian',
		email: `${unique('pengurus')}@komplek.local`,
		createdAt: NOW,
		updatedAt: NOW
	});
	return id;
}

/** One verified Pembayaran, with the house and the resident behind it. Returns its id. */
async function createVerifiedPayment(): Promise<string> {
	const userId = await createUser();
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: NOW })
		.returning();
	const [unit] = await testDb.db
		.insert(units)
		.values({ block: 'RF', number: unique('1'), createdAt: NOW })
		.returning();
	const [row] = await testDb.db
		.insert(payments)
		.values({
			unitId: unit.id,
			recordedBy: resident.id,
			amount: AMOUNT,
			receivedOn: RECEIVED_ON,
			method: PAYMENT_METHOD.transfer,
			proofFileKey: null,
			status: PAYMENT_STATUS.verified,
			verifiedBy: resident.id,
			verifiedAt: NOW,
			createdAt: NOW
		})
		.returning();
	return row.id;
}

/**
 * One cash expense row in the seeded system category "Iuran warga" — the row a Pengembalian
 * points at, written directly because this file tests the table, not the service.
 */
async function createRefundCashRow(recordedBy: string): Promise<string> {
	const [category] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.dues));
	const [row] = await testDb.db
		.insert(cashTransactions)
		.values({
			id: randomUUID(),
			occurredOn: REFUNDED_ON,
			type: 'expense',
			categoryId: category.id,
			amount: AMOUNT,
			description: 'Pengembalian saldo titipan (uji skema)',
			attachmentKey: null,
			recordedBy,
			createdAt: NOW
		})
		.returning();
	return row.id;
}

/** A Pengembalian every constraint accepts, for a test to spoil one field of. */
async function acceptableRefund(overrides: Partial<NewRefund> = {}): Promise<NewRefund> {
	const refundedBy = await createUser();
	return {
		paymentId: await createVerifiedPayment(),
		cashTransactionId: await createRefundCashRow(refundedBy),
		amount: AMOUNT,
		reason: REFUND_REASON,
		refundedBy,
		createdAt: NOW,
		...overrides
	};
}

describe('refunds', () => {
	it('stores the Pembayaran, the cash row, the amount, the reason and who returned it', async () => {
		const row = await acceptableRefund();

		const [written] = await testDb.db.insert(refunds).values(row).returning();

		expect(written).toMatchObject({
			paymentId: row.paymentId,
			cashTransactionId: row.cashTransactionId,
			amount: AMOUNT,
			reason: REFUND_REASON,
			refundedBy: row.refundedBy
		});
		expect(written.createdAt.getTime()).toBe(NOW.getTime());
		expect(typeof written.amount).toBe('number');
	});

	it('refuses a second refund claiming a cash row that is already spoken for', async () => {
		// The enforceable half of "setiap Pengembalian merujuk tepat satu baris kas keluar": the
		// unique index makes each cash row at most one refund's.
		const first = await acceptableRefund();
		await testDb.db.insert(refunds).values(first);
		const second = await acceptableRefund({ cashTransactionId: first.cashTransactionId });

		const refusal = await refused(testDb.db.insert(refunds).values(second).execute());

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'refunds_cash_transaction_id_unique'
		});
	});

	it('accepts several refunds of one Pembayaran, each with its own cash row', async () => {
		// One payment refunded in two goes — mirroring how one payment may carry many allocations.
		const first = await acceptableRefund({ amount: rupiah(50000) });
		await testDb.db.insert(refunds).values(first);
		const second = await acceptableRefund({ paymentId: first.paymentId, amount: rupiah(25000) });
		await testDb.db.insert(refunds).values(second);

		const rows = await testDb.db
			.select()
			.from(refunds)
			.where(eq(refunds.paymentId, first.paymentId));
		expect(rows).toHaveLength(2);
	});

	it.each([rupiah(0), rupiah(-1)])(
		'refuses %d as an amount — a refund is a movement of money',
		async (amount) => {
			const row = await acceptableRefund({ amount });

			const refusal = await refused(testDb.db.insert(refunds).values(row).execute());

			expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'refunds_amount_check' });
		}
	);

	it('refuses a refund with no reason', async () => {
		const row = await acceptableRefund();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into refunds (payment_id, cash_transaction_id, amount, refunded_by, created_at)
				    values (${row.paymentId}, ${row.cashTransactionId}, ${row.amount}, ${row.refundedBy}, ${NOW})`
			)
		);

		expect(refusal.code).toBe(NOT_NULL_VIOLATION);
	});

	it.each([
		{ what: 'a Pembayaran no row carries', spoil: { paymentId: randomUUID() } },
		{ what: 'a cash row no row carries', spoil: { cashTransactionId: randomUUID() } },
		{ what: 'an account no row carries', spoil: { refundedBy: randomUUID() } }
	])('refuses $what', async ({ spoil }) => {
		const row = await acceptableRefund(spoil);

		const refusal = await refused(testDb.db.insert(refunds).values(row).execute());

		expect(refusal.code).toBe(FOREIGN_KEY_VIOLATION);
	});

	it.each([
		{
			what: 'a Pembayaran',
			constraint: 'refunds_payment_id_payments_id_fk',
			remove: (row: { paymentId: string }) =>
				testDb.db.delete(payments).where(eq(payments.id, row.paymentId))
		},
		{
			what: 'a cash row',
			constraint: 'refunds_cash_transaction_id_cash_transactions_id_fk',
			remove: (row: { cashTransactionId: string }) =>
				testDb.db.delete(cashTransactions).where(eq(cashTransactions.id, row.cashTransactionId))
		}
	])('refuses removing $what a refund points at', async ({ constraint, remove }) => {
		// No cascade in either direction: attributed money history cannot be deleted out from under
		// the attribution — the same second line of defence `allocations` records.
		const row = await acceptableRefund();
		await testDb.db.insert(refunds).values(row);

		const refusal = await refused(
			remove({
				paymentId: row.paymentId,
				cashTransactionId: row.cashTransactionId
			}).execute()
		);

		expect(refusal).toEqual({ code: FOREIGN_KEY_VIOLATION, constraint });
	});
});

describe('the migration', () => {
	it('created refunds', async () => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = 'refunds'`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it.each(['refunds_cash_transaction_id_unique', 'refunds_payment_id_idx'])(
		'creates the %s index',
		async (indexName) => {
			const result = await testDb.db.execute<{ total: string }>(
				sql`select count(*) as total from pg_indexes
				    where schemaname = ${testDb.schemaName} and indexname = ${indexName}`
			);

			expect(result.rows[0]?.total).toBe('1');
		}
	);

	it('declares refunds_amount_check as strictly positive', async () => {
		// `amount > 0`, the strictness of `cash_transactions_amount_check` rather than the `>= 0` of
		// `allocations`: a zero-rupiah refund records nothing happening.
		const result = await testDb.db.execute<{ definition: string }>(
			sql`select pg_get_constraintdef(constraints.oid) as definition
			    from pg_constraint constraints
			    join pg_namespace namespaces on namespaces.oid = constraints.connamespace
			    where namespaces.nspname = ${testDb.schemaName}
			      and constraints.conname = 'refunds_amount_check'`
		);

		expect(result.rows[0]?.definition).toBe('CHECK ((amount > 0))');
	});

	it.each([
		'refunds_payment_id_payments_id_fk',
		'refunds_cash_transaction_id_cash_transactions_id_fk',
		'refunds_refunded_by_user_id_fk'
	])('leaves %s without a cascade, so no refund is ever deleted by another row', async (name) => {
		// `c` is `ON DELETE CASCADE`; `a` is `NO ACTION`, which is what every foreign key here has.
		const result = await testDb.db.execute<{ onDelete: string }>(
			sql`select constraints.confdeltype as "onDelete"
			    from pg_constraint constraints
			    join pg_namespace namespaces on namespaces.oid = constraints.connamespace
			    where namespaces.nspname = ${testDb.schemaName} and constraints.conname = ${name}`
		);

		expect(result.rows[0]?.onDelete).toBe('a');
	});

	it('stores refunds.amount as bigint, never integer', async () => {
		const result = await testDb.db.execute<{ dataType: string }>(
			sql`select data_type as "dataType" from information_schema.columns
			    where table_schema = ${testDb.schemaName} and table_name = 'refunds'
			      and column_name = 'amount'`
		);

		expect(result.rows[0]?.dataType).toBe('bigint');
	});

	it('adds no unit_id column — the attribution to a Unit rides the payment, never a copy', async () => {
		// `src/lib/server/db/schema/refund.ts`: a second, direct `unit_id` would be a copy the
		// database could never check against the payment's.
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.columns
			    where table_schema = ${testDb.schemaName} and table_name = 'refunds'
			      and column_name = 'unit_id'`
		);

		expect(result.rows[0]?.total).toBe('0');
	});
});
