import { describe, expect, it } from 'vitest';
import { MENU, visibleMenu, type GroupKey, type MenuGroup } from '$lib/components/app-shell/menu';
import { ACTION, isAllowed } from '$lib/server/authz';
import { ROLE, type Role } from '$lib/server/db/schema/authz';

/**
 * The menu filter as a pure function: a set of roles goes in, the groups and items that set may
 * see come out. `docs/spec-shell-beranda-v1.md`'s testing decision asks for exactly this shape —
 * no HTTP, no database, no browser — and `tests/unit/authz.test.ts` remains the place the
 * permission table itself is proven.
 *
 * The role sets below are what a real account holds. A database trigger gives every `user` row a
 * `resident` row, so an admin is `resident` *and* `admin`, never `admin` alone; writing them that
 * way is the difference between testing the application and testing a state it cannot reach.
 */

const WARGA: readonly Role[] = [ROLE.resident];
const ADMIN: readonly Role[] = [ROLE.resident, ROLE.admin];
const SUPERUSER: readonly Role[] = [ROLE.resident, ROLE.superuser];

/** The seven groups of the spec, in the order the spec lists them. */
const EVERY_GROUP: readonly GroupKey[] = [
	'home',
	'posts',
	'mine',
	'finance',
	'residents',
	'services',
	'system'
];

function keysOf(groups: readonly MenuGroup[]): readonly GroupKey[] {
	return groups.map((group) => group.key);
}

describe('the menu itself', () => {
	it('is the seven groups of the spec, in the spec order', () => {
		expect(keysOf(MENU)).toEqual(EVERY_GROUP);
	});

	it('gives every item a key that is unique across the whole menu', () => {
		const keys = MENU.flatMap((group) => group.items.map((item) => item.key));
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('puts the Keuangan group in the spec order, verification first', () => {
		const finance = MENU.find((group) => group.key === 'finance');
		expect(finance?.items.map((item) => item.key)).toEqual([
			'verifyPayments',
			'recordCash',
			'overdue',
			'periods',
			'publishReports',
			'duesRates',
			'cashCategories',
			'openingBalance',
			'exemptions'
		]);
	});
});

describe('visibleMenu', () => {
	it('gives a Warga only Beranda, Pengumuman & Kegiatan, and Saya', () => {
		expect(keysOf(visibleMenu(WARGA))).toEqual(['home', 'posts', 'mine']);
	});

	it('gives a Warga every item of Saya, because none of them is gated by an action', () => {
		const mine = visibleMenu(WARGA).find((group) => group.key === 'mine');
		expect(mine?.items.map((item) => item.key)).toEqual([
			'myUnit',
			'invoices',
			'payments',
			'reports',
			'complaints',
			'profile',
			'profileNotifications'
		]);
	});

	it('gives an admin Keuangan and Layanan', () => {
		const keys = keysOf(visibleMenu(ADMIN));
		expect(keys).toEqual(['home', 'posts', 'mine', 'finance', 'services']);
	});

	it('gives an admin the four Keuangan items that are an admin action, and no others', () => {
		const finance = visibleMenu(ADMIN).find((group) => group.key === 'finance');
		expect(finance?.items.map((item) => item.key)).toEqual([
			'verifyPayments',
			'recordCash',
			'overdue',
			'periods',
			'publishReports'
		]);
	});

	it('gives a superuser every group, Sistem included', () => {
		expect(keysOf(visibleMenu(SUPERUSER))).toEqual(EVERY_GROUP);
	});

	it('drops a group the moment no item in it passes, rather than showing it empty', () => {
		const warga = visibleMenu(WARGA);
		expect(warga.some((group) => group.key === 'finance')).toBe(false);
	});

	it('never returns a group with no items', () => {
		for (const roles of [WARGA, ADMIN, SUPERUSER, []]) {
			const empty = visibleMenu(roles).filter((group) => group.items.length === 0);
			expect(empty).toEqual([]);
		}
	});

	it('keeps the spec order of the groups it does return', () => {
		for (const roles of [WARGA, ADMIN, SUPERUSER, []]) {
			const positions = keysOf(visibleMenu(roles)).map((key) => EVERY_GROUP.indexOf(key));
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		}
	});

	it('returns no item whose action the roles do not hold', () => {
		for (const roles of [WARGA, ADMIN, SUPERUSER, []]) {
			const refused = visibleMenu(roles)
				.flatMap((group) => group.items)
				.filter((item) => item.action !== null && !isAllowed(roles, item.action));
			expect(refused).toEqual([]);
		}
	});

	it('reads an Iterable once, so a generator of roles is not spent on the first group', () => {
		function* rolesOnce(): Generator<Role> {
			yield ROLE.resident;
			yield ROLE.superuser;
		}
		expect(keysOf(visibleMenu(rolesOnce()))).toEqual(EVERY_GROUP);
	});

	it('shows Verifikasi Pembayaran to an admin and hides it from a Warga', () => {
		expect(isAllowed(ADMIN, ACTION.verifyPayments)).toBe(true);
		const wargaItems = visibleMenu(WARGA).flatMap((group) => group.items.map((item) => item.key));
		expect(wargaItems).not.toContain('verifyPayments');
	});
});
