import { describe, expect, it } from 'vitest';
import { renderPostBody } from '$lib/server/services/post/markdown';

/**
 * The security boundary of the announcement board: what `renderPostBody` lets through and what it
 * destroys. The page that shows a Post is open without an account, so everything below is about a
 * payload reaching a browser, not about how pretty the output is.
 *
 * Two halves, and both matter equally. The first proves that scripts, event handlers and dangerous
 * URL schemes are gone — `docs/spec-konten-v1.md`'s "skrip yang lolos di halaman publik adalah
 * kerugian yang tidak bisa ditarik kembali". The second proves that the markup the spec's own user
 * stories ask for — lists, emphasis, headings, links, quotes, code and tables — still arrives. A
 * whitelist that passes the first half by rendering nothing at all would be a failure too.
 */

describe('what never survives', () => {
	it.each([
		['a script element and its contents', '<script>alert(1)</script>', 'alert'],
		['an inline event handler', '<img src=x onerror="alert(1)">', 'onerror'],
		['a click handler on an allowed-looking tag', '<div onclick="steal()">halo</div>', 'onclick'],
		['a style element and its contents', '<style>body{display:none}</style>', 'display:none'],
		['an iframe', '<iframe src="https://evil.test"></iframe>', 'iframe'],
		['an object embed', '<object data="evil.swf"></object>', 'object'],
		['a form and its inputs', '<form><input name="password"></form>', 'input'],
		['a javascript: link', '[klik](javascript:alert(1))', 'javascript:'],
		['a data: URL link', '[klik](data:text/html;base64,PHNjcmlwdD4=)', 'data:'],
		['a protocol-relative link', '[klik](//evil.test/phish)', 'evil.test'],
		['a base element', '<base href="https://evil.test/">', 'base'],
		['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">', 'refresh'],
		['an svg with a handler', '<svg onload="alert(1)"></svg>', 'onload'],
		[
			'a link element pulling a stylesheet',
			'<link rel="stylesheet" href="//evil.test/a.css">',
			'stylesheet'
		]
	])('strips %s', (_name, markdown, forbidden) => {
		expect(renderPostBody(markdown)).not.toContain(forbidden);
	});

	it('leaves nothing at all of a script, not even its text as prose', () => {
		// `script` is in `nonTextTags`, so unlike a stray `<div>` its contents go with it. Dropping
		// the tag and keeping the body would print the payload into the page for a reader to copy.
		expect(renderPostBody('<script>window.location="https://evil.test"</script>').trim()).toBe('');
	});

	it('never emits an on-anything attribute, whatever the tag it was hung on', () => {
		const rendered = renderPostBody(
			'<p onmouseover="a()">satu</p><a href="https://ok.test" onfocus="b()">dua</a>'
		);

		expect(rendered).not.toMatch(/\son[a-z]+=/i);
		expect(rendered).toContain('satu');
	});

	it('keeps the words of a disallowed tag while dropping the tag itself', () => {
		// The opposite rule from `script`: a `<div>` an author pasted is noise, but the sentence
		// inside it is what they meant to publish.
		const rendered = renderPostBody('<div class="x">Kerja bakti hari Minggu</div>');

		expect(rendered).toContain('Kerja bakti hari Minggu');
		expect(rendered).not.toContain('<div');
	});

	it('drops a body image rather than pointing a public page at somebody else’s server', () => {
		const rendered = renderPostBody('![spanduk](https://tracker.test/pixel.png)');

		expect(rendered).not.toContain('tracker.test');
		expect(rendered).not.toContain('<img');
	});

	it('drops the checkbox of a task list and keeps the item text', () => {
		const rendered = renderPostBody('- [ ] beli air\n- [x] sewa tenda');

		expect(rendered).not.toContain('<input');
		expect(rendered).toContain('beli air');
		expect(rendered).toContain('sewa tenda');
	});

	it('drops the language class of a code block, so no post reaches the stylesheet', () => {
		const rendered = renderPostBody('```js\nconst a = 1;\n```');

		expect(rendered).not.toContain('class=');
		expect(rendered).toContain('<pre><code>');
	});
});

describe('what the spec needs, and therefore has to survive', () => {
	it.each([
		['a bullet list', '- satu\n- dua', ['<ul>', '<li>satu</li>']],
		['a numbered list', '1. satu\n2. dua', ['<ol>', '<li>satu</li>']],
		['bold and italic', '**tebal** dan *miring*', ['<strong>tebal</strong>', '<em>miring</em>']],
		['strikethrough', '~~batal~~', ['<del>batal</del>']],
		['inline code', 'ketik `1234`', ['<code>1234</code>']],
		['a blockquote', '> catatan pengurus', ['<blockquote>', 'catatan pengurus']],
		['a horizontal rule', 'satu\n\n---\n\ndua', ['<hr />']],
		['headings at every level', '# Satu\n\n###### Enam', ['<h1>Satu</h1>', '<h6>Enam</h6>']],
		['a paragraph', 'Rapat warga hari Sabtu.', ['<p>Rapat warga hari Sabtu.</p>']]
	])('keeps %s', (_name, markdown, expected) => {
		const rendered = renderPostBody(markdown);

		for (const fragment of expected) {
			expect(rendered).toContain(fragment);
		}
	});

	it('keeps a table, its header row and its column alignment', () => {
		// The ticket names this explicitly: a whitelist that kills the tables the spec needs is as
		// much a failure as one that lets a script through.
		const rendered = renderPostBody('| Kegiatan | Jam |\n|:--|--:|\n| Posyandu | 09.00 |');

		expect(rendered).toContain('<table>');
		expect(rendered).toContain('<th align="left">Kegiatan</th>');
		expect(rendered).toContain('<th align="right">Jam</th>');
		expect(rendered).toContain('<td align="left">Posyandu</td>');
	});

	it.each([
		['https', '[situs](https://komplek.test/a)', 'href="https://komplek.test/a"'],
		['http', '[situs](http://komplek.test/a)', 'href="http://komplek.test/a"'],
		['mailto', '[surel](mailto:pengurus@komplek.test)', 'href="mailto:pengurus@komplek.test"'],
		['tel', '[telepon](tel:+628123456789)', 'href="tel:+628123456789"']
	])('keeps a %s link', (_name, markdown, expected) => {
		expect(renderPostBody(markdown)).toContain(expected);
	});

	it('keeps a link title and never gives a link a target', () => {
		const rendered = renderPostBody('[peta](https://komplek.test "Lokasi kegiatan")');

		expect(rendered).toContain('title="Lokasi kegiatan"');
		expect(rendered).not.toContain('target=');
	});

	it('leaves an ordinary announcement completely untouched', () => {
		const rendered = renderPostBody(
			'Kerja bakti **hari Minggu** pukul 07.00.\n\n- bawa sapu\n- bawa cangkul'
		);

		expect(rendered).toBe(
			'<p>Kerja bakti <strong>hari Minggu</strong> pukul 07.00.</p>\n<ul>\n<li>bawa sapu</li>\n<li>bawa cangkul</li>\n</ul>\n'
		);
	});

	it('renders an empty body as nothing rather than throwing', () => {
		expect(renderPostBody('')).toBe('');
	});
});
