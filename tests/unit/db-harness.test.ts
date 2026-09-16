import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import { scaffoldProbe } from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

const testDb = testDatabase();

/**
 * A marker that the other test file using this harness writes as well. The check below — exactly
 * one row, not two — is what fails when the per-file schema leaks.
 */
const SHARED_MARKER = 'cross-file-isolation-marker';

describe('database connection', () => {
	it('rejects an empty URL with a message naming its variable', () => {
		expect(() => readDatabaseUrl('DATABASE_URL', {})).toThrow(/DATABASE_URL is not set/);
	});

	it('rejects a URL that is only whitespace', () => {
		expect(() => readDatabaseUrl('TEST_DATABASE_URL', { TEST_DATABASE_URL: '   ' })).toThrow(
			/TEST_DATABASE_URL is not set/
		);
	});
});

describe('database test harness', () => {
	it('uses a randomly generated schema name, so that no two files share one', () => {
		expect(testDb.schemaName).toMatch(/^test_[0-9a-f]{32}$/);
	});

	it('gives this file its own schema rather than public', async () => {
		const result = await testDb.db.execute<{ schemaName: string }>(
			sql`select current_schema() as "schemaName"`
		);
		expect(result.rows[0]?.schemaName).toBe(testDb.schemaName);
	});

	it('runs the migrations, so the table exists in that schema', async () => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = 'scaffold_probe'`
		);
		expect(result.rows[0]?.total).toBe('1');
	});

	it('starts with an empty table', async () => {
		const [result] = await testDb.db.select({ total: count() }).from(scaffoldProbe);
		expect(result.total).toBe(0);
	});

	it('writes a row and reads it back', async () => {
		const [row] = await testDb.db
			.insert(scaffoldProbe)
			.values({ description: 'one month of dues', amount: rupiah(150_000) })
			.returning();

		const read = await testDb.db.select().from(scaffoldProbe).where(eq(scaffoldProbe.id, row.id));

		expect(read).toEqual([
			{
				id: row.id,
				description: 'one month of dues',
				amount: 150_000,
				createdAt: row.createdAt
			}
		]);
	});

	it('returns a money value as a whole number rather than a string from a bigint column', async () => {
		// The mistake prevented: `bigint` without `mode: 'number'` reaches the code as a string,
		// and "150000" + "150000" is "150000150000".
		const large = 987_654_321_098;
		const [row] = await testDb.db
			.insert(scaffoldProbe)
			.values({ description: 'a large value', amount: rupiah(large) })
			.returning();

		expect(row.amount).toBe(large);
	});

	it('really commits, so another connection sees the row', async () => {
		// This is why the harness uses a schema per file rather than a rolled-back transaction:
		// the append-only cash book rules are rules about committing, and cannot be tested from
		// inside a transaction that never commits.
		const [row] = await testDb.db
			.insert(scaffoldProbe)
			.values({ description: 'proof of commit', amount: rupiah(1) })
			.returning();

		const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
			options: `-c search_path=${testDb.schemaName}`
		});
		try {
			const read = await other.db.select().from(scaffoldProbe).where(eq(scaffoldProbe.id, row.id));
			expect(read).toHaveLength(1);
		} finally {
			await other.close();
		}
	});

	it('leaves nothing behind in the public schema', async () => {
		// If search_path is wrong, the migrations land in public and every test file shares one
		// table. This check fails immediately when that happens.
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables where table_schema = 'public'`
		);
		expect(result.rows[0]?.total).toBe('0');
	});

	it('writes the shared marker exactly once, even though another file writes the same marker', async () => {
		await testDb.db.insert(scaffoldProbe).values({ description: SHARED_MARKER, amount: rupiah(1) });

		const [result] = await testDb.db
			.select({ total: count() })
			.from(scaffoldProbe)
			.where(eq(scaffoldProbe.description, SHARED_MARKER));

		expect(result.total).toBe(1);
	});
});
