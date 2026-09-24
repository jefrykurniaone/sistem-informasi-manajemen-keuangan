<script lang="ts">
	import { getLocale, locales, setLocale, type Locale } from '$lib/paraglide/runtime.js';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * A real `<select>`, labelled, so it is keyboard- and screen-reader-usable without any extra
	 * wiring — no `role=`, no click handler standing in for a form control (see S1082 / S6819 in
	 * this repository's coding standard).
	 *
	 * `setLocale` writes the `PARAGLIDE_LOCALE` cookie (configured in `vite.config.ts`) and, by
	 * default, performs a full document navigation — which is what makes the choice survive a
	 * reload and take effect through `src/hooks.server.ts`'s `localeHandle` on the very next
	 * request, server-rendered `<html lang>` included. That is also why a choice made on a
	 * signed-out page still applies once the visitor signs in.
	 *
	 * Reused at three placements: the `(app)` sidebar footer, the `(public)` header, and the
	 * `(auth)` form column. The two guest placements are tight on width, so `hideLabel` lets them
	 * keep the label in the accessibility tree while hiding it visually (`sr-only`); the sidebar
	 * footer has room and leaves it visible.
	 */

	interface Props {
		/** Visually hide the label (`sr-only`) without removing it for screen readers. */
		readonly hideLabel?: boolean;
	}

	const LANGUAGE_LABEL: Readonly<Record<Locale, () => string>> = {
		id: m.appShell_languageId,
		en: m.appShell_languageEn
	};

	let { hideLabel = false }: Props = $props();

	const uid = $props.id();

	function onLocaleChange(event: Event & { currentTarget: HTMLSelectElement }): void {
		setLocale(event.currentTarget.value as Locale);
	}
</script>

<div class="flex items-center gap-2 text-sm">
	<label class="text-muted-foreground" class:sr-only={hideLabel} for="app-shell-language-{uid}">
		{m.appShell_languageLabel()}
	</label>
	<select
		id="app-shell-language-{uid}"
		class="h-9 rounded-md border border-border bg-background px-2 text-sm"
		value={getLocale()}
		onchange={onLocaleChange}
	>
		{#each locales as locale (locale)}
			<option value={locale}>{LANGUAGE_LABEL[locale]()}</option>
		{/each}
	</select>
</div>
