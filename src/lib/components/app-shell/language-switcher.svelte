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
	 * request, server-rendered `<html lang>` included.
	 */

	const LANGUAGE_LABEL: Readonly<Record<Locale, () => string>> = {
		id: m.appShell_languageId,
		en: m.appShell_languageEn
	};

	const uid = $props.id();

	function onLocaleChange(event: Event & { currentTarget: HTMLSelectElement }): void {
		setLocale(event.currentTarget.value as Locale);
	}
</script>

<div class="flex items-center gap-2 text-sm">
	<label class="text-muted-foreground" for="app-shell-language-{uid}">
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
