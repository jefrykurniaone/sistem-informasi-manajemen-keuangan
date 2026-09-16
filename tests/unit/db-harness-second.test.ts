import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { scaffoldProbe } from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

const testDb = testDatabase();

/**
 * Exactly the marker `db-harness.test.ts` writes. If cross-file isolation leaks — two files
 * sharing one schema — one of these two files will see two rows with this marker rather than one.
 */
const SHARED_MARKER = 'cross-file-isolation-marker';

/**
 * The counterpart to `db-harness.test.ts`, not a copy of it. That file already proves the
 * connection, the migrations, whether a bigint value stays a whole number, and a real commit;
 * this file only proves the cross-file isolation claim: two files running serially or in
 * parallel, writing identical markers, do not see each other's rows.
 */
describe('isolation between test files', () => {
	it('gets its own random test schema, not the one db-harness.test.ts uses', () => {
		expect(testDb.schemaName).toMatch(/^test_[0-9a-f]{32}$/);
	});

	it('starts with an empty table in its own schema', async () => {
		const [result] = await testDb.db.select({ total: count() }).from(scaffoldProbe);
		expect(result.total).toBe(0);
	});

	it('writes the shared marker and sees exactly one row in its own schema', async () => {
		await testDb.db.insert(scaffoldProbe).values({ description: SHARED_MARKER, amount: rupiah(1) });

		const [result] = await testDb.db
			.select({ total: count() })
			.from(scaffoldProbe)
			.where(eq(scaffoldProbe.description, SHARED_MARKER));

		expect(result.total).toBe(1);
	});
});
