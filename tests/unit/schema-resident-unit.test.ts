import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import { createConnection, readDatabaseUrl } from '$lib/server/db';
import {
	invitations,
	occupancies,
	OCCUPANCY_ROLE,
	registrations,
	REGISTRATION_STATUS,
	residents,
	subscriptions,
	units,
	user,
	type NewOccupancy
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The warga-unit schema, tested against PostgreSQL rather than against the code that will later
 * write to it.
 *
 * Every rejection below is asserted on PostgreSQL's own `SQLSTATE` and on the name of the index or
 * constraint that produced it. That is the point of the file: the spec asks for rules the database
 * enforces, and a test that called a service and got a tidy error back would pass just as happily
 * against a rule that only lives in TypeScript. Nothing here goes through a service — there is no
 * service yet — so what these tests exercise is the table.
 */

const testDb = testDatabase();

/** Every instant written by this file. No row here has a database default for its time. */
const NOW = new Date('2026-03-01T09:00:00.000Z');

/** The day every occupancy in this file starts on. */
const STARTED_ON = '2026-03-01';

/** A day after `STARTED_ON`. */
const AFTER_START = '2026-06-30';

/** A day before `STARTED_ON`. */
const BEFORE_START = '2026-02-01';

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** PostgreSQL's `check_violation`. */
const CHECK_VIOLATION = '23514';

/** The tables this spec adds. */
const SPEC_TABLES = [
	'invitations',
	'occupancies',
	'registrations',
	'residents',
	'subscriptions',
	'units'
] as const;

/** What PostgreSQL said when it refused a statement. */
interface DatabaseRefusal {
	readonly code: string;
	readonly constraint: string | undefined;
}

/** Makes every block, address and digest in this file different from every other one. */
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

/** One house, in a block no other test uses. Returns its id. */
async function createUnit(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '12', createdAt: NOW })
		.returning();
	return row.id;
}

/** An occupancy that every constraint accepts, for a test to spoil one field of. */
function occupancy(
	unitId: string,
	residentId: string,
	overrides: Partial<NewOccupancy> = {}
): NewOccupancy {
	return {
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: STARTED_ON,
		createdAt: NOW,
		...overrides
	};
}

describe('units', () => {
	it('refuses a second house with the same block and number', async () => {
		const block = unique('B');
		await testDb.db.insert(units).values({ block, number: '12', createdAt: NOW });

		const refusal = await refused(
			testDb.db.insert(units).values({ block, number: '12', createdAt: NOW }).execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'units_block_number_unique'
		});
	});

	it('allows the same house number in another block', async () => {
		const number = '12';
		await testDb.db.insert(units).values({ block: unique('B'), number, createdAt: NOW });
		await testDb.db.insert(units).values({ block: unique('B'), number, createdAt: NOW });

		const [row] = await testDb.db
			.select({ total: sql<string>`count(*)` })
			.from(units)
			.where(eq(units.number, number));
		expect(Number(row.total)).toBeGreaterThanOrEqual(2);
	});

	it('switches a house off rather than deleting it, and starts it switched on', async () => {
		const unitId = await createUnit();

		const [row] = await testDb.db.select().from(units).where(eq(units.id, unitId));

		expect(row.isActive).toBe(true);
	});
});

describe('residents', () => {
	it('refuses a second resident row for one account', async () => {
		const id = randomUUID();
		await testDb.db.insert(user).values({
			id,
			name: 'Warga Uji',
			email: `${unique('warga')}@komplek.local`,
			createdAt: NOW,
			updatedAt: NOW
		});
		await testDb.db.insert(residents).values({ userId: id, createdAt: NOW });

		const refusal = await refused(
			testDb.db.insert(residents).values({ userId: id, createdAt: NOW }).execute()
		);

		expect(refusal).toEqual({ code: UNIQUE_VIOLATION, constraint: 'residents_user_id_unique' });
	});
});

describe('occupancies', () => {
	it('refuses a second primary occupant while the first occupancy is still running', async () => {
		const unitId = await createUnit();
		const first = await createResident();
		const second = await createResident();
		await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, first, { isPrimaryOccupant: true }));

		const refusal = await refused(
			testDb.db
				.insert(occupancies)
				.values(occupancy(unitId, second, { isPrimaryOccupant: true }))
				.execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'occupancies_primary_occupant_unique'
		});
	});

	it('lets only one of two connections take the primary occupant slot', async () => {
		// Two calls started together and awaited through Promise.allSettled would prove nothing:
		// nothing makes one of them land inside the other's window. A second connection holding an
		// open transaction does. The statement below is started while that transaction is still
		// open — so the row it collides with is one it cannot see — and is refused all the same.
		// That is the index doing the work rather than anything this file read first, which is the
		// distinction the rule depends on: a service that looked for a primary occupant before
		// writing one would find none here and would write the second.
		const unitId = await createUnit();
		const first = await createResident();
		const second = await createResident();

		const other = createConnection(readDatabaseUrl('TEST_DATABASE_URL'), {
			options: `-c search_path=${testDb.schemaName}`
		});
		const client = await other.pool.connect();
		try {
			await client.query('begin');
			await client.query(
				`insert into occupancies (unit_id, resident_id, role, started_on, is_primary_occupant, created_at)
				 values ($1, $2, $3, $4, true, $5)`,
				[unitId, first, OCCUPANCY_ROLE.owner, STARTED_ON, NOW]
			);

			const blocked = refused(
				testDb.db
					.insert(occupancies)
					.values(occupancy(unitId, second, { isPrimaryOccupant: true }))
					.execute()
			);
			await client.query('commit');

			expect(await blocked).toEqual({
				code: UNIQUE_VIOLATION,
				constraint: 'occupancies_primary_occupant_unique'
			});
		} finally {
			client.release();
			await other.close();
		}
	});

	it('frees the slot when the previous occupancy ends, in that same statement', async () => {
		const unitId = await createUnit();
		const leaving = await createResident();
		const arriving = await createResident();
		const [previous] = await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, leaving, { isPrimaryOccupant: true }))
			.returning();

		await testDb.db
			.update(occupancies)
			.set({ endedOn: AFTER_START })
			.where(eq(occupancies.id, previous.id));
		const [next] = await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, arriving, { startedOn: AFTER_START, isPrimaryOccupant: true }))
			.returning();

		expect(next.isPrimaryOccupant).toBe(true);
	});

	it('keeps the flag on an occupancy that has ended, so a past date still has an answer', async () => {
		const unitId = await createUnit();
		const residentId = await createResident();
		const [row] = await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, residentId, { isPrimaryOccupant: true }))
			.returning();
		await testDb.db
			.update(occupancies)
			.set({ endedOn: AFTER_START })
			.where(eq(occupancies.id, row.id));

		const [ended] = await testDb.db.select().from(occupancies).where(eq(occupancies.id, row.id));

		expect(ended).toMatchObject({ endedOn: AFTER_START, isPrimaryOccupant: true });
	});

	it('allows several running occupancies on one house when only one is the primary occupant', async () => {
		const unitId = await createUnit();
		const husband = await createResident();
		const wife = await createResident();

		await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, husband, { isPrimaryOccupant: true }));
		await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, wife, { role: OCCUPANCY_ROLE.tenant }));

		const rows = await testDb.db.select().from(occupancies).where(eq(occupancies.unitId, unitId));
		expect(rows).toHaveLength(2);
	});

	it('refuses an end date earlier than the start date', async () => {
		const unitId = await createUnit();
		const residentId = await createResident();

		const refusal = await refused(
			testDb.db
				.insert(occupancies)
				.values(occupancy(unitId, residentId, { endedOn: BEFORE_START }))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'occupancies_date_order_check'
		});
	});

	it('accepts an end date on the start date, because the rule is earlier, not different', async () => {
		const unitId = await createUnit();
		const residentId = await createResident();

		const [row] = await testDb.db
			.insert(occupancies)
			.values(occupancy(unitId, residentId, { endedOn: STARTED_ON }))
			.returning();

		expect(row.endedOn).toBe(STARTED_ON);
	});

	it('refuses an occupancy role outside owner and tenant', async () => {
		// Written as SQL because the TypeScript type already refuses this value, and the rule under
		// test is the one in the database rather than the one in the type.
		const unitId = await createUnit();
		const residentId = await createResident();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into occupancies (unit_id, resident_id, role, started_on, created_at)
				    values (${unitId}, ${residentId}, 'guest', ${STARTED_ON}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'occupancies_role_check' });
	});
});

describe('invitations', () => {
	it('has no column a raw token could be written to', async () => {
		// The spec's rule is that the value in the link is never stored. The strongest thing the
		// database can say about that is that there is nowhere to put it: `token_hash` is the only
		// column that carries anything about the token.
		const result = await testDb.db.execute<{ columnName: string }>(
			sql`select column_name as "columnName" from information_schema.columns
			    where table_schema = ${testDb.schemaName} and table_name = 'invitations'
			    order by column_name`
		);

		expect(result.rows.map((row) => row.columnName)).toEqual([
			'created_at',
			'created_by',
			'email',
			'expires_at',
			'id',
			'token_hash',
			'unit_id',
			'used_at'
		]);
	});

	it('refuses two invitations carrying the same token digest', async () => {
		const unitId = await createUnit();
		const createdBy = randomUUID();
		await testDb.db.insert(user).values({
			id: createdBy,
			name: 'Superuser Uji',
			email: `${unique('superuser')}@komplek.local`,
			createdAt: NOW,
			updatedAt: NOW
		});
		const tokenHash = unique('digest');
		const invitation = {
			tokenHash,
			email: `${unique('undangan')}@komplek.local`,
			unitId,
			expiresAt: NOW,
			createdBy,
			createdAt: NOW
		};
		await testDb.db.insert(invitations).values(invitation);

		const refusal = await refused(
			testDb.db
				.insert(invitations)
				.values({ ...invitation, email: `${unique('undangan')}@komplek.local` })
				.execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'invitations_token_hash_unique'
		});
	});
});

describe('registrations', () => {
	function registration(email: string): typeof registrations.$inferInsert {
		return {
			name: 'Calon Warga',
			email,
			claimedBlock: 'C',
			claimedNumber: '12',
			status: REGISTRATION_STATUS.pending,
			createdAt: NOW
		};
	}

	it('refuses a second waiting registration for one address', async () => {
		const email = `${unique('pendaftar')}@komplek.local`;
		await testDb.db.insert(registrations).values(registration(email));

		const refusal = await refused(
			testDb.db.insert(registrations).values(registration(email)).execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'registrations_pending_email_unique'
		});
	});

	it('accepts a new registration once the previous one was turned down', async () => {
		const email = `${unique('pendaftar')}@komplek.local`;
		const [first] = await testDb.db.insert(registrations).values(registration(email)).returning();
		await testDb.db
			.update(registrations)
			.set({ status: REGISTRATION_STATUS.rejected, rejectionReason: 'Rumah itu sudah terisi.' })
			.where(eq(registrations.id, first.id));

		const [second] = await testDb.db.insert(registrations).values(registration(email)).returning();

		expect(second.status).toBe(REGISTRATION_STATUS.pending);
	});

	it('refuses a rejection reason on a registration that was not turned down', async () => {
		const email = `${unique('pendaftar')}@komplek.local`;

		const refusal = await refused(
			testDb.db
				.insert(registrations)
				.values({ ...registration(email), rejectionReason: 'Tidak pernah ditolak.' })
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'registrations_rejection_reason_check'
		});
	});

	it('refuses a status outside waiting, approved and turned down', async () => {
		// SQL again, for the same reason as the occupancy role above.
		const refusal = await refused(
			testDb.db.execute(
				sql`insert into registrations (name, email, claimed_block, claimed_number, status, created_at)
				    values ('Calon Warga', ${`${unique('pendaftar')}@komplek.local`}, 'C', '12', 'maybe', ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'registrations_status_check' });
	});
});

describe('subscriptions', () => {
	/** Any notification name. The column is free text, so the value is only a value. */
	const KIND = 'monthly_report';

	it('refuses two answers from one resident about one kind of notification', async () => {
		const residentId = await createResident();
		await testDb.db
			.insert(subscriptions)
			.values({ residentId, kind: KIND, enabled: true, createdAt: NOW });

		const refusal = await refused(
			testDb.db
				.insert(subscriptions)
				.values({ residentId, kind: KIND, enabled: false, createdAt: NOW })
				.execute()
		);

		expect(refusal).toEqual({
			code: UNIQUE_VIOLATION,
			constraint: 'subscriptions_resident_id_kind_unique'
		});
	});

	it('allows the same kind of notification for two residents', async () => {
		const first = await createResident();
		const second = await createResident();

		await testDb.db
			.insert(subscriptions)
			.values({ residentId: first, kind: KIND, enabled: true, createdAt: NOW });
		const [row] = await testDb.db
			.insert(subscriptions)
			.values({ residentId: second, kind: KIND, enabled: false, createdAt: NOW })
			.returning();

		expect(row.enabled).toBe(false);
	});
});

describe('the migration', () => {
	it.each(SPEC_TABLES)('created %s', async (tableName) => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = ${tableName}`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it('made the primary occupant index unique and partial', async () => {
		const result = await testDb.db.execute<{ indexdef: string }>(
			sql`select indexdef from pg_indexes
			    where schemaname = ${testDb.schemaName}
			      and indexname = 'occupancies_primary_occupant_unique'`
		);

		expect(result.rows[0]?.indexdef).toContain('CREATE UNIQUE INDEX');
		expect(result.rows[0]?.indexdef).toContain(
			'WHERE (is_primary_occupant AND (ended_on IS NULL))'
		);
	});

	it.each([
		['occupancies_date_order_check', 'CHECK (((ended_on IS NULL) OR (ended_on >= started_on)))'],
		['occupancies_role_check', "CHECK ((role = ANY (ARRAY['owner'::text, 'tenant'::text])))"],
		[
			'registrations_rejection_reason_check',
			"CHECK (((rejection_reason IS NULL) OR (status = 'rejected'::text)))"
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
