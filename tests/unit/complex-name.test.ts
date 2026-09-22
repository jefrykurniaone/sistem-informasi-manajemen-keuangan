import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPLEX_NAME, composePageTitle, normalizeComplexName } from '$lib/complex-name';

/**
 * The complex name and the tab title as pure functions (`docs/spec-shell-masuk-v1.md`): a raw
 * configured value goes in, the name to show comes out, and a page title plus a name make one tab
 * title. Nothing here reads `PUBLIC_COMPLEX_NAME` itself, so the result does not depend on what the
 * machine running the test happens to have in its `.env` or its CI environment; the module still
 * needs the name *declared*, which `.env.example` and the workflow's job-level `env:` see to.
 */

describe('normalizeComplexName', () => {
	it.each([
		{ raw: undefined, expected: DEFAULT_COMPLEX_NAME, why: 'unset' },
		{ raw: '', expected: DEFAULT_COMPLEX_NAME, why: 'empty' },
		{ raw: '   ', expected: DEFAULT_COMPLEX_NAME, why: 'only whitespace' },
		{ raw: 'Griya Asri', expected: 'Griya Asri', why: 'a real name' },
		{ raw: '  Griya Asri \n', expected: 'Griya Asri', why: 'a name with stray whitespace' }
	])('answers $expected for a value that is $why', ({ raw, expected }) => {
		expect(normalizeComplexName(raw)).toBe(expected);
	});

	it('falls back to "Komplek", the name the spec names', () => {
		expect(DEFAULT_COMPLEX_NAME).toBe('Komplek');
	});
});

describe('composePageTitle', () => {
	it.each([
		{ title: 'Masuk', name: 'Griya Asri', expected: 'Masuk - Griya Asri' },
		{ title: 'Papan pengumuman', name: 'Komplek', expected: 'Papan pengumuman - Komplek' },
		{ title: '  Beranda  ', name: 'Komplek', expected: 'Beranda - Komplek' },
		{ title: '', name: 'Griya Asri', expected: 'Griya Asri' },
		{ title: '   ', name: 'Griya Asri', expected: 'Griya Asri' }
	])('makes "$expected" from "$title" and "$name"', ({ title, name, expected }) => {
		expect(composePageTitle(title, name)).toBe(expected);
	});
});
