import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaintAttachments,
	complaintReplies,
	complaints,
	complaintStatusChanges,
	residents,
	user,
	type NewComplaint
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The `complaints` schema (Keluhan, Lampiran, Riwayat Status, Tanggapan), tested against
 * PostgreSQL rather than against a service that does not exist yet — the same discipline
 * `tests/unit/schema-post.test.ts` and `tests/unit/schema-resident-unit.test.ts` follow. Every
 * rejection is asserted on PostgreSQL's own `SQLSTATE` and on the name of the constraint that
 * produced it.
 *
 * What is deliberately not tested here, because it is a service-layer rule per
 * `docs/spec-keluhan-v1.md` and this ticket builds no service: which status transitions are
 * allowed, that a rejection requires a typed reason, that only the reporter may withdraw and only
 * while `new`, that visibility only moves from `public` to `private`, and the "at most three
 * attachments" limit.
 */

const testDb = testDatabase();

/** Every instant this file writes that is not under test. No row here has a database default for it. */
const NOW = new Date('2026-04-01T09:00:00.000Z');

/** PostgreSQL's `check_violation`. */
const CHECK_VIOLATION = '23514';

/** What PostgreSQL said when it refused a statement. */
interface DatabaseRefusal {
	readonly code: string;
	readonly constraint: string | undefined;
}

/** Makes every email in this file different from every other one. */
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

/** A Keluhan every constraint accepts, for a test to spoil one field of. */
function complaint(reporterId: string, overrides: Partial<NewComplaint> = {}): NewComplaint {
	return {
		reporterId,
		title: 'Lampu jalan mati',
		category: 'penerangan',
		description: 'Lampu di depan blok C mati sejak tiga hari lalu.',
		status: COMPLAINT_STATUS.new,
		visibility: COMPLAINT_VISIBILITY.private,
		createdAt: NOW,
		statusChangedAt: NOW,
		...overrides
	};
}

/** Inserts a Keluhan every constraint accepts. Returns its id. */
async function createComplaint(
	reporterId: string,
	overrides: Partial<NewComplaint> = {}
): Promise<string> {
	const [row] = await testDb.db
		.insert(complaints)
		.values(complaint(reporterId, overrides))
		.returning();
	return row.id;
}

describe('complaints', () => {
	it('stores every column a Keluhan uses', async () => {
		const reporterId = await createResident();

		const [row] = await testDb.db
			.insert(complaints)
			.values(
				complaint(reporterId, {
					title: 'Saluran air tersumbat',
					category: 'drainase',
					description: 'Air menggenang di depan blok B.',
					visibility: COMPLAINT_VISIBILITY.public
				})
			)
			.returning();

		expect(row).toMatchObject({
			reporterId,
			title: 'Saluran air tersumbat',
			category: 'drainase',
			description: 'Air menggenang di depan blok B.',
			status: COMPLAINT_STATUS.new,
			visibility: COMPLAINT_VISIBILITY.public,
			rejectionReason: null
		});
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
		expect(row.statusChangedAt.getTime()).toBe(NOW.getTime());
	});

	it('accepts a rejection reason on a Keluhan that was rejected', async () => {
		const reporterId = await createResident();

		const [row] = await testDb.db
			.insert(complaints)
			.values(
				complaint(reporterId, {
					status: COMPLAINT_STATUS.rejected,
					rejectionReason: 'Sudah ditangani lewat laporan lain.'
				})
			)
			.returning();

		expect(row.rejectionReason).toBe('Sudah ditangani lewat laporan lain.');
	});

	it('refuses a rejection reason on a Keluhan that was not rejected', async () => {
		const reporterId = await createResident();

		const refusal = await refused(
			testDb.db
				.insert(complaints)
				.values(complaint(reporterId, { rejectionReason: 'Tidak pernah ditolak.' }))
				.execute()
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'complaints_rejection_reason_check'
		});
	});

	it('refuses a status outside the six values the domain defines', async () => {
		// Written as SQL because the TypeScript type already refuses this value, and the rule under
		// test is the one in the database rather than the one in the type.
		const reporterId = await createResident();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into complaints (reporter_id, title, category, description, status, visibility, created_at, status_changed_at)
				    values (${reporterId}, 'Judul', 'kategori', 'Uraian', 'in-progress', ${COMPLAINT_VISIBILITY.private}, ${NOW}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'complaints_status_check' });
	});

	it('refuses a visibility outside private and public', async () => {
		const reporterId = await createResident();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into complaints (reporter_id, title, category, description, status, visibility, created_at, status_changed_at)
				    values (${reporterId}, 'Judul', 'kategori', 'Uraian', ${COMPLAINT_STATUS.new}, 'neighbors', ${NOW}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'complaints_visibility_check' });
	});
});

describe('complaint_attachments', () => {
	it('stores the file key and the Keluhan it belongs to', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);

		const [row] = await testDb.db
			.insert(complaintAttachments)
			.values({ complaintId, fileKey: 'complaints/foo/1.jpg', createdAt: NOW })
			.returning();

		expect(row).toMatchObject({ complaintId, fileKey: 'complaints/foo/1.jpg' });
	});

	it('is removed when its Keluhan is removed', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		await testDb.db
			.insert(complaintAttachments)
			.values({ complaintId, fileKey: 'complaints/foo/1.jpg', createdAt: NOW });

		await testDb.db.delete(complaints).where(eq(complaints.id, complaintId));

		const rows = await testDb.db
			.select()
			.from(complaintAttachments)
			.where(eq(complaintAttachments.complaintId, complaintId));
		expect(rows).toHaveLength(0);
	});
});

describe('complaint_status_changes', () => {
	it('stores a status transition', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const actorId = await createResident();

		const [row] = await testDb.db
			.insert(complaintStatusChanges)
			.values({
				complaintId,
				oldStatus: COMPLAINT_STATUS.new,
				newStatus: COMPLAINT_STATUS.reviewing,
				actorId,
				note: 'Sedang ditinjau.',
				occurredAt: NOW
			})
			.returning();

		expect(row).toMatchObject({
			complaintId,
			oldStatus: COMPLAINT_STATUS.new,
			newStatus: COMPLAINT_STATUS.reviewing,
			actorId,
			note: 'Sedang ditinjau.'
		});
	});

	it('leaves the note null when none was written', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const actorId = await createResident();

		const [row] = await testDb.db
			.insert(complaintStatusChanges)
			.values({
				complaintId,
				oldStatus: COMPLAINT_STATUS.new,
				newStatus: COMPLAINT_STATUS.reviewing,
				actorId,
				occurredAt: NOW
			})
			.returning();

		expect(row.note).toBeNull();
	});

	it('refuses an old status outside the six values the domain defines', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const actorId = await createResident();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into complaint_status_changes (complaint_id, old_status, new_status, actor_id, occurred_at)
				    values (${complaintId}, 'in-progress', ${COMPLAINT_STATUS.reviewing}, ${actorId}, ${NOW})`
			)
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'complaint_status_changes_old_status_check'
		});
	});

	it('refuses a new status outside the six values the domain defines', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const actorId = await createResident();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into complaint_status_changes (complaint_id, old_status, new_status, actor_id, occurred_at)
				    values (${complaintId}, ${COMPLAINT_STATUS.new}, 'in-progress', ${actorId}, ${NOW})`
			)
		);

		expect(refusal).toEqual({
			code: CHECK_VIOLATION,
			constraint: 'complaint_status_changes_new_status_check'
		});
	});

	it('is removed when its Keluhan is removed', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const actorId = await createResident();
		await testDb.db.insert(complaintStatusChanges).values({
			complaintId,
			oldStatus: COMPLAINT_STATUS.new,
			newStatus: COMPLAINT_STATUS.reviewing,
			actorId,
			occurredAt: NOW
		});

		await testDb.db.delete(complaints).where(eq(complaints.id, complaintId));

		const rows = await testDb.db
			.select()
			.from(complaintStatusChanges)
			.where(eq(complaintStatusChanges.complaintId, complaintId));
		expect(rows).toHaveLength(0);
	});
});

describe('complaint_replies', () => {
	it('stores the author and the content', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const authorId = await createResident();

		const [row] = await testDb.db
			.insert(complaintReplies)
			.values({ complaintId, authorId, content: 'Sudah kami tindak lanjuti.', createdAt: NOW })
			.returning();

		expect(row).toMatchObject({ complaintId, authorId, content: 'Sudah kami tindak lanjuti.' });
	});

	it('is removed when its Keluhan is removed', async () => {
		const reporterId = await createResident();
		const complaintId = await createComplaint(reporterId);
		const authorId = await createResident();
		await testDb.db
			.insert(complaintReplies)
			.values({ complaintId, authorId, content: 'Sudah kami tindak lanjuti.', createdAt: NOW });

		await testDb.db.delete(complaints).where(eq(complaints.id, complaintId));

		const rows = await testDb.db
			.select()
			.from(complaintReplies)
			.where(eq(complaintReplies.complaintId, complaintId));
		expect(rows).toHaveLength(0);
	});
});

describe('the migration', () => {
	it.each(['complaints', 'complaint_attachments', 'complaint_status_changes', 'complaint_replies'])(
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
		'complaints_status_idx',
		'complaints_category_idx',
		'complaints_status_changed_at_idx',
		'complaint_attachments_complaint_id_idx',
		'complaint_status_changes_complaint_id_idx',
		'complaint_replies_complaint_id_idx'
	])('creates the %s index', async (indexName) => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from pg_indexes
			    where schemaname = ${testDb.schemaName} and indexname = ${indexName}`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it.each([
		[
			'complaints_status_check',
			"CHECK ((status = ANY (ARRAY['new'::text, 'reviewing'::text, 'working'::text, 'resolved'::text, 'rejected'::text, 'withdrawn'::text])))"
		],
		[
			'complaints_visibility_check',
			"CHECK ((visibility = ANY (ARRAY['private'::text, 'public'::text])))"
		],
		[
			'complaints_rejection_reason_check',
			"CHECK (((rejection_reason IS NULL) OR (status = 'rejected'::text)))"
		],
		[
			'complaint_status_changes_old_status_check',
			"CHECK ((old_status = ANY (ARRAY['new'::text, 'reviewing'::text, 'working'::text, 'resolved'::text, 'rejected'::text, 'withdrawn'::text])))"
		],
		[
			'complaint_status_changes_new_status_check',
			"CHECK ((new_status = ANY (ARRAY['new'::text, 'reviewing'::text, 'working'::text, 'resolved'::text, 'rejected'::text, 'withdrawn'::text])))"
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
