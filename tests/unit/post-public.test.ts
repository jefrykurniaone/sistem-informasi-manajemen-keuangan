import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { posts, POST_TYPE } from '$lib/server/db/schema/post';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	archivePost,
	createPost,
	publishPost,
	PostNotFoundError,
	type PostContent
} from '$lib/server/services/post';
import {
	getPublishedPost,
	listPublicPosts,
	renderPublicPostBody,
	POST_WHEN
} from '$lib/server/services/post/public';

/**
 * The announcement board's public reading side: what a visitor with no session may see through
 * `listPublicPosts` and `getPublishedPost`. `tests/unit/post-service.test.ts` already proves the
 * write side and the type/status rules; this file proves the one thing `./public.ts` exists for —
 * that a `draft` or an `archived` Post never reaches a public read, including by a guessed id — and
 * the ordering `docs/spec-konten-v1.md`'s testing decision asks for with a fake clock.
 *
 * Most tests here narrow a result down to the ids they themselves created before asserting on it,
 * the same technique `post-service.test.ts`'s "lists drafts alongside published…" test explains:
 * `posts.category` only has five legal values, this file's tests share the one schema, and the
 * claim under test is about these rows' order or visibility, not about how many rows exist in
 * total. The one exception is the pagination test, which needs an exact count and so reserves a
 * category — `rapat` — that no other test in this file publishes into.
 */

const testDb = testDatabase();

const START = '2026-03-10T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** An admin who may manage Posts and has a `residents` row to be attributed to. */
async function insertAdmin(name: string): Promise<string> {
	const userId = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.admin, createdAt: new Date(START) });
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

/** The content of a kegiatan, overridable field by field. */
function eventContent(overrides: Partial<PostContent> = {}): PostContent {
	return {
		type: POST_TYPE.event,
		title: unique('Kerja bakti publik'),
		summary: 'Kerja bakti bulanan di lapangan komplek.',
		bodyHtml: '<p>Bawa <strong>sapu</strong> dan cangkul.</p>',
		category: 'kerja-bakti',
		startsAt: new Date(START),
		endsAt: null,
		location: 'Lapangan komplek',
		...overrides
	};
}

/** The content of a pengumuman, overridable field by field. */
function announcementContent(overrides: Partial<PostContent> = {}): PostContent {
	return {
		type: POST_TYPE.announcement,
		title: unique('Pengumuman publik'),
		summary: 'Jadwal pengambilan sampah berubah.',
		bodyHtml: '<p>Mulai pekan depan sampah diambil hari Selasa.</p>',
		category: 'umum',
		startsAt: null,
		endsAt: null,
		location: null,
		...overrides
	};
}

describe('getPublishedPost', () => {
	it('returns a published Post with its content', async () => {
		const adminId = await insertAdmin(unique('Pengurus Publik Terbit'));
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...eventContent({ category: 'umum', title: unique('Rapat warga publik') })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const found = await getPublishedPost(testDb.db, created.id);

		expect(found).toMatchObject({
			id: created.id,
			title: created.title,
			bodyHtml: created.bodyHtml
		});
	});

	it('throws PostNotFoundError for a draft Post, even though the id is real', async () => {
		const adminId = await insertAdmin(unique('Pengurus Publik Draf'));
		const created = await createPost(testDb.db, new FakeClock(START), {
			actorId: adminId,
			...announcementContent({ category: 'umum' })
		});

		const failure = getPublishedPost(testDb.db, created.id);

		await expect(failure).rejects.toThrow(PostNotFoundError);
		await expect(failure).rejects.toMatchObject({ postId: created.id });
	});

	it('throws PostNotFoundError for an archived Post, even though the id is real', async () => {
		const adminId = await insertAdmin(unique('Pengurus Publik Arsip'));
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'umum' })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });
		await archivePost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const failure = getPublishedPost(testDb.db, created.id);

		await expect(failure).rejects.toThrow(PostNotFoundError);
	});

	it('throws PostNotFoundError for an id that names no Post at all', async () => {
		await expect(getPublishedPost(testDb.db, randomUUID())).rejects.toThrow(PostNotFoundError);
	});

	it('throws PostNotFoundError for an id that is not shaped like a uuid at all, without querying the database — #111', async () => {
		// `posts.id` is a `uuid` column; comparing it to something that is not shaped like one is a
		// PostgreSQL query error, not "no row". `new` is the id the linked issue was opened over —
		// the sibling static route segment `/admin/posts/new` — but any non-uuid string must answer
		// the same way.
		await expect(getPublishedPost(testDb.db, 'new')).rejects.toThrow(PostNotFoundError);
		await expect(getPublishedPost(testDb.db, 'abc')).rejects.toThrow(PostNotFoundError);
		await expect(getPublishedPost(testDb.db, '1')).rejects.toThrow(PostNotFoundError);
	});
});

describe('renderPublicPostBody', () => {
	it('renders a Post written through the service with its <strong> intact', async () => {
		const adminId = await insertAdmin(unique('Pengurus Publik Tebal'));
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({
				category: 'umum',
				title: unique('Pengumuman tebal'),
				bodyHtml: '<p>Bawa <strong>sapu</strong>.</p>'
			})
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const found = await getPublishedPost(testDb.db, created.id);

		expect(renderPublicPostBody(found.bodyHtml)).toBe('<p>Bawa <strong>sapu</strong>.</p>');
	});

	it('filters a stored body again, so narrowing the whitelist reaches rows already written', async () => {
		// The row is written straight to the table rather than through the service — which is what a
		// row written before the whitelist last changed looks like from here. The render pass is the
		// last thing standing between it and a visitor's browser.
		const adminId = await insertAdmin(unique('Pengurus Publik Kotor'));
		const clock = new FakeClock(START);
		const created = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'umum', title: unique('Pengumuman kotor') })
		});
		await testDb.db
			.update(posts)
			.set({ bodyHtml: '<p onclick="steal()">halo</p><script>alert(1)</script>' })
			.where(eq(posts.id, created.id));
		await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });

		const found = await getPublishedPost(testDb.db, created.id);

		expect(renderPublicPostBody(found.bodyHtml)).toBe('<p>halo</p>');
	});
});

describe('listPublicPosts', () => {
	it('never returns a draft or an archived Post', async () => {
		const adminId = await insertAdmin(unique('Pengurus Publik Saring'));
		const clock = new FakeClock(START);
		const draft = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'umum' })
		});
		const published = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'umum' })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: published.id });
		const archived = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'umum' })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: archived.id });
		await archivePost(testDb.db, clock, { actorId: adminId, postId: archived.id });

		const result = await listPublicPosts(testDb.db, clock, { category: 'umum', pageSize: 200 });

		// Narrowed to this test's own three rows: `umum` is the default category most other tests in
		// this file also use, so the claim under test is which of these three come back, not how many
		// rows exist under `umum` in total.
		const ownIds = new Set([draft.id, published.id, archived.id]);
		const mine = result.posts.filter((post) => ownIds.has(post.id));
		expect(mine.map((post) => post.id)).toEqual([published.id]);
	});

	it('filters by category', async () => {
		const adminId = await insertAdmin(unique('Pengurus Publik Kategori'));
		const clock = new FakeClock(START);
		const inPosyandu = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'posyandu' })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: inPosyandu.id });
		const inKerjaBakti = await createPost(testDb.db, clock, {
			actorId: adminId,
			...announcementContent({ category: 'kerja-bakti' })
		});
		await publishPost(testDb.db, clock, { actorId: adminId, postId: inKerjaBakti.id });

		const result = await listPublicPosts(testDb.db, clock, {
			category: 'posyandu',
			pageSize: 200
		});

		const ownIds = new Set([inPosyandu.id, inKerjaBakti.id]);
		const mine = result.posts.filter((post) => ownIds.has(post.id));
		expect(mine.map((post) => post.id)).toEqual([inPosyandu.id]);
	});

	it('paginates, reporting the total count across every page', async () => {
		// `rapat` is reserved to this test alone within this file, because a total count cannot be
		// narrowed down to "this test's own rows" the way an array of ids can.
		const adminId = await insertAdmin(unique('Pengurus Publik Halaman'));
		const clock = new FakeClock(START);
		for (let index = 0; index < 3; index += 1) {
			const created = await createPost(testDb.db, clock, {
				actorId: adminId,
				...announcementContent({ category: 'rapat' })
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: created.id });
			clock.advance(1000);
		}

		const first = await listPublicPosts(testDb.db, clock, {
			category: 'rapat',
			page: 1,
			pageSize: 2
		});
		const second = await listPublicPosts(testDb.db, clock, {
			category: 'rapat',
			page: 2,
			pageSize: 2
		});

		expect(first.posts).toHaveLength(2);
		expect(first.totalCount).toBe(3);
		expect(second.posts).toHaveLength(1);
	});

	describe('the upcoming view', () => {
		it('shows upcoming events first, soonest first, then announcements newest first — and hides past events', async () => {
			const adminId = await insertAdmin(unique('Pengurus Publik Urutan'));
			const clock = new FakeClock(START);
			const now = clock.now();

			const pastEvent = await createPost(testDb.db, clock, {
				actorId: adminId,
				...eventContent({
					category: 'perayaan',
					startsAt: new Date(now.getTime() - 2 * DAY_MS),
					endsAt: null
				})
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: pastEvent.id });
			clock.advance(1000);

			const announcementOld = await createPost(testDb.db, clock, {
				actorId: adminId,
				...announcementContent({ category: 'perayaan' })
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: announcementOld.id });
			clock.advance(1000);

			const nearEvent = await createPost(testDb.db, clock, {
				actorId: adminId,
				...eventContent({
					category: 'perayaan',
					startsAt: new Date(now.getTime() + 1 * DAY_MS),
					endsAt: null
				})
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: nearEvent.id });
			clock.advance(1000);

			const announcementNew = await createPost(testDb.db, clock, {
				actorId: adminId,
				...announcementContent({ category: 'perayaan' })
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: announcementNew.id });
			clock.advance(1000);

			const farEvent = await createPost(testDb.db, clock, {
				actorId: adminId,
				...eventContent({
					category: 'perayaan',
					startsAt: new Date(now.getTime() + 3 * DAY_MS),
					endsAt: null
				})
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: farEvent.id });

			const result = await listPublicPosts(testDb.db, clock, {
				category: 'perayaan',
				pageSize: 200
			});

			expect(result.when).toBe(POST_WHEN.upcoming);
			const ownIds = new Set([
				pastEvent.id,
				announcementOld.id,
				nearEvent.id,
				announcementNew.id,
				farEvent.id
			]);
			const mine = result.posts.filter((post) => ownIds.has(post.id));
			expect(mine.map((post) => post.id)).toEqual([
				nearEvent.id,
				farEvent.id,
				announcementNew.id,
				announcementOld.id
			]);
		});
	});

	describe('the past view', () => {
		it('surfaces past events and every announcement, newest moment first, and hides future events', async () => {
			const adminId = await insertAdmin(unique('Pengurus Publik Lewat'));
			const clock = new FakeClock(START);
			const now = clock.now();

			const pastEvent = await createPost(testDb.db, clock, {
				actorId: adminId,
				...eventContent({
					category: 'posyandu',
					startsAt: new Date(now.getTime() - 2 * DAY_MS),
					endsAt: null
				})
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: pastEvent.id });
			clock.advance(1000);

			const announcementOld = await createPost(testDb.db, clock, {
				actorId: adminId,
				...announcementContent({ category: 'posyandu' })
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: announcementOld.id });
			clock.advance(1000);

			const announcementNew = await createPost(testDb.db, clock, {
				actorId: adminId,
				...announcementContent({ category: 'posyandu' })
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: announcementNew.id });
			clock.advance(1000);

			const futureEvent = await createPost(testDb.db, clock, {
				actorId: adminId,
				...eventContent({
					category: 'posyandu',
					startsAt: new Date(now.getTime() + 1 * DAY_MS),
					endsAt: null
				})
			});
			await publishPost(testDb.db, clock, { actorId: adminId, postId: futureEvent.id });

			const result = await listPublicPosts(testDb.db, clock, {
				category: 'posyandu',
				pageSize: 200,
				when: POST_WHEN.past
			});

			expect(result.when).toBe(POST_WHEN.past);
			const ownIds = new Set([
				pastEvent.id,
				announcementOld.id,
				announcementNew.id,
				futureEvent.id
			]);
			const mine = result.posts.filter((post) => ownIds.has(post.id));
			expect(mine.map((post) => post.id)).toEqual([
				announcementNew.id,
				announcementOld.id,
				pastEvent.id
			]);
		});
	});
});
