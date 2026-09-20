// `menu.ts` is deliberately absent from this barrel. It imports `$lib/server/authz`, so re-exporting
// it here would drag the permission table into the browser bundle of every file that reaches for
// `AppSidebar`, and SvelteKit would refuse the build. The server imports it by its own path.
export { default as AppSidebar } from './app-sidebar.svelte';
export { default as LanguageSwitcher } from './language-switcher.svelte';
