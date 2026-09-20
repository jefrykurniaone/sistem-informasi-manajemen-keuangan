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
	import { onDestroy } from 'svelte';
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
	 * however many `<details>` elements happen to be on screen.
	 *
	 * Hover is a shortcut and never the only way in: the trigger is a real button, so click, Enter,
	 * Space and a tap all work, and Escape closes what hover opened (WCAG 1.4.13, riset §1).
	 *
	 * ## A group opened by click is pinned, and the pointer leaving never closes it
	 *
	 * Only hover undoes hover. A group this component's own 300 ms timer opened closes 500 ms after
	 * the pointer leaves; a group opened any other way — a click, Enter, Space, a tap, or the
	 * address landing inside it — stays open until a click on its own title, Escape, another group
	 * opening, or a new address closes it.
	 *
	 * That is the usual menu convention, and here it is also a correctness rule. Opening the group
	 * *below* the open one collapses the one above it, which lifts the newly opened row out from
	 * under the pointer with the pointer never having moved. The browser fires `pointerleave` for
	 * that lift, and a stray leave used to schedule a close on the group that had just opened, so
	 * switching downward shut everything.
	 *
	 * ## Hover only counts as hover while the row stays under the pointer
	 *
	 * Pinning on click fixed the click path and not the hover path, which suffers the same lift:
	 * hovering a group below an open one opened it, collapsed the group above, and the row jumped
	 * away from a motionless pointer. So the hover timer pins too, when it has to. One animation
	 * frame after it opens the group — by then the collapse above has been laid out — it asks
	 * whether the row still covers the last place the pointer actually was, recorded from
	 * `pointerenter` and `pointermove` and never from a leave. If it does not, the pointer did not
	 * leave, the row left: the open is treated as pinned and any close the stray leave has already
	 * scheduled is cancelled.
	 *
	 * A pointer that leaves by its own motion is untouched by that test, because the last recorded
	 * position is then the last one *inside* an unmoved row, which the row still covers. Opening a
	 * group *above* an open one does not shift its own row either. Both keep closing on hover.
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

	/** Open after 300 ms of hovering and close 500 ms after leaving — riset §1, NN/g's numbers. */
	const HOVER_OPEN_DELAY_MS = 300;
	const HOVER_CLOSE_DELAY_MS = 500;

	/** 44 px tap target below the 768 px sidebar breakpoint; the desktop row keeps its own height. */
	const TOUCH_TARGET_CLASS = 'min-h-11 md:min-h-0';

	const sidebar = useSidebar();

	/** The floating face: a collapsed sidebar has no room for sub-items, and a drawer is not it. */
	const floating = $derived(sidebar.state === 'collapsed' && !sidebar.isMobile);
	const label = $derived(m[group.labelKey]());
	const holdsActiveItem = $derived(
		activeItemKey !== null && group.items.some((item) => item.key === activeItemKey)
	);

	let openTimer: ReturnType<typeof setTimeout> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	let settleFrame: number | null = null;

	/** The row, so the frame after an open can ask where it ended up. */
	let itemElement = $state<HTMLLIElement | null>(null);

	/**
	 * The last place the pointer was seen over this group. Written by `pointerenter` and
	 * `pointermove`, and deliberately never by `pointerleave` — that is what lets the settle check
	 * below tell a row that moved from a pointer that moved.
	 *
	 * It is only ever *read* one frame after a hover opened the group, and a hover can only open a
	 * group that is shut, which is when no floating panel exists to have recorded anything. So the
	 * value the check sees is always a position on the row, never one on the panel.
	 */
	let lastPointerX: number | null = null;
	let lastPointerY: number | null = null;

	/**
	 * Whether the open group on screen is the one this component's hover timer opened. False for
	 * every other way in, and that is what "pinned" means above.
	 */
	let hoverOpened = $state(false);

	// A group closed by anything at all forgets how it was opened, so an open this component did
	// not schedule is never mistaken later for hover's to undo.
	$effect(() => {
		if (!open) {
			hoverOpened = false;
		}
	});

	function cancelOpen(): void {
		if (openTimer !== null) {
			clearTimeout(openTimer);
			openTimer = null;
		}
	}

	function cancelClose(): void {
		if (closeTimer !== null) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}

	function cancelSettle(): void {
		if (settleFrame !== null) {
			cancelAnimationFrame(settleFrame);
			settleFrame = null;
		}
	}

	/** Where the pointer last was over this group. Never called from a leave — see the note above. */
	function rememberPointer(event: PointerEvent): void {
		lastPointerX = event.clientX;
		lastPointerY = event.clientY;
	}

	function covers(rect: DOMRect, x: number, y: number): boolean {
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	}

	/**
	 * One frame after a hover opened this group, when the collapse of whatever was open above it
	 * has been laid out: if the row no longer covers the last place the pointer was, the row moved
	 * and the pointer did not, so this open is pinned rather than hover's to undo.
	 *
	 * The close is cancelled as well as the flag cleared, because the stray `pointerleave` can be
	 * dispatched either side of this frame and would otherwise have scheduled one already.
	 */
	function pinWhenRowMovedAway(): void {
		cancelSettle();
		settleFrame = requestAnimationFrame(() => {
			settleFrame = null;
			if (itemElement === null || lastPointerX === null || lastPointerY === null) {
				return;
			}
			if (covers(itemElement.getBoundingClientRect(), lastPointerX, lastPointerY)) {
				return;
			}
			hoverOpened = false;
			cancelClose();
		});
	}

	/**
	 * A pointer arriving on the trigger or on the open panel. A touch reports `pointerType` of
	 * `'touch'` and is ignored outright, so a tap opens the group exactly once through the click
	 * that follows it rather than twice.
	 */
	function handlePointerEnter(event: PointerEvent): void {
		if (event.pointerType === 'touch') {
			return;
		}
		rememberPointer(event);
		// Arriving anywhere inside the group — the trigger or the panel it opened — cancels the
		// close this same handler's counterpart scheduled. That is SC 1.4.13's "Hoverable".
		cancelClose();
		if (open) {
			return;
		}
		cancelOpen();
		openTimer = setTimeout(() => {
			openTimer = null;
			hoverOpened = true;
			onOpenChange(true);
			pinWhenRowMovedAway();
		}, HOVER_OPEN_DELAY_MS);
	}

	function handlePointerLeave(event: PointerEvent): void {
		if (event.pointerType === 'touch') {
			return;
		}
		cancelOpen();
		cancelClose();
		// Only hover undoes hover. A pinned group ignores the pointer leaving, including the
		// `pointerleave` a collapsing neighbour above it causes without the pointer moving at all.
		if (!open || !hoverOpened) {
			return;
		}
		closeTimer = setTimeout(() => {
			closeTimer = null;
			onOpenChange(false);
		}, HOVER_CLOSE_DELAY_MS);
	}

	/**
	 * Every open and close that does not come from this component's hover timer: a click on the
	 * title, Enter, Space, a tap, Escape, and bits-ui closing its own floating panel. All of them
	 * pin, because none of them is hover.
	 */
	function handleOpenChange(next: boolean): void {
		cancelOpen();
		cancelClose();
		cancelSettle();
		hoverOpened = false;
		onOpenChange(next);
	}

	/** Escape closes the panel hover opened, without moving the pointer — SC 1.4.13's "Dismissible". */
	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !open) {
			return;
		}
		handleOpenChange(false);
	}

	function isActive(itemKey: string): boolean {
		return itemKey === activeItemKey;
	}

	// Both timers and the settle frame die with the component: a group can be removed from the menu
	// by a locale switch or a role change while one of them is still pending.
	onDestroy(() => {
		cancelOpen();
		cancelClose();
		cancelSettle();
	});
</script>

{#if floating}
	<DropdownMenu.Root {open} onOpenChange={handleOpenChange}>
		<Sidebar.Menu>
			<Sidebar.MenuItem
				bind:ref={itemElement}
				onpointerenter={handlePointerEnter}
				onpointermove={rememberPointer}
				onpointerleave={handlePointerLeave}
				onkeydown={handleKeydown}
			>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Sidebar.MenuButton {...props} tooltipContent={label} isActive={holdsActiveItem}>
							<Icon />
							<span>{label}</span>
						</Sidebar.MenuButton>
					{/snippet}
				</DropdownMenu.Trigger>
				<!--
					Portalled, so it is no descendant of the item above and needs its own pointer pair.

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
				<DropdownMenu.Content
					side="right"
					align="start"
					class="min-w-48"
					preventScroll={false}
					onpointerenter={handlePointerEnter}
					onpointerleave={handlePointerLeave}
				>
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
	<Collapsible.Root {open} onOpenChange={handleOpenChange} class="group/collapsible">
		<Sidebar.Menu>
			<Sidebar.MenuItem
				bind:ref={itemElement}
				onpointerenter={handlePointerEnter}
				onpointermove={rememberPointer}
				onpointerleave={handlePointerLeave}
				onkeydown={handleKeydown}
			>
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
