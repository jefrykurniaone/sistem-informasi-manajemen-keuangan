import type { Pathname } from '$app/types';
import type * as messages from '$lib/paraglide/messages.js';
import { ACTION, isAllowed, type Action } from '$lib/server/authz';
import type { Role } from '$lib/server/db/schema/authz';

/**
 * The one description of the application's menu: which groups exist, in which order, what each
 * item links to, and which permission switches that item on. `docs/spec-shell-beranda-v1.md`'s
 * "Susunan grup dan urutannya" is the source of both the grouping and the order, and this file is
 * the only place either is written down.
 *
 * **This never decides what a request is allowed to do.** `isAllowed` is the same pure table
 * `src/lib/server/authz.ts` uses inside `requirePermission`, consulted here read-only to choose
 * what a link *shows*; the guard on each page remains the only place a request is actually let
 * through or refused. Hiding a menu item is a convenience for someone who could not use it anyway,
 * never the reason it was refused.
 *
 * ## Why this module holds message *keys* and no icons
 *
 * It imports `$lib/server/authz`, so SvelteKit treats it as a server-only module and refuses to
 * pull it into the browser bundle. That is the right side of the fence for the permission filter —
 * and it means the values in here have to survive `devalue`, because `src/routes/(app)/+layout.server.ts`
 * sends `visibleMenu`'s result to the browser as ordinary load data. A paraglide message function
 * and a Svelte icon component do not survive that trip, so a label is stored as its message *key*
 * and resolved with `m[labelKey]()` where it is rendered, and the group icons live beside the
 * markup in `app-sidebar.svelte`, keyed by the same `key` field. `app-sidebar.svelte` and
 * `nav-group.svelte` import the types below with `import type`, which is erased, so no client
 * module ever reaches `$lib/server/authz` at runtime.
 */

/** A paraglide message key belonging to the app shell. Every label below is one of these. */
export type MenuMessageKey = Extract<keyof typeof messages, `appShell_${string}`>;

/** One link in the sidebar. */
export interface MenuItem {
	/** Stable identity: the `{#each}` key, and how the active item is named. */
	readonly key: string;
	/** The paraglide message that names this item. */
	readonly labelKey: MenuMessageKey;
	/** Where the item goes. Typed against the generated route table, so a dead link fails `check`. */
	readonly href: Pathname;
	/** The action that switches this item on, or `null` when every signed-in Warga sees it. */
	readonly action: Action | null;
}

/**
 * The seven groups, named. A closed union rather than a free string so that the icon table in
 * `app-sidebar.svelte` cannot fall out of step with this file without failing `bun run check`.
 */
export type GroupKey = 'home' | 'posts' | 'mine' | 'finance' | 'residents' | 'services' | 'system';

/** One group of links in the sidebar. */
export interface MenuGroup {
	/** Stable identity: the `{#each}` key, the icon lookup, and which group is open. */
	readonly key: GroupKey;
	/** The paraglide message that names this group. */
	readonly labelKey: MenuMessageKey;
	readonly items: readonly MenuItem[];
}

/**
 * The seven groups of `docs/spec-shell-beranda-v1.md`, in the order the spec lists them. The two
 * single-item groups at the top are groups rather than loose links so that "which group am I in"
 * has an answer on every page; `app-sidebar.svelte` renders a one-item group as a plain link
 * instead of something to open.
 */
export const MENU: readonly MenuGroup[] = [
	{
		key: 'home',
		labelKey: 'appShell_groupHome',
		items: [{ key: 'home', labelKey: 'appShell_navHome', href: '/', action: null }]
	},
	{
		key: 'posts',
		labelKey: 'appShell_groupPosts',
		items: [{ key: 'posts', labelKey: 'appShell_navPosts', href: '/posts', action: null }]
	},
	{
		key: 'mine',
		labelKey: 'appShell_groupMine',
		items: [
			{ key: 'myUnit', labelKey: 'appShell_navMyUnit', href: '/my-unit', action: null },
			{ key: 'invoices', labelKey: 'appShell_navInvoices', href: '/invoices', action: null },
			{ key: 'payments', labelKey: 'appShell_navPayments', href: '/payments', action: null },
			{ key: 'reports', labelKey: 'appShell_navReports', href: '/reports', action: null },
			{ key: 'complaints', labelKey: 'appShell_navComplaints', href: '/complaints', action: null },
			{ key: 'profile', labelKey: 'appShell_navProfile', href: '/profile', action: null },
			{
				key: 'profileNotifications',
				labelKey: 'appShell_navProfileNotifications',
				href: '/profile/notifications',
				action: null
			}
		]
	},
	{
		key: 'finance',
		labelKey: 'appShell_groupFinance',
		items: [
			{
				key: 'verifyPayments',
				labelKey: 'appShell_navVerifyPayments',
				href: '/admin/payments',
				action: ACTION.verifyPayments
			},
			{
				key: 'recordCash',
				labelKey: 'appShell_navRecordCash',
				href: '/admin/cash',
				action: ACTION.recordCashTransactions
			},
			{
				key: 'overdue',
				labelKey: 'appShell_navReadOverdue',
				href: '/admin/overdue',
				action: ACTION.readOverdue
			},
			{
				key: 'periods',
				labelKey: 'appShell_navReadPeriods',
				href: '/admin/periods',
				action: ACTION.readPeriods
			},
			{
				key: 'publishReports',
				labelKey: 'appShell_navPublishReports',
				href: '/admin/reports',
				action: ACTION.publishReports
			},
			{
				key: 'duesRates',
				labelKey: 'appShell_navManageDuesRates',
				href: '/admin/dues-rates',
				action: ACTION.manageDuesRates
			},
			{
				key: 'cashCategories',
				labelKey: 'appShell_navManageCashCategories',
				href: '/admin/cash-categories',
				action: ACTION.manageCashCategories
			},
			{
				key: 'openingBalance',
				labelKey: 'appShell_navRecordOpeningBalance',
				href: '/admin/opening-balance',
				action: ACTION.recordOpeningBalance
			},
			{
				key: 'exemptions',
				labelKey: 'appShell_navManageExemptions',
				href: '/admin/exemptions',
				action: ACTION.manageExemptions
			}
		]
	},
	{
		key: 'residents',
		labelKey: 'appShell_groupResidents',
		items: [
			{
				key: 'units',
				labelKey: 'appShell_navManageUnits',
				href: '/admin/units',
				action: ACTION.manageUnits
			},
			{
				key: 'importResidents',
				labelKey: 'appShell_navImportResidents',
				href: '/admin/import',
				action: ACTION.importResidents
			},
			{
				key: 'invitations',
				labelKey: 'appShell_navManageInvitations',
				href: '/admin/invitations',
				action: ACTION.manageInvitations
			},
			{
				key: 'registrations',
				labelKey: 'appShell_navManageRegistrations',
				href: '/admin/registrations',
				action: ACTION.manageRegistrations
			},
			{
				key: 'roles',
				labelKey: 'appShell_navManageRoles',
				href: '/admin/roles',
				action: ACTION.manageRoles
			}
		]
	},
	{
		key: 'services',
		labelKey: 'appShell_groupServices',
		items: [
			{
				key: 'managePosts',
				labelKey: 'appShell_navManagePosts',
				href: '/admin/posts',
				action: ACTION.managePosts
			},
			{
				key: 'allComplaints',
				labelKey: 'appShell_navReadAllComplaints',
				href: '/admin/complaints',
				action: ACTION.readAllComplaints
			}
		]
	},
	{
		key: 'system',
		labelKey: 'appShell_groupSystem',
		items: [
			{
				key: 'jobs',
				labelKey: 'appShell_navManageJobs',
				href: '/admin/jobs',
				action: ACTION.manageJobs
			}
		]
	}
];

/**
 * The menu a signed-in person holding `roles` may see: every item whose action they hold, plus
 * every item that has no action at all, and only the groups that keep at least one item. The order
 * of `MENU` is preserved in both directions.
 *
 * Pure — no database, no request — so a test can walk every set of roles without a connection.
 * An empty `roles` is not "an anonymous visitor": a database trigger gives every `user` row at
 * least `resident`, so a signed-in Warga always arrives here holding something, and the sidebar
 * decides on its own what a visitor with no session is shown.
 */
export function visibleMenu(roles: Iterable<Role>): readonly MenuGroup[] {
	// Copied into a Set once: `roles` is an Iterable, and a generator would be empty by the second
	// group otherwise.
	const held = new Set(roles);
	const visible: MenuGroup[] = [];
	for (const group of MENU) {
		const items = group.items.filter(
			(item) => item.action === null || isAllowed(held, item.action)
		);
		if (items.length > 0) {
			visible.push({ ...group, items });
		}
	}
	return visible;
}
