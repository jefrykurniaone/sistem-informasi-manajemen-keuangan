import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readOrigin } from '#lib/server/auth.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles, type Role } from '#lib/server/db/schema/authz.ts';
import { emailQueue } from '#lib/server/db/schema/email.ts';
import { POST_TYPE } from '#lib/server/db/schema/post.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import {
	newPostPayload,
	newPostTemplate,
	NEW_POST_KIND
} from '#lib/server/email/templates/new-post.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import { createPost, type PostContent } from '#lib/server/services/post/index.ts';
import { notifyNewPost } from '#lib/server/services/post/notification.ts';
import { setSubscriptionPreference } from '#lib/server/services/subscription/index.ts';
import { SUBSCRIPTION_KIND } from '#lib/server/services/subscription/kinds.ts';

/**
 * `notifyNewPost` — the recipient side of #41 — and the `new-post` template it renders through.
 * `tests/unit/post-service.test.ts` already proves the acceptance criteria that are about
 * `publishPost` itself (queues on first publish, stays silent on an edit or a re-publish, never fails
 * because of the email); this file proves the two pieces underneath that: who `notifyNewPost`
 * addresses and what payload it builds, and what `newPostTemplate` writes for them.
 *
 * Which of the addressed residents a `new-post` email actually reaches — the Langganan, opt-in and
 * off by default — and the unsubscribe link it carries are the announce module's rules, proven once
 * for every kind in `tests/unit/announce.test.ts` (#316) rather than again here.
 */

const testDb = testDatabase();
const START = '2026-04-01T00:00:00.000Z';

let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

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

async function insertAccount(name: string, role?: Role): Promise<string> {
	const userId = await insertUser(name);
	if (role) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date(START) });
	}
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

async function insertAdmin(name: string): Promise<string> {
	return insertAccount(name, ROLE.admin);
}

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

async function emailOf(userId: string): Promise<string> {
	const [row] = await testDb.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
	return row.email;
}

/** The content of a pengumuman, overridable field by field — mirrors `post-service.test.ts`'s copy. */
function announcementContent(overrides: Partial<PostContent> = {}): PostContent {
	return {
		type: POST_TYPE.announcement,
		title: unique('Pengumuman Notifikasi'),
		summary: 'Ringkasan yang harus sampai ke kotak masuk.',
		bodyHtml: 'Isi lengkap yang tidak boleh pernah dikirim lewat email.',
		category: 'umum',
		startsAt: null,
		endsAt: null,
		location: null,
		...overrides
	};
}

/** Every `new-post` queue row belonging to `postTitle`, since this file's schema is shared across tests. */
async function newPostRowsFor(postTitle: string) {
	const rows = await testDb.db.select().from(emailQueue).where(eq(emailQueue.kind, NEW_POST_KIND));
	return rows.filter((row) => row.payload.title === postTitle);
}

describe('notifyNewPost', () => {
	// `subscribeToNewPost` writes a row that outlives its own test — this file's schema is shared
	// for the whole file, per `testDatabase()`'s contract — so every test asserts by recipient rather
	// than by a total row count: a still-subscribed resident from an earlier test is correctly
	// notified about a later test's Post too.
	it('addresses every resident, an admin as much as anyone, so each one subscribed is queued an email', async () => {
		const adminId = await insertAdmin(unique('Pengurus Notifikasi'));
		const clock = new FakeClock(START);
		const residentId = await insertAccount(unique('Warga Berlangganan'));
		await subscribeToNewPost(residentId, clock, true);
		await subscribeToNewPost(adminId, clock, true);
		const post = await createPost(testDb.db, clock, { actorId: adminId, ...announcementContent() });

		await notifyNewPost(testDb.db, clock, post);

		const recipients = (await newPostRowsFor(post.title)).map((row) => row.recipient);
		expect(recipients).toContain(await emailOf(residentId));
		expect(recipients).toContain(await emailOf(adminId));
	});

	it('builds the payload from the title, the summary and the public link, never the body', async () => {
		const adminId = await insertAdmin(unique('Pengurus Isi Notifikasi'));
		const clock = new FakeClock(START);
		const subscriberId = await insertAccount(unique('Warga Baca Notifikasi'));
		await subscribeToNewPost(subscriberId, clock, true);
		const post = await createPost(testDb.db, clock, { actorId: adminId, ...announcementContent() });

		await notifyNewPost(testDb.db, clock, post);

		const subscriberEmail = await emailOf(subscriberId);
		const own = (await newPostRowsFor(post.title)).find((row) => row.recipient === subscriberEmail);
		if (!own) {
			throw new Error('Expected a queued row for the subscribed resident, and found none.');
		}
		expect(own.payload).toMatchObject({
			title: post.title,
			summary: post.summary,
			url: `${readOrigin()}/posts/${post.id}`,
			locale: 'id'
		});
		expect(JSON.stringify(own.payload)).not.toContain(post.bodyHtml);
	});
});

describe('newPostTemplate', () => {
	it('renders the title, the summary and the link, never the body', () => {
		const payload = newPostPayload({
			title: 'Kerja bakti akhir pekan',
			summary: 'Ringkasan singkat kerja bakti.',
			url: 'https://komplek.local/posts/abc-123',
			locale: 'id'
		});

		const rendered = newPostTemplate(payload);

		expect(rendered.subject).toBe('Terbitan baru: Kerja bakti akhir pekan');
		expect(rendered.text).toContain('Ringkasan singkat kerja bakti.');
		expect(rendered.text).toContain('https://komplek.local/posts/abc-123');
	});

	it('renders in the locale the payload names', () => {
		const rendered = newPostTemplate(
			newPostPayload({
				title: 'Weekend cleanup',
				summary: 'Short summary.',
				url: 'https://komplek.local/posts/xyz-789',
				locale: 'en'
			})
		);

		expect(rendered.subject).toBe('New post: Weekend cleanup');
		expect(rendered.text).toContain('Short summary.');
	});

	it.each([
		['title', { title: 1 }],
		['summary', { summary: 1 }],
		['url', { url: 1 }],
		['locale', { locale: 1 }]
	])('throws TypeError when %s is not a string', (_name, overrides) => {
		const payload = { title: 't', summary: 's', url: 'u', locale: 'id', ...overrides };

		expect(() => newPostTemplate(payload)).toThrow(TypeError);
	});
});
