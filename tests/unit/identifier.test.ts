import { describe, expect, it } from 'vitest';
import { assertUuidParam, isUuid } from '$lib/server/services/identifier';

/**
 * `isUuid` and `assertUuidParam`, the one place #111's guard lives. No database — both are pure —
 * see `$lib/server/services/identifier.ts`'s own doc comment for why a route param that reaches a
 * `uuid` column unchecked is a 500, not a 404, and why this module exists to close that gap.
 */

/** Runs `fn`, returning what it threw, or `undefined` when it did not throw at all. */
function caught(fn: () => void): unknown {
	try {
		fn();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe('isUuid', () => {
	it.each([
		{ name: 'a lowercase uuid', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
		{ name: 'an uppercase uuid', value: '3F2504E0-4F89-41D3-9A0C-0305E82C3301' },
		{ name: 'a mixed-case uuid', value: '3f2504E0-4f89-41D3-9a0c-0305e82C3301' },
		{ name: 'the nil uuid', value: '00000000-0000-0000-0000-000000000000' }
	])('accepts $name', ({ value }) => {
		expect(isUuid(value)).toBe(true);
	});

	it.each([
		{ name: 'the empty string', value: '' },
		{ name: 'the literal "new", the non-uuid id #111 was opened over', value: 'new' },
		{ name: 'a short word', value: 'abc' },
		{ name: 'a bare digit', value: '1' },
		{ name: 'a uuid missing one hex digit', value: '3f2504e0-4f89-41d3-9a0c-0305e82c330' },
		{ name: 'a uuid with one extra hex digit', value: '3f2504e0-4f89-41d3-9a0c-0305e82c33011' },
		{ name: 'a uuid missing its dashes', value: '3f2504e04f8941d39a0c0305e82c3301' },
		{ name: 'a uuid with a non-hex character', value: '3f2504e0-4f89-41d3-9a0c-0305e82c330g' },
		{ name: 'a uuid with trailing whitespace', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301 ' },
		{ name: 'a uuid with leading whitespace', value: ' 3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
		{ name: 'a uuid followed by a newline', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301\n' }
	])('rejects $name', ({ value }) => {
		expect(isUuid(value)).toBe(false);
	});
});

describe('assertUuidParam', () => {
	const notFoundMessage = 'Halaman tidak ditemukan.';

	it('returns normally for a uuid-shaped value', () => {
		expect(
			caught(() => assertUuidParam('3f2504e0-4f89-41d3-9a0c-0305e82c3301', notFoundMessage))
		).toBe(undefined);
	});

	it('throws a SvelteKit 404 carrying the caller’s own not-found message for a non-uuid value', () => {
		const thrown = caught(() => assertUuidParam('new', notFoundMessage));

		expect(thrown).toMatchObject({ status: 404, body: { message: notFoundMessage } });
	});
});
