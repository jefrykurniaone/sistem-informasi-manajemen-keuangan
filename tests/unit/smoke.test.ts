import { describe, expect, it } from 'vitest';
import { cn } from '$lib/utils';

describe('cn', () => {
	it.each([
		{ name: 'merges classes that do not conflict', input: ['px-2', 'py-1'], output: 'px-2 py-1' },
		{
			name: 'the last Tailwind class wins over one of the same kind',
			input: ['px-2', 'px-4'],
			output: 'px-4'
		},
		{ name: 'ignores empty values', input: ['px-2', undefined, false, null], output: 'px-2' }
	])('$name', ({ input, output }) => {
		expect(cn(...input)).toBe(output);
	});
});
