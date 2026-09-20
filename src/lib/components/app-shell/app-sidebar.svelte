<script lang="ts">
	import BuildingIcon from '@lucide/svelte/icons/building';
	import CircleUserIcon from '@lucide/svelte/icons/circle-user';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MegaphoneIcon from '@lucide/svelte/icons/megaphone';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import UsersIcon from '@lucide/svelte/icons/users';
	import WalletIcon from '@lucide/svelte/icons/wallet';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import LanguageSwitcher from './language-switcher.svelte';
	import NavGroup, { staticRoute } from './nav-group.svelte';
	import type { GroupKey, MenuGroup, MenuItem } from './menu.js';

	/**
	 * The sidebar every route sits beside: the brand, the role-aware menu, and a foot holding the
	 * language choice and the way out.
	 *
	 * It renders only what `+layout.server.ts` already decided a visitor may see — `menu` is the
	 * result of `visibleMenu()`, which answers from the same `PERMISSIONS` table `requirePermission`
	 * uses, so a link never claims a right the guard would refuse. Showing a link is not
	 * authorization: each page behind it still checks for itself.
	 *
	 * **This component owns one piece of state: which group is open.** A group never decides for
	 * itself, which is how "only one group open at a time" and "the group holding the current page
	 * is open the moment the page loads" both hold without reading a single DOM attribute.
	 */
	interface Props {
		readonly signedIn: boolean;
		/** The visible menu, already filtered by permission on the server. */
		readonly menu: readonly MenuGroup[];
	}

	let { signedIn, menu }: Props = $props();

	/**
	 * The icon of each group, keyed by `MenuGroup.key`. It lives here rather than in `menu.ts`
	 * because a Svelte component cannot survive the trip through `+layout.server.ts`'s load data —
	 * see the note at the top of `menu.ts`.
	 */
	const GROUP_ICON: Readonly<Record<GroupKey, typeof LayoutDashboardIcon>> = {
		home: LayoutDashboardIcon,
		posts: MegaphoneIcon,
		mine: CircleUserIcon,
		finance: WalletIcon,
		residents: UsersIcon,
		services: WrenchIcon,
		system: SettingsIcon
	};

	/** 44 px tap target below the 768 px sidebar breakpoint; the desktop row keeps its own height. */
	const TOUCH_TARGET_CLASS = 'min-h-11 md:min-h-0';

	const sidebar = useSidebar();

	/** Whether `href` is the current address or an ancestor of it. `/` only ever matches itself. */
	function covers(pathname: string, href: string): boolean {
		if (href === '/') {
			return pathname === '/';
		}
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	/**
	 * The one item that marks the current address, longest matching prefix first, and the group it
	 * sits in. Longest wins so that `/admin/payments/cash` lands on "Verifikasi Pembayaran" rather
	 * than on the `/admin/payments` of a shorter neighbour, and `/payments` is never confused with
	 * `/admin/payments`.
	 */
	function activeMatchOf(
		groups: readonly MenuGroup[],
		pathname: string
	): { groupKey: GroupKey; itemKey: string } | null {
		let bestGroupKey: GroupKey | null = null;
		let best: MenuItem | null = null;
		for (const group of groups) {
			for (const item of group.items) {
				if (covers(pathname, item.href) && (best === null || item.href.length > best.href.length)) {
					best = item;
					bestGroupKey = group.key;
				}
			}
		}
		if (best === null || bestGroupKey === null) {
			return null;
		}
		return { groupKey: bestGroupKey, itemKey: best.key };
	}

	const activeMatch = $derived(activeMatchOf(menu, page.url.pathname));

	/**
	 * Which group is open — the whole of the "only one group at a time" rule, and the only piece
	 * of state this shell keeps.
	 *
	 * A *writable* `$derived`: it starts as the group holding the current address, so the server
	 * already renders that group open and there is no frame after hydration where it is shut, and
	 * every arrival at a new address resets it the same way. Hover and click write to it directly,
	 * and because neither touches `activeMatch`, a deliberate open or close is never undone until
	 * the address itself changes.
	 */
	let openGroupKey = $derived<GroupKey | null>(activeMatch?.groupKey ?? null);

	function setGroupOpen(groupKey: GroupKey, open: boolean): void {
		if (open) {
			openGroupKey = groupKey;
			return;
		}
		// A close only ever closes the group that asked for it. A pointer travelling from one group
		// to the next leaves a 500 ms close timer behind on the group it left, and that timer must
		// not shut the group the pointer has opened in the meantime.
		if (openGroupKey === groupKey) {
			openGroupKey = null;
		}
	}

	/** Choosing a link closes the telephone drawer; on a wide screen there is nothing to close. */
	function handleNavigate(): void {
		if (sidebar.isMobile) {
			sidebar.setOpenMobile(false);
		}
	}
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg" tooltipContent={m.appShell_brand()}>
					{#snippet child({ props })}
						<a {...props} href={resolve('/')}>
							<BuildingIcon />
							<span class="font-semibold tracking-tight">{m.appShell_brand()}</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<nav aria-label={m.appShell_navLabel()} class="flex flex-col gap-1">
					{#if signedIn}
						{#each menu as group (group.key)}
							{#if group.items.length === 1}
								<!-- A group of one is a link, not something to open: Beranda and the
								     announcement board have nothing to disclose. -->
								{@const only = group.items[0]}
								{@const OnlyIcon = GROUP_ICON[group.key]}
								<Sidebar.Menu>
									<Sidebar.MenuItem>
										<Sidebar.MenuButton
											isActive={activeMatch?.itemKey === only.key}
											tooltipContent={m[group.labelKey]()}
											class={TOUCH_TARGET_CLASS}
										>
											{#snippet child({ props })}
												<a
													{...props}
													href={resolve(staticRoute(only.href))}
													aria-current={activeMatch?.itemKey === only.key ? 'page' : undefined}
													onclick={handleNavigate}
												>
													<OnlyIcon />
													<span>{m[group.labelKey]()}</span>
												</a>
											{/snippet}
										</Sidebar.MenuButton>
									</Sidebar.MenuItem>
								</Sidebar.Menu>
							{:else}
								<NavGroup
									{group}
									icon={GROUP_ICON[group.key]}
									open={openGroupKey === group.key}
									activeItemKey={activeMatch?.itemKey ?? null}
									onOpenChange={(open) => setGroupOpen(group.key, open)}
									onNavigate={handleNavigate}
								/>
							{/if}
						{/each}
					{:else}
						<Sidebar.Menu>
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									tooltipContent={m.appShell_navHome()}
									class={TOUCH_TARGET_CLASS}
								>
									{#snippet child({ props })}
										<a {...props} href={resolve('/')} onclick={handleNavigate}>
											<LayoutDashboardIcon />
											<span>{m.appShell_navHome()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									tooltipContent={m.appShell_navPosts()}
									class={TOUCH_TARGET_CLASS}
								>
									{#snippet child({ props })}
										<a {...props} href={resolve('/posts')} onclick={handleNavigate}>
											<MegaphoneIcon />
											<span>{m.appShell_navPosts()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									tooltipContent={m.appShell_navLogin()}
									class={TOUCH_TARGET_CLASS}
								>
									{#snippet child({ props })}
										<a {...props} href={resolve('/login')} onclick={handleNavigate}>
											<CircleUserIcon />
											<span>{m.appShell_navLogin()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									tooltipContent={m.appShell_navRegister()}
									class={TOUCH_TARGET_CLASS}
								>
									{#snippet child({ props })}
										<a {...props} href={resolve('/register')} onclick={handleNavigate}>
											<UsersIcon />
											<span>{m.appShell_navRegister()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						</Sidebar.Menu>
					{/if}
				</nav>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<!-- A labelled `<select>` needs the whole width; the icon rail has none to give. -->
		<div class="group-data-[collapsible=icon]:hidden">
			<LanguageSwitcher />
		</div>
		{#if signedIn}
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<form method="POST" action={resolve('/logout')}>
						<Sidebar.MenuButton tooltipContent={m.appShell_navLogout()} class={TOUCH_TARGET_CLASS}>
							{#snippet child({ props })}
								<!-- The generated `Sidebar.MenuButton` types no `type` attribute, and a button
								     inside a form defaults to `submit` only by accident of the spec; spell it. -->
								<button {...props} type="submit">
									<LogOutIcon />
									<span>{m.appShell_navLogout()}</span>
								</button>
							{/snippet}
						</Sidebar.MenuButton>
					</form>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		{/if}
	</Sidebar.Footer>
</Sidebar.Root>
