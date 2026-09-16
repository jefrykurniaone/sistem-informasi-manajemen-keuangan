import { describe, expect, it } from 'vitest';
import { cn } from '$lib/utils';

describe('cn', () => {
	it.each([
		{ nama: 'menggabungkan kelas yang berbeda', masukan: ['px-2', 'py-1'], hasil: 'px-2 py-1' },
		{
			nama: 'kelas Tailwind terakhir menang atas yang sejenis',
			masukan: ['px-2', 'px-4'],
			hasil: 'px-4'
		},
		{ nama: 'mengabaikan nilai kosong', masukan: ['px-2', undefined, false, null], hasil: 'px-2' }
	])('$nama', ({ masukan, hasil }) => {
		expect(cn(...masukan)).toBe(hasil);
	});
});
