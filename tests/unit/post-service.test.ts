import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { readOrigin } from '$lib/server/auth';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { emailQueue } from '$lib/server/db/schema/email';
import { POST_STATUS, POST_TYPE, posts } from '$lib/server/db/schema/post';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { NEW_POST_KIND } from '$lib/server/email/templates/new-post';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import {
	archivePost,
	createPost,
	getPost,
	isAllowedPostTransition,
	listPosts,
	MAXIMUM_COVER_IMAGE_BYTES,
	POST_ARCHIVED_ACTION,
	POST_COVER_IMAGE_SET_ACTION,
	POST_CREATED_ACTION,
	POST_PUBLISHED_ACTION,
	POST_RULE,
	POST_UPDATED_ACTION,
	PostNotFoundError,
	PostRuleError,
	PostTransitionError,
	previewPostBody,
	publishPost,
	setPostCoverImage,
	updatePost,
	type PostContent
} from '$lib/server/services/post';
import { setSubscriptionPreference } from '$lib/server/services/subscription';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The Post service: who may write one, the type and status rules `docs/spec-konten-v1.md` left out
 * of the database on purpose, the audit trail, and the cover image going through the `FileStore`
 * port. `tests/unit/schema-post.test.ts` already proves the three database constraints, and
 * `tests/unit/markdown-sanitize.test.ts` proves the sanitizer; this file proves what the service
 * adds on top of both.
 */

const testDb = testDatabase();

const START = '2026-03-01T00:00:00.000Z';
const EVENT_START = new Date('2026-03-08T02:00:00.000Z');
const EVENT_END = new Date('2026-03-08T04:00:00.000Z');

/** Makes every title this file writes different from every other one, across every test. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any real sign-up. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** A signed-in account holding `role`, with the `residents` row a Post is attributed to. */
async function insertAccount(name: string, role?: Role): Promise<string> {
	const userId = await insertUser(name);
	if (role) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date(START) });
	}
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

/** An admin who may manage Posts and has somewhere to be attributed to. */
async function insertAdmin(name: string): Promise<string> {
	return insertAccount(name, ROLE.admin);
}

/** Switches `userId`'s own new-post Langganan on or off — for the publish-queues-email tests below. */
async function subscribeToNewPost(
	userId: string,
	clock: FakeClock,
	enabled: boolean
): Promise<void> {
	const [resident] = await testDb.db.select().from(residents).where(eq(residents.userId, userId));
	await setSubscriptionPreference(testDb.db, clock, {
		callerUserId: userId,
		residentId: resident.id,
		kind: SUBSCRIPTION_KIND.newPost,
		enabled
	});
}

/** The address `userId` signs in with, for asserting on who a queued email was addressed to. */
async function emailOf(userId: string): Promise<string> {
	const [row] = await testDb.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
	return row.email;
}

/** Every `new-post` queue row belonging to `postTitle`, since this file's schema is shared across tests. */
async function newPostRowsFor(postTitle: string) {
	const rows = await testDb.db.select().from(emailQueue).where(eq(emailQueue.kind, NEW_POST_KIND));
	return rows.filter((row) => row.payload.title === postTitle);
}

/** The content of a kegiatan, overridable field by field. */
function eventContent(overrides: Partial<PostContent> = {}): PostContent {
	return {
		type: POST_TYPE.event,
		title: unique('Kerja bakti'),
		summary: 'Kerja bakti bulanan di lapangan komplek.',
		bodyHtml: '<p>Bawa <strong>sapu</strong> dan cangkul.</p>',
		category: 'kerja-bakti',
		startsAt: EVENT_START,
		endsAt: EVENT_END,
		location: 'Lapangan komplek',
		...overrides
	};
}

/** The content of a pengumuman, overridable field by field. */
function announcementContent(overrides: Partial<PostContent> = {}): PostContent {
	return {
		type: POST_TYPE.announcement,
		title: unique('Perubahan jadwal'),
		summary: 'Jadwal pengambilan sampah berubah.',
		bodyHtml: '<p>Mulai pekan depan sampah diambil hari Selasa.</p>',
		category: 'umum',
		startsAt: null,
		endsAt: null,
		location: null,
		...overrides
	};
}

/** A one-pixel PNG, the smallest real image a cover-image test can upload. */
const PNG_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

/** The first bytes of a JPEG, for a test that only needs the signature to match. */
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('createPost', () => {
	it('writes a kegiatan as a draft and records who wrote it', async () => {
		const adminId = await insertAdmin('Pengurus Penulis');
		const clock = new FakeClock(START);
		const content = eventContent();

		const created = await createPost(testDb.db, clock, { actorId: adminId, ...content });

		expect(created).toMatchObject({
			type: POST_TYPE.event,
			title: content.title,
			status: POST_STATUS.draft,
			publishedAt: null,
			location: 'Lapangan komplek'
		});
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: adminId,
			action: POST_CREATED_ACTION,
			targetId: created.id
		});
	});

	it('attributes the Post to the author’s residents row, not to their account', async () => {
		const adminId = await insertAdmin('Pengurus Beridentitas');

		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...announcementContent()
		});

		const [author] = await testDb.db.select().from(residents).where(eq(residents.userId, adminId));
		expect(created.authorId).toBe(author.id);
	});

	it('trims the title, summary and body before storing them', async () => {
		const adminId = await insertAdmin('Pengurus Rapikan Post');
		const title = unique('Rapat');

		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...announcementContent({
				title: `  ${title}  `,
				summary: '  ringkas  ',
				bodyHtml: '  isi  '
			})
		});

		// The body is trimmed and then wrapped: plain text carries no tags, so the service gives it
		// the paragraph the public page needs — see `normalizePostBodyHtml`.
		expect(created).toMatchObject({ title, summary: 'ringkas', bodyHtml: '<p>isi</p>' });
	});

	it.each([
		['an empty title', { title: '   ' }],
		['an empty summary', { summary: '' }],
		['an empty body', { bodyHtml: '  \n ' }]
	])('rejects %s with a TypeError', async (_name, overrides) => {
		const adminId = await insertAdmin(unique('Pengurus Kosong'));

		await expect(
			createPost(testDb.db, new FakeClock(START), {
				actorId: adminId,
				...announcementContent(overrides)
			})
		).rejects.toThrow(TypeError);
	});

	it('refuses an admin who has no residents row to be attributed to', async () => {
		const userId = await insertUser('Pengurus Tanpa Data Warga');
		await testDb.db
			.insert(userRoles)
			.values({ userId, role: ROLE.admin, createdAt: new Date(START) });

		const failure = createPost(testDb.db, new FakeClock(START), {
			actorId: userId,
			...announcementContent()
		});

		await expect(failure).rejects.toThrow(PostRuleError);
		await expect(failure).rejects.toMatchObject({ rule: POST_RULE.authorNotRegistered });
	});
});

describe('the type rules the database deliberately does not hold', () => {
	it.each([
		[
			'a pengumuman with a start time',
			POST_RULE.announcementHasEventTimes,
			() => announcementContent({ startsAt: EVENT_START })
		],
		[
			'a pengumuman with an end time',
			POST_RULE.announcementHasEventTimes,
			() => announcementContent({ endsAt: EVENT_END })
		],
		[
			'a pengumuman with a place',
			POST_RULE.announcementHasEventTimes,
			() => announcementContent({ location: 'Balai warga' })
		],
		[
			'a kegiatan without a start time',
			POST_RULE.eventNeedsStartTime,
			() => eventContent({ startsAt: null, endsAt: null })
		],
		[
			'a kegiatan that ends before it starts',
			POST_RULE.endsBeforeStart,
			() => eventContent({ startsAt: EVENT_END, endsAt: EVENT_START })
		],
		[
			'a category nothing in the registry names',
			POST_RULE.unknownCategory,
			() => announcementContent({ category: 'karnaval' })
		]
	])('refuses %s, and writes nothing', async (_name, rule, build) => {
		const adminId = await insertAdmin(unique('Pengurus Aturan'));
		const content = build();

		const failure = createPost(testDb.db, new FakeClock(START), { actorId: adminId, ...content });

		await expect(failure).rejects.toThrow(PostRuleError);
		await expect(failure).rejects.toMatchObject({ rule });
		const page = await listPosts(testDb.db, { actorId: adminId, pageSize: 100 });
		expect(page.posts.map((row) => row.title)).not.toContain(content.title);
	});

	it('accepts a kegiatan whose end time equals its start time', async () => {
		const adminId = await insertAdmin('Pengurus Sekejap');

		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...eventContent({ startsAt: EVENT_START, endsAt: EVENT_START })
		});

		expect(created.endsAt).toEqual(EVENT_START);
	});

	it('applies the same rules to an edit as to a new Post', async () => {
		const adminId = await insertAdmin('Pengurus Sunting Salah');
		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...eventContent()
		});

		const failure = updatePost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			postId: created.id,
			...announcementContent({ startsAt: EVENT_START })
		});

		await expect(failure).rejects.toMatchObject({ rule: POST_RULE.announcementHasEventTimes });
	});
});

describe('updatePost', () => {
	it('replaces the content and leaves the status and publication time alone', async () => {
		const adminId = await insertAdmin('Pengurus Perubahan Jam');
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });
		const published = await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });
		const movedTo = new Date('2026-03-09T02:00:00.000Z');

		const updated = await updatePost(testDb.db, clock, {
			actorId: adminId,
			postId: created.id,
			...eventContent({ title: created.title, startsAt: movedTo, endsAt: null })
		});

		expect(updated).toMatchObject({
			startsAt: movedTo,
			endsAt: null,
			status: POST_STATUS.published,
			publishedAt: published.publishedAt
		});
	});

	it('records the change with what it was and what it became', async () => {
		const adminId = await insertAdmin('Pengurus Jejak Sunting');
		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...announcementContent({ category: 'umum' })
		});

		await updatePost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			postId: created.id,
			...announcementContent({ title: created.title, category: 'rapat' })
		});

		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries.find((entry) => entry.action === POST_UPDATED_ACTION)).toMatchObject({
			actorId: adminId,
			before: { category: 'umum' },
			after: { category: 'rapat' }
		});
	});

	it('throws PostNotFoundError for an id that names no Post', async () => {
		const adminId = await insertAdmin('Pengurus Sunting Hilang');

		await expect(
			updatePost(testDb.db, new FakeClock(START), {
				actorId: adminId,
				postId: randomUUID(),
				...announcementContent()
			})
		).rejects.toThrow(PostNotFoundError);
	});
});

describe('status transitions', () => {
	it.each([
		[POST_STATUS.draft, POST_STATUS.published, true],
		[POST_STATUS.published, POST_STATUS.archived, true],
		[POST_STATUS.archived, POST_STATUS.published, true],
		[POST_STATUS.draft, POST_STATUS.archived, false],
		[POST_STATUS.draft, POST_STATUS.draft, false],
		[POST_STATUS.published, POST_STATUS.draft, false],
		[POST_STATUS.published, POST_STATUS.published, false],
		[POST_STATUS.archived, POST_STATUS.draft, false],
		[POST_STATUS.archived, POST_STATUS.archived, false]
	])('%s to %s is allowed: %s', (from, to, expected) => {
		expect(isAllowedPostTransition(from, to)).toBe(expected);
	});

	it('publishes a draft and stamps when it reached the board', async () => {
		const adminId = await insertAdmin('Pengurus Terbit');
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });
		clock.advance(60 * 60 * 1000);

		const published = await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		expect(published.status).toBe(POST_STATUS.published);
		expect(published.publishedAt).toEqual(new Date('2026-03-01T01:00:00.000Z'));
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries.map((entry) => entry.action)).toContain(POST_PUBLISHED_ACTION);
	});

	it('archives a published Post without deleting the row', async () => {
		const adminId = await insertAdmin('Pengurus Arsip');
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const archived = await archivePost(testDb.db, clock, { actorId: adminId, postId: created.id });

		expect(archived.status).toBe(POST_STATUS.archived);
		const rows = await testDb.db.select().from(posts).where(eq(posts.id, created.id));
		expect(rows).toHaveLength(1);
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries.map((entry) => entry.action)).toContain(POST_ARCHIVED_ACTION);
	});

	it('keeps the first publication time when an archived Post is published again', async () => {
		const adminId = await insertAdmin('Pengurus Terbit Ulang');
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });
		const first = await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });
		await archivePost(testDb.db, clock, { actorId: adminId, postId: created.id });
		clock.advance(7 * 24 * 60 * 60 * 1000);

		const again = await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		expect(again.status).toBe(POST_STATUS.published);
		expect(again.publishedAt).toEqual(first.publishedAt);
	});

	it.each([
		['archiving a draft', false, archivePost],
		['publishing something already published', true, publishPost]
	])('refuses %s', async (_name, publishFirst, move) => {
		const adminId = await insertAdmin(unique('Pengurus Langkah Salah'));
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });
		if (publishFirst) {
			await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });
		}

		await expect(move(testDb.db, clock, { actorId: adminId, postId: created.id })).rejects.toThrow(
			PostTransitionError
		);
	});
});

describe('previewPostBody', () => {
	it('renders the sanitized body and changes nothing about the Post', async () => {
		const adminId = await insertAdmin('Pengurus Pratinjau');
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });

		const rendered = await previewPostBody(
			testDb.db,
			adminId,
			'<script>alert(1)</script><p>Bawa <strong>sapu</strong>.</p>'
		);

		expect(rendered).toBe('<p>Bawa <strong>sapu</strong>.</p>');
		expect(rendered).not.toContain('alert');
		const after = await getPost(testDb.db, adminId, created.id);
		expect(after.status).toBe(POST_STATUS.draft);
	});
});

describe('the cover image, through the FileStore port', () => {
	it('stores the bytes at a key built from the Post id and records it on the row', async () => {
		const adminId = await insertAdmin('Pengurus Sampul');
		const clock = new FakeClock(START);
		const store = new FakeFileStore(clock);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });

		const updated = await setPostCoverImage(testDb.db, clock, store, {
			actorId: adminId,
			postId: created.id,
			contentType: 'image/png',
			content: PNG_BYTES
		});

		expect(updated.coverImageKey).toBe(`posts/${created.id}/cover.png`);
		expect(store.keys).toEqual([`posts/${created.id}/cover.png`]);
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries.map((entry) => entry.action)).toContain(POST_COVER_IMAGE_SET_ACTION);
	});

	it('removes the previous file when the replacement is a different format', async () => {
		const adminId = await insertAdmin('Pengurus Ganti Sampul');
		const clock = new FakeClock(START);
		const store = new FakeFileStore(clock);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });
		const request = { actorId: adminId, postId: created.id };
		await setPostCoverImage(testDb.db, clock, store, {
			...request,
			contentType: 'image/png',
			content: PNG_BYTES
		});

		await setPostCoverImage(testDb.db, clock, store, {
			...request,
			contentType: 'image/jpeg',
			content: JPEG_BYTES
		});

		expect(store.keys).toEqual([`posts/${created.id}/cover.jpg`]);
	});

	it.each([
		[
			'a file that is not an accepted image type',
			POST_RULE.coverImageNotAnImage,
			'application/pdf',
			() => PNG_BYTES
		],
		[
			'a file whose bytes are not the format it claims',
			POST_RULE.coverImageNotAnImage,
			'image/png',
			() => new TextEncoder().encode('<script>alert(1)</script>')
		],
		[
			'a file past the size limit',
			POST_RULE.coverImageTooLarge,
			'image/png',
			() => new Uint8Array(MAXIMUM_COVER_IMAGE_BYTES + 1)
		],
		// #93: `Object.prototype` property names, once looked up in an object literal, answer with a
		// truthy inherited value that slips past an `if (!extension)` guard and ends in a `TypeError`
		// instead of a named `PostRuleError`. `COVER_IMAGE_EXTENSIONS`/`COVER_IMAGE_SIGNATURES` are now
		// `Map`s, which have no prototype chain behind `get`, so both are refused the same as any other
		// unrecognised content type.
		[
			'a content type spelling an Object.prototype property name — "constructor"',
			POST_RULE.coverImageNotAnImage,
			'constructor',
			() => PNG_BYTES
		],
		[
			'a content type spelling an Object.prototype property name — "__proto__"',
			POST_RULE.coverImageNotAnImage,
			'__proto__',
			() => PNG_BYTES
		]
	])('refuses %s, and stores nothing', async (_name, rule, contentType, build) => {
		const adminId = await insertAdmin(unique('Pengurus Berkas Salah'));
		const clock = new FakeClock(START);
		const store = new FakeFileStore(clock);
		const created = await createPost(testDb.db, clock, { actorId: adminId, ...eventContent() });

		const failure = setPostCoverImage(testDb.db, clock, store, {
			actorId: adminId,
			postId: created.id,
			contentType,
			content: build()
		});

		await expect(failure).rejects.toThrow(PostRuleError);
		await expect(failure).rejects.toMatchObject({ rule });
		expect(store.keys).toEqual([]);
	});
});

describe('listPosts and getPost', () => {
	it('lists drafts alongside published and archived Posts, newest first', async () => {
		const adminId = await insertAdmin('Pengurus Daftar');
		const clock = new FakeClock(START);
		const category = 'rapat';
		const older = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category })
		});
		clock.advance(60 * 1000);
		const newer = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: older.id });

		const page = await listPosts(testDb.db, { actorId: adminId, category, pageSize: 100 });

		// Narrowed to this test's own two rows: other tests in this file share the category, and the
		// claim being made here is about the order of these two, not about how many there are.
		const mine = page.posts.filter((row) => row.id === newer.id || row.id === older.id);
		expect(mine.map((row) => row.id)).toEqual([newer.id, older.id]);
		expect(mine.map((row) => row.status)).toEqual([POST_STATUS.draft, POST_STATUS.published]);
	});

	it('filters by status, by type and by category', async () => {
		const adminId = await insertAdmin('Pengurus Saring');
		const clock = new FakeClock(START);
		const category = 'perayaan';
		const event = await createPost(testDb.db, clock, {
			actorId: adminId,
			...eventContent({ category })
		});
		await createPost(testDb.db, clock, { actorId: adminId, ...announcementContent({ category }) });
		await publishPost(testDb.db, clock, { actorId: adminId, postId: event.id });

		const byStatus = await listPosts(testDb.db, {
			actorId: adminId,
			category,
			status: POST_STATUS.published
		});
		const byType = await listPosts(testDb.db, {
			actorId: adminId,
			category,
			type: POST_TYPE.announcement
		});

		expect(byStatus.posts.map((row) => row.id)).toEqual([event.id]);
		expect(byType.posts.map((row) => row.type)).toEqual([POST_TYPE.announcement]);
	});

	it('paginates, reporting the total count across every page', async () => {
		const adminId = await insertAdmin('Pengurus Halaman Post');
		const clock = new FakeClock(START);
		const category = 'posyandu';
		for (let index = 0; index < 3; index += 1) {
			await createPost(testDb.db, clock, {
				actorId: adminId,
				...announcementContent({ category })
			});
			clock.advance(1000);
		}

		const first = await listPosts(testDb.db, { actorId: adminId, category, page: 1, pageSize: 2 });
		const second = await listPosts(testDb.db, { actorId: adminId, category, page: 2, pageSize: 2 });

		expect(first.posts).toHaveLength(2);
		expect(first.totalCount).toBe(3);
		expect(second.posts).toHaveLength(1);
	});

	it('carries the author’s name, so an admin can see who wrote it', async () => {
		const adminId = await insertAdmin('Pengurus Bernama');
		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...announcementContent()
		});

		const detail = await getPost(testDb.db, adminId, created.id);

		expect(detail.authorName).toBe('Pengurus Bernama');
	});

	it('throws PostNotFoundError for an id that names no Post', async () => {
		const adminId = await insertAdmin('Pengurus Cari Post');

		await expect(getPost(testDb.db, adminId, randomUUID())).rejects.toThrow(PostNotFoundError);
	});
});

describe('permission', () => {
	it.each([
		['listPosts', async (actorId: string) => listPosts(testDb.db, { actorId })],
		['getPost', async (actorId: string) => getPost(testDb.db, actorId, randomUUID())],
		['previewPostBody', async (actorId: string) => previewPostBody(testDb.db, actorId, 'halo')],
		[
			'createPost',
			async (actorId: string) =>
				createPost(testDb.db, new FakeClock(START), { actorId, ...announcementContent() })
		],
		[
			'updatePost',
			async (actorId: string) =>
				updatePost(testDb.db, new FakeClock(START), {
					actorId,
					postId: randomUUID(),
					...announcementContent()
				})
		],
		[
			'publishPost',
			async (actorId: string) =>
				publishPost(testDb.db, new FakeClock(START), { actorId, postId: randomUUID() })
		],
		[
			'archivePost',
			async (actorId: string) =>
				archivePost(testDb.db, new FakeClock(START), { actorId, postId: randomUUID() })
		],
		[
			'setPostCoverImage',
			async (actorId: string) =>
				setPostCoverImage(
					testDb.db,
					new FakeClock(START),
					new FakeFileStore(new FakeClock(START)),
					{
						actorId,
						postId: randomUUID(),
						contentType: 'image/png',
						content: PNG_BYTES
					}
				)
		]
	])('%s rejects a resident with PermissionDeniedError', async (_name, run) => {
		const residentId = await insertAccount(unique('Warga Percobaan Post'));

		await expect(run(residentId)).rejects.toThrow(PermissionDeniedError);
	});

	it('refuses a superuser who is not also an admin, because the roles are a set and not a ladder', async () => {
		const superuserId = await insertAccount('Pengurus Utama Bukan Admin', ROLE.superuser);

		await expect(
			createPost(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				...announcementContent()
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	it('lets an account holding both admin and superuser write a Post', async () => {
		const bothId = await insertAdmin('Pengurus Dua Peran');
		await testDb.db
			.insert(userRoles)
			.values({ userId: bothId, role: ROLE.superuser, createdAt: new Date(START) });

		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: bothId,
			...announcementContent()
		});

		expect(created.status).toBe(POST_STATUS.draft);
	});
});

describe('publishing queues the new-post email — #41', () => {
	// This describe block's own tests are the only ones in the file that call
	// `subscribeToNewPost`, and a subscription row outlives the test that wrote it — the schema is
	// shared for the whole file, per `testDatabase()`'s contract. So a test that needs to prove
	// "nobody was notified" runs first, before any sibling test leaves a resident subscribed behind
	// it, and every other test below asserts on its own subscriber's rows by recipient rather than
	// on the total row count for a title, which a later, unrelated subscriber would also appear in
	// — correctly: a resident who is subscribed is notified about every Post published after they
	// subscribed, not only about the one the test that subscribed them happened to be about.
	it('is opt-in and off by default: nobody is notified when nobody has switched it on', async () => {
		const adminId = await insertAdmin(unique('Pengurus Terbit Sunyi'));
		const clock = new FakeClock(START);
		await insertAccount(unique('Warga Diam Saja'));
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent()
		});

		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		expect(await newPostRowsFor(created.title)).toEqual([]);
	});

	it('queues one email to a resident subscribed to new-post, and none to one who is not', async () => {
		const adminId = await insertAdmin(unique('Pengurus Kirim Email'));
		const clock = new FakeClock(START);
		const subscriberId = await insertAccount(unique('Warga Ikut Notifikasi'));
		await subscribeToNewPost(subscriberId, clock, true);
		const othersId = await insertAccount(unique('Warga Tanpa Notifikasi'));
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent()
		});

		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const recipients = (await newPostRowsFor(created.title)).map((row) => row.recipient);
		expect(recipients).toContain(await emailOf(subscriberId));
		expect(recipients).not.toContain(await emailOf(othersId));
	});

	it('carries the title, the summary and an absolute link to the public page — never the body', async () => {
		const adminId = await insertAdmin(unique('Pengurus Isi Email'));
		const clock = new FakeClock(START);
		const subscriberId = await insertAccount(unique('Warga Baca Isi Email'));
		await subscribeToNewPost(subscriberId, clock, true);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({
				bodyHtml: '<p>Isi lengkap yang tidak boleh pernah muncul di email.</p>'
			})
		});

		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const subscriberEmail = await emailOf(subscriberId);
		const own = (await newPostRowsFor(created.title)).find(
			(candidate) => candidate.recipient === subscriberEmail
		);
		if (!own) {
			throw new Error('Expected a queued row for the subscribed resident, and found none.');
		}
		expect(own.payload).toMatchObject({
			title: created.title,
			summary: created.summary,
			url: `${readOrigin()}/posts/${created.id}`,
			locale: 'id'
		});
		expect(JSON.stringify(own.payload)).not.toContain(created.bodyHtml);
	});

	it('does not queue a second email when an already-published Post is edited', async () => {
		const adminId = await insertAdmin(unique('Pengurus Sunting Terbit'));
		const clock = new FakeClock(START);
		const subscriberId = await insertAccount(unique('Warga Amati Sunting'));
		await subscribeToNewPost(subscriberId, clock, true);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent()
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		await updatePost(testDb.db, clock, {
			actorId: adminId,
			postId: created.id,
			...announcementContent({ title: created.title, summary: 'Ringkasan yang sudah disunting.' })
		});

		const subscriberEmail = await emailOf(subscriberId);
		const mine = (await newPostRowsFor(created.title)).filter(
			(row) => row.recipient === subscriberEmail
		);
		expect(mine).toHaveLength(1);
	});

	it('does not queue a second email when an archived Post is published again', async () => {
		const adminId = await insertAdmin(unique('Pengurus Terbit Ulang Email'));
		const clock = new FakeClock(START);
		const subscriberId = await insertAccount(unique('Warga Amati Terbit Ulang'));
		await subscribeToNewPost(subscriberId, clock, true);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent()
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });
		await archivePost(testDb.db, clock, { actorId: adminId, postId: created.id });

		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const subscriberEmail = await emailOf(subscriberId);
		const mine = (await newPostRowsFor(created.title)).filter(
			(row) => row.recipient === subscriberEmail
		);
		expect(mine).toHaveLength(1);
	});

	it('lets a test replace the notifier, so a publish can be asserted on without a real email write', async () => {
		const adminId = await insertAdmin(unique('Pengurus Suntik Notifikasi'));
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent()
		});
		let notifiedPostId: string | undefined;

		await publishPost(
			testDb.db,
			clock,
			{ actorId: adminId, postId: created.id },
			{
				notify: async (_db, _clock, post) => {
					notifiedPostId = post.id;
				}
			}
		);

		expect(notifiedPostId).toBe(created.id);
		expect(await newPostRowsFor(created.title)).toEqual([]);
	});
});
