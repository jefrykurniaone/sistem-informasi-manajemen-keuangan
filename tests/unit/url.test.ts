import { describe, expect, it } from 'vitest';
import { withoutTrailingSlashes } from '$lib/server/url';

describe('withoutTrailingSlashes', () => {
	it.each([
		{
			name: 'no trailing slash',
			input: 'https://komplek.example',
			expected: 'https://komplek.example'
		},
		{
			name: 'one trailing slash',
			input: 'https://komplek.example/',
			expected: 'https://komplek.example'
		},
		{
			name: 'several trailing slashes',
			input: 'http://localhost:5173///',
			expected: 'http://localhost:5173'
		},
		{ name: 'nothing but slashes', input: '///', expected: '' },
		{ name: 'an empty string', input: '', expected: '' },
		{
			name: 'slashes inside the value',
			input: 'https://a.example/b//c/',
			expected: 'https://a.example/b//c'
		}
	])('handles $name', ({ input, expected }) => {
		expect(withoutTrailingSlashes(input)).toBe(expected);
	});

	it('leaves a long run of slashes that does not end the value untouched', () => {
		const input = `${'/'.repeat(200_000)}x`;

		expect(withoutTrailingSlashes(input)).toBe(input);
	});
});
