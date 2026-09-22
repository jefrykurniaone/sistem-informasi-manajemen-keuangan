<script lang="ts" module>
	import type { Pathname } from '$app/types';

	/**
	 * Narrows one of the application's pathnames to a single route, so that `resolve` can be
	 * called on it.
	 *
	 * `resolve` is generic over one route at a time, and a menu item's `href` is the whole
	 * `Pathname` union, which leaves TypeScript with no overload to pick. Narrowing to any one
	 * member restores that and changes no value: every `href` in `menu.ts` is a static pathname,
	 * and `resolve` does the one same thing to all of them — prefix the base path. `bun run check`
	 * still refuses an `href` in `menu.ts` that is not a route this application has.
	 *
	 * Exported from this module block so `app-sidebar.svelte`, which already imports this
	 * component, shares the one copy. `$app/paths`' `base` is the other way to write this and is
	 * deprecated.
	 */
	export function staticRoute(pathname: Pathname): '/' {
		return pathname as '/';
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { MenuGroup } from './menu.js';

	/**
	 * One menu group with two faces, from one set of items — the workaround
	 * `docs/research-ui-ux-v1.md` §2 records for shadcn-ui/ui#5874, which is closed as not planned:
	 * a collapsed sidebar cannot show sub-items, so the group becomes a floating menu instead.
	 *
	 * - Wide sidebar, or the telephone drawer: `Collapsible` over `Sidebar.MenuSub`.
	 * - Collapsed sidebar on anything that is not a telephone: `DropdownMenu` hung off the icon.
	 *
	 * **This component does not own whether it is open.** `app-sidebar.svelte` holds one value —
	 * the key of the group that is open — and hands the answer down as `open`, so "only one group
	 * open" and "the active page's group is open on load" are enforced in one place instead of by
	 * however many disclosures happen to be on screen.
	 *
	 * ## Click-only, no hover-intent
	 *
	 * `docs/spec-shell-masuk-v1.md` reverses the hover-intent behaviour `docs/spec-shell-beranda-v1.md`
	 * introduced: a group opens only when its title is clicked, tapped, or activated with Enter or
	 * Space, and closes the same way, by a second activation of the same trigger. A pointer merely
	 * crossing the sidebar on its way elsewhere no longer opens or closes anything.
	 *
	 * `Collapsible.Trigger` and `DropdownMenu.Trigger` render a real `<button>`, through
	 * `Sidebar.MenuButton`'s `child` snippet, so click, Enter, Space and a tap all reach it through
	 * the browser's own activation, and this file keeps no pointer-event bookkeeping. `open` and
	 * `onOpenChange` make both `Collapsible.Root` and `DropdownMenu.Root` controlled, so a click
	 * toggling one group and `app-sidebar.svelte`'s "only one open" rule are the same write.
	 *
	 * Escape closes the group through this component's own `onkeydown`, WCAG SC 1.4.13's
	 * "Dismissible", which matters most for the floating panel a collapsed sidebar opens. The panel
	 * also closes on an outside click and on choosing one of its links, both handled by bits-ui
	 * without help from here.
	 */
	interface Props {
		readonly group: MenuGroup;
		/**
		 * The group's icon, owned by `app-sidebar.svelte` — see the note in `menu.ts`. Typed off a
		 * lucide icon this file already imports, because every icon in `@lucide/svelte` has exactly
		 * that component type and spelling it by hand would only invite it to drift.
		 */
		readonly icon: typeof ChevronRightIcon;
		readonly open: boolean;
		/** The key of the one item matching the current address, or `null`. */
		readonly activeItemKey: string | null;
		readonly onOpenChange: (open: boolean) => void;
		/** Called when an item is chosen, so the telephone drawer can close itself. */
		readonly onNavigate: () => void;
	}

	let { group, icon: Icon, open, activeItemKey, onOpenChange, onNavigate }: Props = $props();

	/** 44 px tap target below the 768 px sidebar breakpoint; the desktop row keeps its own height. */
	const TOUCH_TARGET_CLASS = 'min-h-11 md:min-h-0';

	const sidebar = useSidebar();

	/** The floating face: a collapsed sidebar has no room for sub-items, and a drawer is not it. */
	const floating = $derived(sidebar.state === 'collapsed' && !sidebar.isMobile);
	const label = $derived(m[group.labelKey]());
	const holdsActiveItem = $derived(
		activeItemKey !== null && group.items.some((item) => item.key === activeItemKey)
	);

	/** Escape closes the group: WCAG SC 1.4.13's "Dismissible", load-bearing for the floating panel. */
	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !open) {
			return;
		}
		onOpenChange(false);
	}

	function isActive(itemKey: string): boolean {
		return itemKey === activeItemKey;
	}
</script>

{#if floating}
	<DropdownMenu.Root {open} {onOpenChange}>
		<Sidebar.Menu>
			<Sidebar.MenuItem onkeydown={handleKeydown}>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Sidebar.MenuButton {...props} tooltipContent={label} isActive={holdsActiveItem}>
							<Icon />
							<span>{label}</span>
						</Sidebar.MenuButton>
					{/snippet}
				</DropdownMenu.Trigger>
				<!--
					Portalled, so it is no descendant of the item above.

					`preventScroll={false}` is what makes this panel non-modal. bits-ui 2.19.2 has no
					`modal` prop on a menu; what blocks the rest of the page is its body scroll lock,
					which sets `document.body.style.pointerEvents = "none"`
					(`bits-ui/dist/internal/body-scroll-lock.svelte.js:129`) and is switched by
					`preventScroll` on the content, `true` by default
					(`bits-ui/dist/bits/utilities/popper-layer/popper-layer-inner.svelte:56`, prop
					documented on `ScrollLockProps`). With it off, the pointer reaches the next icon on
					the rail and slides from one floating menu to the next. Focus is still scoped to the
					open panel: `trapFocus` is written into `menu-content.svelte` after the consumer's
					props and cannot be turned off from here.
				-->
				<DropdownMenu.Content side="right" align="start" class="min-w-48" preventScroll={false}>
					<DropdownMenu.Label>{label}</DropdownMenu.Label>
					{#each group.items as item (item.key)}
						<!-- The active row is styled through the item's own `class`, so the anchor below
						     only has to spread what bits-ui hands it. -->
						<DropdownMenu.Item class={isActive(item.key) ? 'bg-accent font-medium' : undefined}>
							{#snippet child({ props })}
								<a
									{...props}
									href={resolve(staticRoute(item.href))}
									aria-current={isActive(item.key) ? 'page' : undefined}
								>
									{m[item.labelKey]()}
								</a>
							{/snippet}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</DropdownMenu.Root>
{:else}
	<Collapsible.Root {open} {onOpenChange} class="group/collapsible">
		<Sidebar.Menu>
			<Sidebar.MenuItem onkeydown={handleKeydown}>
				<Collapsible.Trigger>
					{#snippet child({ props })}
						<Sidebar.MenuButton
							{...props}
							class={TOUCH_TARGET_CLASS}
							tooltipContent={label}
							isActive={holdsActiveItem}
						>
							<Icon />
							<span>{label}</span>
							<ChevronRightIcon
								class="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
							/>
						</Sidebar.MenuButton>
					{/snippet}
				</Collapsible.Trigger>
				<Collapsible.Content>
					<Sidebar.MenuSub>
						{#each group.items as item (item.key)}
							<Sidebar.MenuSubItem>
								<Sidebar.MenuSubButton isActive={isActive(item.key)} class={TOUCH_TARGET_CLASS}>
									{#snippet child({ props })}
										<a
											{...props}
											href={resolve(staticRoute(item.href))}
											aria-current={isActive(item.key) ? 'page' : undefined}
											onclick={onNavigate}
										>
											<span>{m[item.labelKey]()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuSubButton>
							</Sidebar.MenuSubItem>
						{/each}
					</Sidebar.MenuSub>
				</Collapsible.Content>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Collapsible.Root>
{/if}
