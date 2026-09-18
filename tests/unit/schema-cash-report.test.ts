import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	cashTransactions,
	monthlyReports,
	PERIOD_STATUS,
	periods,
	SYSTEM_CATEGORY_KEY,
	user,
	type CashCategory,
	type MonthlyReportCategoryLine,
	type NewCashCategory,
	type NewCashTransaction,
	type NewMonthlyReport,
	type NewPeriod
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The kas-laporan schema (Kategori Kas, Transaksi Kas, Periode, Laporan Bulanan), tested against
 * PostgreSQL rather than against a service that does not exist yet — the same discipline
 * `tests/unit/schema-dues.test.ts` follows. Every rejection is asserted on PostgreSQL's own
 * `SQLSTATE` and on the name of the constraint that produced it, so a migration that silently
 * drops one of these rules fails here rather than in production.
 *
 * What is deliberately not tested here, because `docs/spec-kas-laporan-v1.md` puts it at the
 * service layer and this ticket builds no service: that transactions are never updated or deleted
 * (tested there as the absence of those operations), that a transaction dated in a locked Periode
 * is refused, that "Iuran warga" refuses manual entries, that a Koreksi's type opposes and its
 * amount equals the original's, that a system category cannot be deleted or change type, and that
 * a report's frozen totals agree with the cash book. Each of those is a fact about rows in another
 * table or about an operation, and a PostgreSQL `CHECK` sees neither.
 */

const testDb = testDatabase();

/** Every instant this file writes that is not under test. No row here has a time default. */
const NOW = new Date('2026-09-10T09:00:00.000Z');

/** The day the money moved, for every transaction here. Earlier than `NOW`, as it usually is. */
const OCCURRED_ON = '2026-08-15';

/** The amount most transactions in this file move. */
const AMOUNT = rupiah(150000);

const DESCRIPTION = 'Perbaikan lampu jalan blok C.';
const CORRECTION_DESCRIPTION = 'Koreksi: nominal tertukar dengan nota lain.';
const REVISION_REASON = 'Nota kebersihan Agustus baru ditemukan September.';
const ATTACHMENT_KEY = 'cash/2026-08/nota-lampu.jpg';

/** The frozen headline numbers of the reports this file publishes. They add up on purpose. */
const OPENING = rupiah(500000);
const INCOME = rupiah(800000);
const EXPENSE = rupiah(300000);
const CLOSING = rupiah(1000000);
const DUES_COLLECTED = rupiah(750000);
const UNITS_PAID = 5;
const UNITS_UNPAID = 2;

/** A frozen per-category breakdown consistent with the headline numbers above. */
const BREAKDOWN: MonthlyReportCategoryLine[] = [
	{
		categoryId: randomUUID(),
		name: 'Iuran warga',
		type: CASH_CATEGORY_TYPE.income,
		total: rupiah(750000)
	},
	{
		categoryId: randomUUID(),
		name: 'Donasi',
		type: CASH_CATEGORY_TYPE.income,
		total: rupiah(50000)
	},
	{
		categoryId: randomUUID(),
		name: 'Kebersihan',
		type: CASH_CATEGORY_TYPE.expense,
		total: rupiah(300000)
	}
];

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

/** Makes every name, email and Periode in this file different from every other one. */
let sequence = 0;

function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** A calendar year no other Periode in this file uses. */
function nextYear(): number {
	sequence += 1;
	return 2000 + sequence;
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

/** One account — an actor. Both actor columns here reference `user.id` directly. */
async function createUser(): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(user).values({
		id,
		name: 'Admin Uji',
		email: `${unique('admin')}@komplek.local`,
		createdAt: NOW,
		updatedAt: NOW
	});
	return id;
}

/** One ordinary Kategori Kas every constraint accepts. Returns the whole row. */
async function createCategory(overrides: Partial<NewCashCategory> = {}): Promise<CashCategory> {
	const [row] = await testDb.db
		.insert(cashCategories)
		.values({
			name: unique('Perbaikan'),
			type: CASH_CATEGORY_TYPE.expense,
			createdAt: NOW,
			...overrides
		})
		.returning();
	return row;
}

/** One Periode every constraint accepts, in a year of its own. Returns its id. */
async function createPeriod(overrides: Partial<NewPeriod> = {}): Promise<string> {
	const [row] = await testDb.db
		.insert(periods)
		.values({
			year: nextYear(),
			month: 8,
			status: PERIOD_STATUS.open,
			createdAt: NOW,
			...overrides
		})
		.returning();
	return row.id;
}

/** A Transaksi Kas every constraint accepts, for a test to spoil one field of. */
function transaction(
	categoryId: string,
	recordedBy: string,
	overrides: Partial<NewCashTransaction> = {}
): NewCashTransaction {
	return {
		occurredOn: OCCURRED_ON,
		type: CASH_CATEGORY_TYPE.expense,
		categoryId,
		amount: AMOUNT,
		description: DESCRIPTION,
		attachmentKey: ATTACHMENT_KEY,
		recordedBy,
		createdAt: NOW,
		...overrides
	};
}

/** A Laporan Bulanan every constraint accepts, for a test to spoil one field of. */
function report(
	periodId: string,
	publishedBy: string,
	overrides: Partial<NewMonthlyReport> = {}
): NewMonthlyReport {
	return {
		periodId,
		revision: 1,
		publishedAt: NOW,
		publishedBy,
		openingBalance: OPENING,
		totalIncome: INCOME,
		totalExpense: EXPENSE,
		closingBalance: CLOSING,
		duesCollected: DUES_COLLECTED,
		duesUnitsPaid: UNITS_PAID,
		duesUnitsUnpaid: UNITS_UNPAID,
		categoryBreakdown: BREAKDOWN,
		...overrides
	};
}

describe('cash_categories', () => {
	it('stores the name and type, defaults to active, and is ordinary without a system key', async () => {
		const row = await createCategory();

		expect(row).toMatchObject({
			type: CASH_CATEGORY_TYPE.expense,
			isActive: true,
			systemKey: null
		});
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it('refuses a second Kategori Kas with a name one already has', async () => {
		const existing = await createCategory();

		const refusal = await refused(
			testDb.db
				.insert(cashCategories)
				.values({ name: existing.name, type: CASH_CATEGORY_TYPE.income, createdAt: NOW })
				.execute()
		);

		expect(refusal).toEqual({ code: UNIQUE_VIOLATION, constraint: 'cash_categories_name_unique' });
	});

	it('refuses a second Kategori Kas claiming a system key one already holds', async () => {
		// The seeded "Iuran warga" row already holds `dues`, so this also proves the seed is there.
		const refusal = await refused(
			testDb.db
				.insert(cashCategories)
				.values({
					name: unique('Iuran tandingan'),
					type: CASH_CATEGORY_TYPE.income,
					systemKey: SYSTEM_CATEGORY_KEY.dues,
					createdAt: NOW
				})
				.execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'cash_categories_system_key_unique'
		});
	});

	it('accepts any number of ordinary categories with no system key at once', async () => {
		// NULLS DISTINCT: the unique index on system_key never collides two nulls.
		const first = await createCategory();
		const second = await createCategory();

		expect(first.systemKey).toBeNull();
		expect(second.systemKey).toBeNull();
	});

	it('refuses a tipe outside masuk and keluar', async () => {
		// Written as SQL because the TypeScript type already refuses the value, and the rule under
		// test is the one in the database rather than the one in the type.
		const refusal = await refused(
			testDb.db.execute(
				sql`insert into cash_categories (name, type, created_at)
				    values (${unique('Liar')}, ${'transfer'}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'cash_categories_type_check' });
	});
});

describe('the seeded system categories', () => {
	it.each([
		{ key: SYSTEM_CATEGORY_KEY.dues, name: 'Iuran warga' },
		{ key: SYSTEM_CATEGORY_KEY.openingBalance, name: 'Saldo awal' }
	])(
		'was given $name by the migration, keyed $key, active and typed income',
		async ({ key, name }) => {
			// Seeded by drizzle/0009_cash_report.sql itself, never by application startup code.
			const rows = await testDb.db
				.select()
				.from(cashCategories)
				.where(eq(cashCategories.systemKey, key));

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ name, type: CASH_CATEGORY_TYPE.income, isActive: true });
		}
	);

	it('was given exactly two system categories, no more', async () => {
		// Counts only keyed rows, because other tests in this file add ordinary categories.
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from cash_categories where system_key is not null`
		);

		expect(result.rows[0]?.total).toBe('2');
	});
});

describe('cash_transactions', () => {
	it('stores every column a Transaksi Kas uses', async () => {
		const category = await createCategory();
		const recordedBy = await createUser();

		const [row] = await testDb.db
			.insert(cashTransactions)
			.values(transaction(category.id, recordedBy))
			.returning();

		expect(row).toMatchObject({
			occurredOn: OCCURRED_ON,
			type: CASH_CATEGORY_TYPE.expense,
			categoryId: category.id,
			amount: AMOUNT,
			description: DESCRIPTION,
			attachmentKey: ATTACHMENT_KEY,
			recordedBy,
			correctionOf: null
		});
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it.each([
		{ what: 'a zero nominal', amount: rupiah(0) },
		{ what: 'a negative nominal', amount: rupiah(-1) }
	])('refuses $what, because a cash line is money that actually moved', async ({ amount }) => {
		const category = await createCategory();
		const recordedBy = await createUser();

		const refusal = await refused(
			testDb.db
				.insert(cashTransactions)
				.values(transaction(category.id, recordedBy, { amount }))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'cash_transactions_amount_check'
		});
	});

	it('refuses a tipe outside masuk and keluar', async () => {
		const category = await createCategory();
		const recordedBy = await createUser();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into cash_transactions (occurred_on, type, category_id, amount, description, recorded_by, created_at)
				    values (${OCCURRED_ON}, ${'refund'}, ${category.id}, ${AMOUNT}, ${DESCRIPTION}, ${recordedBy}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'cash_transactions_type_check' });
	});

	it('accepts a Koreksi: an opposite-type row in the same category, pointing at the original', async () => {
		const category = await createCategory({
			type: CASH_CATEGORY_TYPE.income,
			name: unique('Donasi')
		});
		const recordedBy = await createUser();
		const [original] = await testDb.db
			.insert(cashTransactions)
			.values(transaction(category.id, recordedBy, { type: CASH_CATEGORY_TYPE.income }))
			.returning();

		const [correction] = await testDb.db
			.insert(cashTransactions)
			.values(
				transaction(category.id, recordedBy, {
					type: CASH_CATEGORY_TYPE.expense,
					correctionOf: original.id,
					description: CORRECTION_DESCRIPTION,
					attachmentKey: null
				})
			)
			.returning();

		expect(correction).toMatchObject({
			correctionOf: original.id,
			type: CASH_CATEGORY_TYPE.expense,
			categoryId: category.id,
			amount: AMOUNT
		});
	});

	it('refuses a Transaksi Kas that claims to correct itself', async () => {
		const category = await createCategory();
		const recordedBy = await createUser();
		const id = randomUUID();

		const refusal = await refused(
			testDb.db
				.insert(cashTransactions)
				.values({ ...transaction(category.id, recordedBy), id, correctionOf: id })
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'cash_transactions_correction_self_check'
		});
	});

	it('refuses a Koreksi pointing at a transaction that does not exist', async () => {
		const category = await createCategory();
		const recordedBy = await createUser();

		const refusal = await refused(
			testDb.db
				.insert(cashTransactions)
				.values(transaction(category.id, recordedBy, { correctionOf: randomUUID() }))
				.execute()
		);

		expect(refusal).toEqual({
			code: FOREIGN_KEY_VIOLATION,
			constraint: 'cash_transactions_correction_of_cash_transactions_id_fk'
		});
	});

	it('refuses deleting a transaction that a Koreksi points at', async () => {
		// The self foreign key is one of the holds behind "tidak pernah diubah dan tidak pernah
		// dihapus": a corrected original cannot vanish out from under its correction.
		const category = await createCategory();
		const recordedBy = await createUser();
		const [original] = await testDb.db
			.insert(cashTransactions)
			.values(transaction(category.id, recordedBy))
			.returning();
		await testDb.db.insert(cashTransactions).values(
			transaction(category.id, recordedBy, {
				type: CASH_CATEGORY_TYPE.income,
				correctionOf: original.id,
				description: CORRECTION_DESCRIPTION
			})
		);

		const refusal = await refused(
			testDb.db.delete(cashTransactions).where(eq(cashTransactions.id, original.id)).execute()
		);

		expect(refusal).toEqual({
			code: FOREIGN_KEY_VIOLATION,
			constraint: 'cash_transactions_correction_of_cash_transactions_id_fk'
		});
	});

	it('refuses deleting a Kategori Kas that has transactions', async () => {
		const category = await createCategory();
		const recordedBy = await createUser();
		await testDb.db.insert(cashTransactions).values(transaction(category.id, recordedBy));

		const refusal = await refused(
			testDb.db.delete(cashCategories).where(eq(cashCategories.id, category.id)).execute()
		);

		expect(refusal).toEqual({
			code: FOREIGN_KEY_VIOLATION,
			constraint: 'cash_transactions_category_id_cash_categories_id_fk'
		});
	});
});

describe('periods', () => {
	it('stores the year, the month and the status', async () => {
		const year = nextYear();

		const [row] = await testDb.db
			.insert(periods)
			.values({ year, month: 1, status: PERIOD_STATUS.locked, createdAt: NOW })
			.returning();

		expect(row).toMatchObject({ year, month: 1, status: PERIOD_STATUS.locked });
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it('refuses a second Periode for the same year and month', async () => {
		const year = nextYear();
		await testDb.db
			.insert(periods)
			.values({ year, month: 3, status: PERIOD_STATUS.open, createdAt: NOW });

		const refusal = await refused(
			testDb.db
				.insert(periods)
				.values({ year, month: 3, status: PERIOD_STATUS.locked, createdAt: NOW })
				.execute()
		);

		expect(refusal).toEqual({ code: UNIQUE_VIOLATION, constraint: 'periods_year_month_unique' });
	});

	it.each([0, 13])('refuses %i as a month', async (month) => {
		const refusal = await refused(
			testDb.db
				.insert(periods)
				.values({ year: nextYear(), month, status: PERIOD_STATUS.open, createdAt: NOW })
				.execute()
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'periods_month_check' });
	});

	it('refuses a status outside terbuka and terkunci', async () => {
		const refusal = await refused(
			testDb.db.execute(
				sql`insert into periods (year, month, status, created_at)
				    values (${nextYear()}, ${6}, ${'closed'}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'periods_status_check' });
	});
});

describe('monthly_reports', () => {
	it('stores the frozen numbers, and the breakdown comes back exactly as written', async () => {
		const periodId = await createPeriod();
		const publishedBy = await createUser();

		const [row] = await testDb.db
			.insert(monthlyReports)
			.values(report(periodId, publishedBy))
			.returning();

		expect(row).toMatchObject({
			periodId,
			revision: 1,
			publishedBy,
			revisionReason: null,
			openingBalance: OPENING,
			totalIncome: INCOME,
			totalExpense: EXPENSE,
			closingBalance: CLOSING,
			duesCollected: DUES_COLLECTED,
			duesUnitsPaid: UNITS_PAID,
			duesUnitsUnpaid: UNITS_UNPAID
		});
		expect(row.categoryBreakdown).toEqual(BREAKDOWN);
		expect(row.publishedAt.getTime()).toBe(NOW.getTime());
	});

	it('refuses a second report with the same Periode and revision number', async () => {
		const periodId = await createPeriod();
		const publishedBy = await createUser();
		await testDb.db.insert(monthlyReports).values(report(periodId, publishedBy));

		const refusal = await refused(
			testDb.db.insert(monthlyReports).values(report(periodId, publishedBy)).execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'monthly_reports_period_id_revision_unique'
		});
	});

	it('keeps revision 1 readable alongside revision 2, each with its own numbers', async () => {
		// "Laporan revisi 1 tetap bisa dibaca setelah revisi 2 ada" — the whole point of freezing.
		const periodId = await createPeriod();
		const publishedBy = await createUser();
		await testDb.db.insert(monthlyReports).values(report(periodId, publishedBy));
		await testDb.db.insert(monthlyReports).values(
			report(periodId, publishedBy, {
				revision: 2,
				revisionReason: REVISION_REASON,
				totalExpense: rupiah(350000),
				closingBalance: rupiah(950000)
			})
		);

		const rows = await testDb.db
			.select()
			.from(monthlyReports)
			.where(eq(monthlyReports.periodId, periodId))
			.orderBy(monthlyReports.revision);

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ revision: 1, closingBalance: CLOSING, revisionReason: null });
		expect(rows[1]).toMatchObject({
			revision: 2,
			closingBalance: rupiah(950000),
			revisionReason: REVISION_REASON
		});
	});

	it('refuses revision 0', async () => {
		// A revision below 1 also violates the reason check; PostgreSQL evaluates a row's check
		// constraints in name order, so the one it reports is the revision check.
		const periodId = await createPeriod();
		const publishedBy = await createUser();

		const refusal = await refused(
			testDb.db
				.insert(monthlyReports)
				.values(report(periodId, publishedBy, { revision: 0 }))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'monthly_reports_revision_check'
		});
	});

	it.each([
		{
			what: 'revision 1 carrying a revision reason, which would claim a revision that never happened',
			overrides: { revisionReason: REVISION_REASON }
		},
		{
			what: 'a revision above 1 with no reason, which every resident is entitled to read',
			overrides: { revision: 2 }
		}
	])('refuses $what', async ({ overrides }) => {
		const periodId = await createPeriod();
		const publishedBy = await createUser();

		const refusal = await refused(
			testDb.db
				.insert(monthlyReports)
				.values(report(periodId, publishedBy, overrides))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'monthly_reports_revision_reason_check'
		});
	});

	it('refuses frozen headline numbers that do not add up', async () => {
		const periodId = await createPeriod();
		const publishedBy = await createUser();

		const refusal = await refused(
			testDb.db
				.insert(monthlyReports)
				.values(report(periodId, publishedBy, { closingBalance: rupiah(1000001) }))
				.execute()
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'monthly_reports_balance_check' });
	});

	// Each case keeps the balance identity satisfied so exactly one constraint can fire.
	it.each([
		{
			constraint: 'monthly_reports_total_income_check',
			overrides: {
				openingBalance: rupiah(0),
				totalIncome: rupiah(-1),
				totalExpense: rupiah(0),
				closingBalance: rupiah(-1)
			}
		},
		{
			constraint: 'monthly_reports_total_expense_check',
			overrides: {
				openingBalance: rupiah(0),
				totalIncome: rupiah(0),
				totalExpense: rupiah(-1),
				closingBalance: rupiah(1)
			}
		},
		{
			constraint: 'monthly_reports_dues_collected_check',
			overrides: { duesCollected: rupiah(-1) }
		},
		{
			constraint: 'monthly_reports_dues_units_paid_check',
			overrides: { duesUnitsPaid: -1 }
		},
		{
			constraint: 'monthly_reports_dues_units_unpaid_check',
			overrides: { duesUnitsUnpaid: -1 }
		}
	])('refuses a negative frozen figure, as $constraint', async ({ constraint, overrides }) => {
		const periodId = await createPeriod();
		const publishedBy = await createUser();

		const refusal = await refused(
			testDb.db
				.insert(monthlyReports)
				.values(report(periodId, publishedBy, overrides))
				.execute()
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint });
	});
});

describe('every stored figure', () => {
	it.each([
		['cash_transactions', 'amount', 'bigint'],
		['monthly_reports', 'opening_balance', 'bigint'],
		['monthly_reports', 'total_income', 'bigint'],
		['monthly_reports', 'total_expense', 'bigint'],
		['monthly_reports', 'closing_balance', 'bigint'],
		['monthly_reports', 'dues_collected', 'bigint'],
		['monthly_reports', 'dues_units_paid', 'integer'],
		['monthly_reports', 'dues_units_unpaid', 'integer']
	])('stores %s.%s as %s', async (tableName, columnName, dataType) => {
		// Money is bigint (the int4 ceiling is 2,147,483,647 rupiah — see src/lib/money.ts); the two
		// house counts are deliberately integer, because they are counts, not money.
		const result = await testDb.db.execute<{ dataType: string }>(
			sql`select data_type as "dataType" from information_schema.columns
			    where table_schema = ${testDb.schemaName} and table_name = ${tableName}
			      and column_name = ${columnName}`
		);

		expect(result.rows[0]?.dataType).toBe(dataType);
	});
});

describe('the migration', () => {
	it.each(['cash_categories', 'cash_transactions', 'periods', 'monthly_reports'])(
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
		'cash_categories_name_unique',
		'cash_categories_system_key_unique',
		'cash_transactions_occurred_on_idx',
		'cash_transactions_category_id_idx',
		'periods_year_month_unique',
		'monthly_reports_period_id_revision_unique'
	])('creates the %s index', async (indexName) => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from pg_indexes
			    where schemaname = ${testDb.schemaName} and indexname = ${indexName}`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it.each([
		['cash_transactions_amount_check', 'CHECK ((amount > 0))'],
		['cash_categories_type_check', "CHECK ((type = ANY (ARRAY['income'::text, 'expense'::text])))"],
		[
			'cash_transactions_type_check',
			"CHECK ((type = ANY (ARRAY['income'::text, 'expense'::text])))"
		],
		[
			'cash_transactions_correction_self_check',
			'CHECK (((correction_of IS NULL) OR (correction_of <> id)))'
		],
		['periods_month_check', 'CHECK (((month >= 1) AND (month <= 12)))'],
		['periods_status_check', "CHECK ((status = ANY (ARRAY['open'::text, 'locked'::text])))"],
		['monthly_reports_revision_check', 'CHECK ((revision >= 1))'],
		[
			'monthly_reports_revision_reason_check',
			'CHECK ((((revision = 1) AND (revision_reason IS NULL)) OR ((revision > 1) AND (revision_reason IS NOT NULL))))'
		],
		[
			'monthly_reports_balance_check',
			'CHECK ((closing_balance = ((opening_balance + total_income) - total_expense)))'
		],
		['monthly_reports_total_income_check', 'CHECK ((total_income >= 0))'],
		['monthly_reports_total_expense_check', 'CHECK ((total_expense >= 0))'],
		['monthly_reports_dues_collected_check', 'CHECK ((dues_collected >= 0))'],
		['monthly_reports_dues_units_paid_check', 'CHECK ((dues_units_paid >= 0))'],
		['monthly_reports_dues_units_unpaid_check', 'CHECK ((dues_units_unpaid >= 0))']
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
		'cash_transactions_category_id_cash_categories_id_fk',
		'cash_transactions_recorded_by_user_id_fk',
		'cash_transactions_correction_of_cash_transactions_id_fk',
		'monthly_reports_period_id_periods_id_fk',
		'monthly_reports_published_by_user_id_fk'
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

	it.each(['cash_transactions_recorded_by_user_id_fk', 'monthly_reports_published_by_user_id_fk'])(
		'points %s at this schema, never at public.user',
		async (name) => {
			// The generated SQL said `REFERENCES "public"."user"`, hand-corrected exactly as the
			// migrations before it were; this proves the correction, so the harness keeps working.
			const result = await testDb.db.execute<{ referencedSchema: string; referencedTable: string }>(
				sql`select target_namespace.nspname as "referencedSchema", target.relname as "referencedTable"
				    from pg_constraint constraints
				    join pg_namespace namespaces on namespaces.oid = constraints.connamespace
				    join pg_class target on target.oid = constraints.confrelid
				    join pg_namespace target_namespace on target_namespace.oid = target.relnamespace
				    where namespaces.nspname = ${testDb.schemaName} and constraints.conname = ${name}`
			);

			expect(result.rows[0]).toEqual({
				referencedSchema: testDb.schemaName,
				referencedTable: 'user'
			});
		}
	);

	it('creates no stored balance anywhere, because saldo is always a sum over transactions', async () => {
		// "Saldo kas dan saldo per periode dihitung dari transaksi, tidak pernah disimpan sebagai
		// kolom yang diperbarui" — the frozen balances on monthly_reports are publications, not this.
		const tables = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = 'cash_balances'`
		);
		const columns = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.columns
			    where table_schema = ${testDb.schemaName}
			      and table_name in ('cash_transactions', 'periods') and column_name like '%balance%'`
		);

		expect(tables.rows[0]?.total).toBe('0');
		expect(columns.rows[0]?.total).toBe('0');
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
