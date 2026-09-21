import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '$lib/server/auth';
import { testDatabase } from '$lib/server/db/test-helpers';
import { allocations } from '$lib/server/db/schema/allocation';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { CASH_CATEGORY_TYPE, cashCategories } from '$lib/server/db/schema/cash-category';
import { cashTransactions } from '$lib/server/db/schema/cash-transaction';
import { complaints } from '$lib/server/db/schema/complaint';
import { invoices } from '$lib/server/db/schema/invoice';
import { occupancies } from '$lib/server/db/schema/occupancy';
import { PAYMENT_STATUS, payments } from '$lib/server/db/schema/payment';
import { posts } from '$lib/server/db/schema/post';
import { REGISTRATION_STATUS, registrations } from '$lib/server/db/schema/registration';
import { residents } from '$lib/server/db/schema/resident';
import { JOB_RUN_STATUS, jobRuns } from '$lib/server/db/schema/scheduler';
import { units } from '$lib/server/db/schema/unit';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { creditBalanceOfUnit } from '$lib/server/services/dues/credit-balance';
import { INVOICE_ISSUANCE_JOB_NAME } from '$lib/server/services/dues/jobs';
import {
	PRESERVED_TABLES,
	RESET_TABLES,
	assertSeedAllowed,
	seedDevelopmentData,
	type SeedSummary
} from '../../scripts/seed-dev';
import {
	ADMIN_EMAIL,
	RESIDENT_COUNT,
	SEED_PASSWORD,
	SEED_PAYMENTS,
	SEED_UNITS,
	SUPERUSER_EMAIL
} from '../../scripts/seed-data';

/**
 * `scripts/seed-dev.ts`, proved against a real schema.
 *
 * ## Why the clock is pinned to the twentieth
 *
 * A Tagihan falls due on the fifth of its month, and `listOverdueUnits` calls a house menunggak only
 * once that day has passed. A test reading the system clock would therefore assert "three houses are
 * overdue" successfully for twenty-five days a month and fail for the first five — a test that knows
 * what day it is, which is exactly what `src/lib/server/ports/clock.ts` says a fake clock exists to
 * prevent. `2026-09-20T03:00:00Z` is 10.00 WIB on the twentieth, so the whole Data Contoh lands in
 * `2026-09` and every due date in it is in the past.
 *
 * ## Why the seeder runs twice in `beforeAll`
 *
 * "Menjalankan dua kali memberi jumlah yang sama" is the acceptance criterion, and the honest way to
 * check it is to run it twice and compare — not to reason about the reset. Everything after the two
 * runs asserts against the *second* one's state, which is the stronger position: a seeder that was
 * correct on an empty database and wrong on a full one would pass a single-run test.
 *
 * It costs a couple of minutes, because twenty-seven accounts are hashed by better-auth's real
 * scrypt and every row goes through the service that owns it. That is the point of the ticket, so
 * the hook carries its own timeout rather than the file being made faster by faking the work.
 *
 * ## The file store
 *
 * `FakeFileStore`, not the repository's `storage/`. It keeps the bytes in a `Map` and signs links
 * with the same functions the real store uses, so nothing here writes to disk and there is no
 * directory to clean up afterwards — and `seedDevelopmentData` is given no `storageRoot`, so the
 * step that empties one never runs.
 */

const testDb = testDatabase();

/** 10.00 WIB on 20 September 2026 — see this file's doc comment. */
const SEED_INSTANT = '2026-09-20T03:00:00.000Z';

/** The WIB month `SEED_INSTANT` falls in. */
const SEED_PERIOD = '2026-09';

/** A `BETTER_AUTH_SECRET` for this test's own better-auth instance. Signs nothing that leaves it. */
const TEST_SECRET = 'seed-dev-test-secret-0123456789-0123456789ab';

/** The origin the seeded emails' links are built on. */
const TEST_ORIGIN = 'http://localhost:5173';

/** How many rows there are of each thing the acceptance criteria counts. */
interface SeedCounts {
	readonly units: number;
	readonly residents: number;
	readonly users: number;
	readonly occupancies: number;
	readonly primaryOccupants: number;
	readonly invoicesThisPeriod: number;
	readonly payments: number;
	readonly pendingPayments: number;
	readonly expenseTransactions: number;
	readonly posts: number;
	readonly complaints: number;
	readonly pendingRegistrations: number;
	readonly succeededIssuanceRuns: number;
	readonly systemCashCategories: number;
}

let firstSummary: SeedSummary;
let secondSummary: SeedSummary;
let firstCounts: SeedCounts;
let secondCounts: SeedCounts;

beforeAll(async () => {
	firstSummary = await runSeeder();
	firstCounts = await countEverything();
	secondSummary = await runSeeder();
	secondCounts = await countEverything();
}, 900_000);

/** One run of the seeder against this file's schema, with a fake clock and an in-memory store. */
async function runSeeder(): Promise<SeedSummary> {
	const clock = new FakeClock(SEED_INSTANT);
	return seedDevelopmentData({
		db: testDb.db,
		clock,
		fileStore: new FakeFileStore(clock),
		origin: TEST_ORIGIN,
		secret: TEST_SECRET
	});
}

/** How many rows of each kind the schema holds right now. */
async function countEverything(): Promise<SeedCounts> {
	return {
		units: await countRows(units),
		residents: await countRows(residents),
		users: await countRows(user),
		occupancies: await countRows(occupancies),
		primaryOccupants: (
			await testDb.db
				.select({ id: occupancies.id })
				.from(occupancies)
				.where(eq(occupancies.isPrimaryOccupant, true))
		).length,
		invoicesThisPeriod: (
			await testDb.db
				.select({ id: invoices.id })
				.from(invoices)
				.where(eq(invoices.period, SEED_PERIOD))
		).length,
		payments: await countRows(payments),
		pendingPayments: (
			await testDb.db
				.select({ id: payments.id })
				.from(payments)
				.where(eq(payments.status, PAYMENT_STATUS.pending))
		).length,
		expenseTransactions: (
			await testDb.db
				.select({ id: cashTransactions.id })
				.from(cashTransactions)
				.where(eq(cashTransactions.type, CASH_CATEGORY_TYPE.expense))
		).length,
		posts: await countRows(posts),
		complaints: await countRows(complaints),
		pendingRegistrations: (
			await testDb.db
				.select({ id: registrations.id })
				.from(registrations)
				.where(eq(registrations.status, REGISTRATION_STATUS.pending))
		).length,
		succeededIssuanceRuns: (
			await testDb.db
				.select({ id: jobRuns.id })
				.from(jobRuns)
				.where(
					and(
						eq(jobRuns.jobName, INVOICE_ISSUANCE_JOB_NAME),
						eq(jobRuns.period, SEED_PERIOD),
						eq(jobRuns.status, JOB_RUN_STATUS.succeeded)
					)
				)
		).length,
		systemCashCategories: (
			await testDb.db
				.select({ id: cashCategories.id })
				.from(cashCategories)
				.where(isNotNull(cashCategories.systemKey))
		).length
	};
}

/**
 * How many rows one table holds.
 *
 * `count(*)::text` rather than `rows.length`, and `::text` rather than a bare `count(*)`: PostgreSQL
 * types `count` as `bigint`, which the driver hands back as a string only sometimes depending on how
 * it is configured — the same idiom `allocatedAmountsByInvoice` in
 * `src/lib/server/services/dues/queries.ts` records.
 */
async function countRows(table: PgTable): Promise<number> {
	const [row] = await testDb.db.select({ total: sql<string>`count(*)::text` }).from(table);
	return Number(row.total);
}

describe('assertSeedAllowed', () => {
	const localUrl = 'postgres://komplek:secret@localhost:5433/komplek';

	it('accepts a local database when --yes is given', () => {
		expect(() =>
			assertSeedAllowed({ DATABASE_URL: localUrl } as NodeJS.ProcessEnv, ['--yes'])
		).not.toThrow();
	});

	it('refuses a production NODE_ENV, naming the variable', () => {
		expect(() =>
			assertSeedAllowed({ NODE_ENV: 'production', DATABASE_URL: localUrl } as NodeJS.ProcessEnv, [
				'--yes'
			])
		).toThrow(/NODE_ENV is "production"/);
	});

	it('refuses a DATABASE_URL that is not on this machine, naming the host', () => {
		expect(() =>
			assertSeedAllowed(
				{ DATABASE_URL: 'postgres://user:pw@db.example.com:5432/komplek' } as NodeJS.ProcessEnv,
				['--yes']
			)
		).toThrow(/points at host "db\.example\.com"/);
	});

	it('refuses a missing --yes, naming the flag', () => {
		expect(() => assertSeedAllowed({ DATABASE_URL: localUrl } as NodeJS.ProcessEnv, [])).toThrow(
			/--yes/
		);
	});

	it('gives each of the three refusals a different message', () => {
		const messages = [
			messageOf({ NODE_ENV: 'production', DATABASE_URL: localUrl }, ['--yes']),
			messageOf({ DATABASE_URL: 'postgres://user:pw@example.com:5432/komplek' }, ['--yes']),
			messageOf({ DATABASE_URL: localUrl }, [])
		];
		expect(new Set(messages).size).toBe(3);
	});

	it('refuses a missing DATABASE_URL rather than reading it as local', () => {
		expect(() => assertSeedAllowed({} as NodeJS.ProcessEnv, ['--yes'])).toThrow(/unreadable/);
	});

	/** The message `assertSeedAllowed` refuses one pair of inputs with. */
	function messageOf(environment: Record<string, string>, argv: readonly string[]): string {
		try {
			assertSeedAllowed(environment as NodeJS.ProcessEnv, argv);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error('assertSeedAllowed accepted input the test expected it to refuse.');
	}
});

describe('the reset list', () => {
	it('names every table in a migrated schema except the ones it deliberately keeps', async () => {
		const rows = await testDb.db.execute<{ name: string }>(
			sql`select table_name as "name" from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_type = 'BASE TABLE'`
		);
		// The harness's own journal is not part of the application schema.
		const present = rows.rows.map((row) => row.name).filter((name) => name !== '__migrations__');

		expect([...present].sort()).toEqual([...RESET_TABLES, ...PRESERVED_TABLES].sort());
	});

	it('keeps the two system cash categories the migration seeded', () => {
		expect(secondCounts.systemCashCategories).toBe(2);
	});
});

describe('seeding the Data Contoh', () => {
	it('registers twenty units', () => {
		expect(secondCounts.units).toBe(SEED_UNITS.length);
		expect(secondCounts.units).toBe(20);
	});

	it('creates twenty-seven residents: twenty-five warga and two pengurus', () => {
		expect(secondCounts.residents).toBe(RESIDENT_COUNT + 2);
		expect(secondCounts.residents).toBe(27);
		expect(secondCounts.users).toBe(27);
	});

	it('gives every unit exactly one Penanggung Jawab', () => {
		expect(secondCounts.primaryOccupants).toBe(SEED_UNITS.length);
		expect(secondCounts.occupancies).toBe(27);
	});

	it('issues one invoice per unit for the current month', () => {
		expect(secondCounts.invoicesThisPeriod).toBe(20);
		expect(secondSummary.period).toBe(SEED_PERIOD);
	});

	it('leaves one succeeded issuance run for the month, so the job will not repeat', () => {
		expect(secondCounts.succeededIssuanceRuns).toBe(1);
	});

	it('records at least thirty payments, five of them still pending', () => {
		expect(secondCounts.payments).toBeGreaterThanOrEqual(30);
		expect(secondCounts.payments).toBe(SEED_PAYMENTS.length);
		expect(secondCounts.pendingPayments).toBe(5);
	});

	it('records at least twenty-five outgoing cash transactions', () => {
		expect(secondCounts.expenseTransactions).toBeGreaterThanOrEqual(25);
	});

	it('writes six posts and ten complaints', () => {
		expect(secondCounts.posts).toBe(6);
		expect(secondCounts.complaints).toBe(10);
	});

	it('leaves three units owing money on the daftar penunggak', () => {
		expect(secondSummary.overdueUnits).toBe(3);
	});

	it('leaves no registration waiting to be decided', () => {
		expect(secondCounts.pendingRegistrations).toBe(0);
	});
});

describe('running it twice', () => {
	it('produces the same counts', () => {
		expect(secondCounts).toEqual(firstCounts);
	});

	it('produces the same summary', () => {
		expect(secondSummary).toEqual(firstSummary);
	});
});

describe('the seeded accounts', () => {
	/**
	 * A better-auth instance bound to this schema, built the way the seeder builds its own:
	 * `createAuth` with no plugins, because `sveltekitCookies` needs a request in flight.
	 */
	function authForTest(): Auth {
		return createAuth({
			db: testDb.db,
			clock: new FakeClock(SEED_INSTANT),
			baseURL: TEST_ORIGIN,
			secret: TEST_SECRET
		});
	}

	/**
	 * This is the assertion the whole ticket rests on, and it cannot be replaced by reading columns.
	 *
	 * Two separate things have to be right before anyone can sign in, and each fails silently on its
	 * own: the password has to be hashed by the very scrypt configuration `signInEmail` verifies
	 * against — which is why the seeder goes through `signUpEmail` rather than writing an `account`
	 * row — and `emailVerified` has to be true, because `requireEmailVerification` refuses an
	 * unverified account outright. A seeder that got either wrong would leave twenty-seven accounts
	 * that look perfect in the database and reject every password at the form.
	 */
	it('lets the pengurus and a warga sign in with the documented password', async () => {
		const auth = authForTest();
		for (const email of [SUPERUSER_EMAIL, ADMIN_EMAIL, 'warga01@komplek.local']) {
			const result = await auth.api.signInEmail({
				body: { email, password: SEED_PASSWORD }
			});
			expect(result.user.email).toBe(email);
		}
	});

	it('refuses the wrong password', async () => {
		await expect(
			authForTest().api.signInEmail({
				body: { email: SUPERUSER_EMAIL, password: 'kata-sandi-yang-salah-123' }
			})
		).rejects.toThrow();
	});

	it('gives the superuser account both roles, which is what /admin/overdue needs', async () => {
		const held = await testDb.db
			.select({ role: userRoles.role })
			.from(userRoles)
			.innerJoin(user, eq(user.id, userRoles.userId))
			.where(eq(user.email, SUPERUSER_EMAIL));

		expect(new Set(held.map((row) => row.role))).toEqual(
			new Set([ROLE.resident, ROLE.admin, ROLE.superuser])
		);
	});

	it('gives the admin account the admin role and nothing more', async () => {
		const held = await testDb.db
			.select({ role: userRoles.role })
			.from(userRoles)
			.innerJoin(user, eq(user.id, userRoles.userId))
			.where(eq(user.email, ADMIN_EMAIL));

		expect(new Set(held.map((row) => row.role))).toEqual(new Set([ROLE.resident, ROLE.admin]));
	});
});

describe('the money invariants', () => {
	it('never allocates more of a payment than the payment is worth', async () => {
		const rows = await testDb.db
			.select({
				paymentId: payments.id,
				amount: payments.amount,
				allocated: sql<string>`coalesce((
					select sum(${allocations.amount}) from ${allocations}
					where ${allocations.paymentId} = ${payments.id}
				), 0)::text`
			})
			.from(payments);

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(Number(row.allocated)).toBeLessThanOrEqual(row.amount);
		}
	});

	it('allocates only verified payments', async () => {
		const unverified = await testDb.db
			.select({ id: allocations.id })
			.from(allocations)
			.innerJoin(payments, eq(payments.id, allocations.paymentId))
			.where(ne(payments.status, PAYMENT_STATUS.verified));

		expect(unverified).toEqual([]);
	});

	it('leaves every unit a Saldo Titipan of zero or more', async () => {
		const rows = await testDb.db.select({ id: units.id }).from(units);
		expect(rows.length).toBe(20);

		for (const row of rows) {
			expect(await creditBalanceOfUnit(testDb.db, row.id)).toBeGreaterThanOrEqual(0);
		}
	});

	it('builds the Saldo Titipan it does have only out of verified money', async () => {
		const withCredit: string[] = [];
		const rows = await testDb.db.select({ id: units.id }).from(units);
		for (const row of rows) {
			if ((await creditBalanceOfUnit(testDb.db, row.id)) > 0) {
				withCredit.push(row.id);
			}
		}

		// Two units overpay in `SEED_PAYMENTS`, and both overpayments are verified.
		expect(withCredit.length).toBe(2);
		const statuses = await testDb.db
			.select({ status: payments.status })
			.from(payments)
			.where(inArray(payments.unitId, withCredit));
		expect(statuses.every((row) => row.status === PAYMENT_STATUS.verified)).toBe(true);
	});
});
