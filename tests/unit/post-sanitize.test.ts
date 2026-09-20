import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { POST_TYPE } from '$lib/server/db/schema/post';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import { createPost, getPost, type PostContent } from '$lib/server/services/post';
import { sanitizePostHtml } from '$lib/server/services/post/sanitize';

/**
 * The security boundary of the announcement board: what `sanitizePostHtml` lets through and what it
 * destroys, and that a body written through the service is already clean by the time it is read
 * back. The page that shows a Post is open without an account, so everything below is about a
 * payload reaching a browser, not about how pretty the output is.
 *
 * Three parts, and all three matter. The first proves that scripts, event handlers and dangerous
 * URL schemes are gone — `docs/spec-konten-v1.md`'s "skrip yang lolos di halaman publik adalah
 * kerugian yang tidak bisa ditarik kembali". The second proves that the markup the spec's own user
 * stories ask for — lists, emphasis, headings, links, quotes, code and tables — still arrives. A
 * whitelist that passes the first part by rendering nothing at all would be a failure too. The
 * third proves the save-time half of the two-point rule `sanitize.ts` describes: what reaches
 * `posts.body_html` is the filtered HTML and never what an author posted.
 */

const testDb = testDatabase();

const START = '2026-03-10T00:00:00.000Z';

/** Makes every title this file writes different from every other one, across every test. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** An admin who may manage Posts and has a `residents` row to be attributed to. */
async function insertAdmin(name: string): Promise<string> {
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
	await testDb.db.insert(userRoles).values({ userId: id, role: ROLE.admin, createdAt: now });
	await testDb.db.insert(residents).values({ userId: id, createdAt: now });
	return id;
}

/** The content of a pengumuman, overridable field by field. */
function announcementContent(overrides: Partial<PostContent> = {}): PostContent {
	return {
		type: POST_TYPE.announcement,
		title: unique('Pengumuman bersih'),
		summary: 'Ringkasan pengumuman.',
		bodyHtml: '<p>Isi biasa.</p>',
		category: 'umum',
		startsAt: null,
		endsAt: null,
		location: null,
		...overrides
	};
}

/** Writes one Post through the service and reads it back through the service. */
async function storeAndReadBody(bodyHtml: string): Promise<string> {
	const adminId = await insertAdmin(unique('Pengurus Bersih'));
	const created = await createPost(testDb.db, new FakeClock(START), {
		actorId: adminId,
		...announcementContent({ bodyHtml })
	});
	const found = await getPost(testDb.db, adminId, created.id);
	return found.bodyHtml;
}

describe('what never survives', () => {
	it.each([
		['a script element and its contents', '<p>halo</p><script>alert(1)</script>', 'alert'],
		['an inline event handler', '<img src="x" onerror="alert(1)">', 'onerror'],
		['a click handler on an allowed tag', '<p onclick="steal()">halo</p>', 'onclick'],
		['a style element and its contents', '<style>body{display:none}</style>', 'display:none'],
		['an iframe', '<iframe src="https://evil.test"></iframe>', 'iframe'],
		['an object embed', '<object data="evil.swf"></object>', 'object'],
		['a form and its inputs', '<form><input name="password"></form>', 'input'],
		['a javascript: link', '<a href="javascript:alert(1)">klik</a>', 'javascript:'],
		['a data: URL link', '<a href="data:text/html;base64,PHNjcmlwdD4=">klik</a>', 'data:'],
		['a protocol-relative link', '<a href="//evil.test/phish">klik</a>', 'evil.test'],
		['a base element', '<base href="https://evil.test/">', 'base'],
		['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">', 'refresh'],
		['an svg with a handler', '<svg onload="alert(1)"></svg>', 'onload'],
		[
			'a link element pulling a stylesheet',
			'<link rel="stylesheet" href="//evil.test/a.css">',
			'stylesheet'
		],
		['a class an author could style the application with', '<p class="hidden">halo</p>', 'class=']
	])('strips %s', (_name, html, forbidden) => {
		expect(sanitizePostHtml(html)).not.toContain(forbidden);
	});

	it('leaves nothing at all of a script, not even its text as prose', () => {
		// `script` is in `nonTextTags`, so unlike a stray `<div>` its contents go with it. Dropping
		// the tag and keeping the body would print the payload into the page for a reader to copy.
		expect(sanitizePostHtml('<script>window.location="https://evil.test"</script>')).toBe('');
	});

	it('never emits an on-anything attribute, whatever the tag it was hung on', () => {
		const rendered = sanitizePostHtml(
			'<p onmouseover="a()">satu</p><a href="https://ok.test" onfocus="b()">dua</a>'
		);

		expect(rendered).not.toMatch(/\son[a-z]+=/i);
		expect(rendered).toContain('satu');
	});

	it('keeps the words of a disallowed tag while dropping the tag itself', () => {
		// The opposite rule from `script`: a `<div>` an author pasted is noise, but the sentence
		// inside it is what they meant to publish.
		const rendered = sanitizePostHtml('<div class="x">Kerja bakti hari Minggu</div>');

		expect(rendered).toContain('Kerja bakti hari Minggu');
		expect(rendered).not.toContain('<div');
	});

	it('drops a body image rather than pointing a public page at somebody else’s server', () => {
		const rendered = sanitizePostHtml('<p><img src="https://tracker.test/pixel.png" alt="x"></p>');

		expect(rendered).not.toContain('tracker.test');
		expect(rendered).not.toContain('<img');
	});
});

describe('what the spec needs, and therefore has to survive', () => {
	it.each([
		['a bullet list', '<ul><li>satu</li><li>dua</li></ul>', ['<ul>', '<li>satu</li>']],
		['a numbered list', '<ol><li>satu</li></ol>', ['<ol>', '<li>satu</li>']],
		[
			'bold and italic',
			'<p><strong>tebal</strong> dan <em>miring</em></p>',
			['<strong>tebal</strong>', '<em>miring</em>']
		],
		['strikethrough', '<p><del>batal</del></p>', ['<del>batal</del>']],
		['inline code', '<p>ketik <code>1234</code></p>', ['<code>1234</code>']],
		['a code block', '<pre><code>const a = 1;</code></pre>', ['<pre><code>']],
		['a blockquote', '<blockquote><p>catatan pengurus</p></blockquote>', ['<blockquote>']],
		['a horizontal rule', '<p>satu</p><hr /><p>dua</p>', ['<hr />']],
		['a line break', '<p>satu<br />dua</p>', ['<br />']],
		['headings at every level', '<h1>Satu</h1><h6>Enam</h6>', ['<h1>Satu</h1>', '<h6>Enam</h6>']],
		['a paragraph', '<p>Rapat warga hari Sabtu.</p>', ['<p>Rapat warga hari Sabtu.</p>']]
	])('keeps %s', (_name, html, expected) => {
		const rendered = sanitizePostHtml(html);

		for (const fragment of expected) {
			expect(rendered).toContain(fragment);
		}
	});

	it('keeps a table, its header row and its column alignment', () => {
		// A whitelist that kills the tables the spec needs is as much a failure as one that lets a
		// script through.
		const rendered = sanitizePostHtml(
			'<table><thead><tr><th align="left">Kegiatan</th><th align="right">Jam</th></tr></thead><tbody><tr><td align="left">Posyandu</td><td>09.00</td></tr></tbody></table>'
		);

		expect(rendered).toContain('<table>');
		expect(rendered).toContain('<th align="left">Kegiatan</th>');
		expect(rendered).toContain('<th align="right">Jam</th>');
		expect(rendered).toContain('<td align="left">Posyandu</td>');
	});

	it.each([
		['https', 'https://komplek.test/a'],
		['http', 'http://komplek.test/a'],
		['mailto', 'mailto:pengurus@komplek.test'],
		['tel', 'tel:+628123456789']
	])('keeps a %s link', (_name, href) => {
		expect(sanitizePostHtml(`<a href="${href}">tautan</a>`)).toContain(`href="${href}"`);
	});

	it('keeps a link title and never gives a link a target', () => {
		const rendered = sanitizePostHtml(
			'<a href="https://komplek.test" title="Lokasi kegiatan" target="_blank">peta</a>'
		);

		expect(rendered).toContain('title="Lokasi kegiatan"');
		expect(rendered).not.toContain('target=');
	});

	it('leaves an already-clean announcement completely untouched, so a second pass costs nothing', () => {
		// Idempotence is what lets the service filter on the way in and a page filter again on the
		// way out without the second pass eating the first one's output.
		const clean =
			'<p>Kerja bakti <strong>hari Minggu</strong> pukul 07.00.</p><ul><li>bawa sapu</li></ul>';

		expect(sanitizePostHtml(clean)).toBe(clean);
		expect(sanitizePostHtml(sanitizePostHtml(clean))).toBe(clean);
	});

	it('renders an empty body as nothing rather than throwing', () => {
		expect(sanitizePostHtml('')).toBe('');
	});
});

describe('what the service stores', () => {
	it('stores the filtered HTML, so a script never reaches the column at all', async () => {
		const stored = await storeAndReadBody(
			'<p>Kerja bakti <strong>hari Minggu</strong>.</p><script>alert(1)</script>'
		);

		expect(stored).toBe('<p>Kerja bakti <strong>hari Minggu</strong>.</p>');
	});

	it('strips an event handler and a javascript: link before storing them', async () => {
		const stored = await storeAndReadBody(
			'<p onclick="steal()">lihat <a href="javascript:alert(1)">di sini</a></p>'
		);

		expect(stored).not.toMatch(/\son[a-z]+=/i);
		expect(stored).not.toContain('javascript:');
		expect(stored).toContain('lihat');
		expect(stored).toContain('di sini');
	});

	it('wraps plain typed text in a paragraph, because the old textarea sends no tags', async () => {
		// #140 replaces the textarea with a rich-text editor. Until then a body arrives as words and
		// nothing else, and a bare text node has no block element for the public page to space.
		const stored = await storeAndReadBody('  Rapat warga hari Sabtu.  ');

		expect(stored).toBe('<p>Rapat warga hari Sabtu.</p>');
	});

	it('leaves a body that already carries markup unwrapped', async () => {
		const stored = await storeAndReadBody('<h2>Agenda</h2><ul><li>Iuran</li></ul>');

		expect(stored).toBe('<h2>Agenda</h2><ul><li>Iuran</li></ul>');
	});

	it('refuses a body that is nothing but markup the whitelist throws away', async () => {
		const adminId = await insertAdmin(unique('Pengurus Skrip'));

		await expect(
			createPost(testDb.db, new FakeClock(START), {
				actorId: adminId,
				...announcementContent({ bodyHtml: '<script>alert(1)</script>' })
			})
		).rejects.toThrow(TypeError);
	});
});
