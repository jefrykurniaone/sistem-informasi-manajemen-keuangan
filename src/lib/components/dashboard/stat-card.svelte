<script lang="ts" module>
	import type { Pathname } from '$app/types';

	/**
	 * Narrows the `Pathname` union to one member so `resolve` has a single overload to pick.
	 *
	 * The same workaround `app-shell/nav-group.svelte`'s `staticRoute` records, duplicated here
	 * rather than imported: that function lives beside the sidebar for the sidebar's own reason, and
	 * this component has nothing to do with it beyond needing the identical two-line cast.
	 */
	function asRoute(pathname: Pathname): '/' {
		return pathname as '/';
	}
</script>

<script lang="ts">
	import { resolve } from '$app/paths';

	/**
	 * One Beranda card: a number, what it means, and where to go to act on it or verify it —
	 * `docs/research-ui-ux-v1.md` §3's "tiap kartu KPI wajib punya tautan turun ke daftar terfilter
	 * yang menghasilkan angka itu". `src/routes/(app)/+page.server.ts` decides every value, every
	 * label and the order the cards render in; this component only ever renders what it is handed.
	 *
	 * The whole card is the `<a>`, sized to the 44 px tap target `spec-shell-beranda-v1.md` asks for
	 * at 390 px — the same `min-h-11` convention `invoice-card.svelte` and `admin/overdue`'s rows
	 * already use.
	 */
	interface Props {
		/** The one figure the card leads with — already formatted by the caller, never raw here. */
		readonly value: string;
		readonly label: string;
		/** A second line under `value`, for a figure this card carries but does not lead with. */
		readonly detail?: string;
		readonly href: Pathname;
		/** `'warning'` for the two cards the spec calls out by name: menunggak and pending. */
		readonly variant?: 'warning';
	}

	let { value, label, detail, href, variant }: Readonly<Props> = $props();

	const isWarning = $derived(variant === 'warning');
</script>

<a
	href={resolve(asRoute(href))}
	class="flex min-h-11 flex-col gap-1 rounded-lg border p-4 {isWarning
		? 'border-destructive/50 bg-destructive/5'
		: 'border-border'}"
>
	<span class="text-2xl font-bold {isWarning ? 'text-destructive' : ''}">{value}</span>
	<span class="text-sm font-medium">{label}</span>
	{#if detail}
		<span class="text-xs text-muted-foreground">{detail}</span>
	{/if}
</a>
