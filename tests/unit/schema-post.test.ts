import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	POST_STATUS,
	POST_TYPE,
	posts,
	residents,
	user,
	type NewPost
} from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';

/**
 * The `posts` schema, tested against PostgreSQL rather than against a service that does not exist
 * yet. Every rejection is asserted on PostgreSQL's own `SQLSTATE` and on the name of the constraint
 * that produced it, the same discipline `tests/unit/schema-resident-unit.test.ts` follows: a rule
 * that only lived in TypeScript would pass a test that called a service and got a tidy error back,
 * and this file has no service to call.
 *
 * What is deliberately not tested here: that an `announcement` may not carry `startsAt`, `endsAt`
 * or `location`, and that an `event` needs a `startsAt` before it may be published. Both are
 * service-layer rules by the ticket's own design — see the doc comment on `posts` in
 * `src/lib/server/db/schema/post.ts` — and belong to the ticket that builds that service.
 */

const testDb = testDatabase();

/** Every instant this file writes that is not under test. No row here has a database default for it. */
const NOW = new Date('2026-04-01T09:00:00.000Z');

/** When the kegiatan in this file starts. */
const STARTS_AT = new Date('2026-05-01T09:00:00.000Z');

/** After `STARTS_AT`. */
const AFTER_STARTS_AT = new Date('2026-05-01T12:00:00.000Z');

/** Before `STARTS_AT`. */
const BEFORE_STARTS_AT = new Date('2026-04-30T09:00:00.000Z');

/** PostgreSQL's `check_violation`. */
const CHECK_VIOLATION = '23514';

/** What PostgreSQL said when it refused a statement. */
interface DatabaseRefusal {
	readonly code: string;
	readonly constraint: string | undefined;
}

/** Makes every email and category in this file different from every other one. */
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
async function createAuthor(): Promise<string> {
	const id = randomUUID();
	await testDb.db.insert(user).values({
		id,
		name: 'Admin Uji',
		email: `${unique('admin')}@komplek.local`,
		createdAt: NOW,
		updatedAt: NOW
	});
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId: id, createdAt: NOW })
		.returning();
	return row.id;
}

/** A Post every constraint accepts, for a test to spoil one field of. */
function post(authorId: string, overrides: Partial<NewPost> = {}): NewPost {
	return {
		type: POST_TYPE.announcement,
		title: 'Pengumuman uji',
		summary: 'Ringkasan uji',
		bodyMarkdown: '# Pengumuman uji',
		category: 'umum',
		status: POST_STATUS.draft,
		authorId,
		createdAt: NOW,
		...overrides
	};
}

describe('posts', () => {
	it('stores every column an announcement uses', async () => {
		const authorId = await createAuthor();

		const [row] = await testDb.db
			.insert(posts)
			.values(
				post(authorId, {
					title: 'Rapat warga bulan April',
					summary: 'Rapat rutin bulanan',
					bodyMarkdown: '## Agenda\n- Iuran\n- Keamanan',
					coverImageKey: 'posts/rapat-april/cover.jpg',
					category: 'rapat',
					status: POST_STATUS.published,
					publishedAt: NOW
				})
			)
			.returning();

		expect(row).toMatchObject({
			type: POST_TYPE.announcement,
			title: 'Rapat warga bulan April',
			summary: 'Rapat rutin bulanan',
			bodyMarkdown: '## Agenda\n- Iuran\n- Keamanan',
			coverImageKey: 'posts/rapat-april/cover.jpg',
			category: 'rapat',
			status: POST_STATUS.published,
			authorId,
			startsAt: null,
			endsAt: null,
			location: null
		});
		expect(row.publishedAt?.getTime()).toBe(NOW.getTime());
		expect(row.createdAt.getTime()).toBe(NOW.getTime());
	});

	it('stores the time and place columns an event uses', async () => {
		const authorId = await createAuthor();

		const [row] = await testDb.db
			.insert(posts)
			.values(
				post(authorId, {
					type: POST_TYPE.event,
					category: 'posyandu',
					startsAt: STARTS_AT,
					endsAt: AFTER_STARTS_AT,
					location: 'Balai warga'
				})
			)
			.returning();

		expect(row.type).toBe(POST_TYPE.event);
		expect(row.location).toBe('Balai warga');
		expect(row.startsAt?.getTime()).toBe(STARTS_AT.getTime());
		expect(row.endsAt?.getTime()).toBe(AFTER_STARTS_AT.getTime());
	});

	it('leaves the cover image key null until one is uploaded', async () => {
		const authorId = await createAuthor();

		const [row] = await testDb.db.insert(posts).values(post(authorId)).returning();

		expect(row.coverImageKey).toBeNull();
	});

	it('refuses a type outside event and announcement', async () => {
		// Written as SQL because the TypeScript type already refuses this value, and the rule under
		// test is the one in the database rather than the one in the type.
		const authorId = await createAuthor();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into posts (type, title, summary, body_markdown, category, status, author_id, created_at)
				    values ('webinar', 'Judul', 'Ringkasan', 'Isi', 'umum', ${POST_STATUS.draft}, ${authorId}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'posts_type_check' });
	});

	it('refuses a status outside draft, published and archived', async () => {
		const authorId = await createAuthor();

		const refusal = await refused(
			testDb.db.execute(
				sql`insert into posts (type, title, summary, body_markdown, category, status, author_id, created_at)
				    values (${POST_TYPE.announcement}, 'Judul', 'Ringkasan', 'Isi', 'umum', 'sudah-terbit', ${authorId}, ${NOW})`
			)
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'posts_status_check' });
	});

	it('refuses an end time earlier than the start time', async () => {
		const authorId = await createAuthor();

		const refusal = await refused(
			testDb.db
				.insert(posts)
				.values(
					post(authorId, {
						type: POST_TYPE.event,
						startsAt: STARTS_AT,
						endsAt: BEFORE_STARTS_AT
					})
				)
				.execute()
		);

		expect(refusal).toEqual({ code: CHECK_VIOLATION, constraint: 'posts_time_order_check' });
	});

	it('accepts an end time equal to the start time, because the rule is earlier, not different', async () => {
		const authorId = await createAuthor();

		const [row] = await testDb.db
			.insert(posts)
			.values(
				post(authorId, {
					type: POST_TYPE.event,
					startsAt: STARTS_AT,
					endsAt: STARTS_AT
				})
			)
			.returning();

		expect(row.endsAt?.getTime()).toBe(STARTS_AT.getTime());
	});

	it('accepts an event whose end time is not known yet', async () => {
		const authorId = await createAuthor();

		const [row] = await testDb.db
			.insert(posts)
			.values(post(authorId, { type: POST_TYPE.event, startsAt: STARTS_AT }))
			.returning();

		expect(row.startsAt?.getTime()).toBe(STARTS_AT.getTime());
		expect(row.endsAt).toBeNull();
	});

	it('accepts an announcement with no start time, end time or location', async () => {
		const authorId = await createAuthor();

		const [row] = await testDb.db.insert(posts).values(post(authorId)).returning();

		expect(row).toMatchObject({ startsAt: null, endsAt: null, location: null });
	});
});

describe('the migration', () => {
	it('created posts', async () => {
		const result = await testDb.db.execute<{ total: string }>(
			sql`select count(*) as total from information_schema.tables
			    where table_schema = ${testDb.schemaName} and table_name = 'posts'`
		);

		expect(result.rows[0]?.total).toBe('1');
	});

	it.each(['posts_status_idx', 'posts_type_idx', 'posts_category_idx', 'posts_starts_at_idx'])(
		'creates the %s index',
		async (indexName) => {
			const result = await testDb.db.execute<{ total: string }>(
				sql`select count(*) as total from pg_indexes
				    where schemaname = ${testDb.schemaName} and indexname = ${indexName}`
			);

			expect(result.rows[0]?.total).toBe('1');
		}
	);

	it.each([
		['posts_type_check', "CHECK ((type = ANY (ARRAY['event'::text, 'announcement'::text])))"],
		[
			'posts_status_check',
			"CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))"
		],
		[
			'posts_time_order_check',
			'CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (ends_at >= starts_at)))'
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
});
