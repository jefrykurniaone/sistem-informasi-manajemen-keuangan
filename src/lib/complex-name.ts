import { PUBLIC_COMPLEX_NAME } from '$app/env/public';

/**
 * The name of the housing complex this installation serves, and the tab title built from it
 * (`docs/spec-shell-masuk-v1.md`): "Nama komplek adalah `PUBLIC_COMPLEX_NAME`, dibaca lewat
 * `$env/static/public` supaya tersedia di klien dan server, dengan nilai bawaan "Komplek" bila
 * kosong." It replaced the `appShell_brand` message, because a complex's name is configuration of
 * one installation rather than text that changes with the interface language.
 *
 * **Static, not dynamic.** `src/env.ts` declares the variable `public` and `static`, so its value
 * is inlined at build time and `$app/env/public` hands it to the server and the browser alike (the
 * spec's `$env/static/public` is the SvelteKit 2 name for the same thing). The sidebar, the public
 * header and every tab title render it with no request to fetch it, and a page never flashes a
 * placeholder before the real name arrives. The price is that changing the name means building
 * again, which `docs/spec-deploy-uji-v1.md` records for the deploy runbook. A build that sees no
 * value at all still succeeds: the declaration's `schema` turns a missing variable into the empty
 * string, which `normalizeComplexName` below turns into "Komplek". `.env.example` and the CI
 * workflow still carry the line, so the name a build uses is a visible choice.
 *
 * The two pure functions below carry all of the behaviour, so `tests/unit/complex-name.test.ts`
 * proves them with whatever raw value it likes instead of depending on the one this build saw.
 */

/** What the complex is called when `PUBLIC_COMPLEX_NAME` is unset, empty or only whitespace. */
export const DEFAULT_COMPLEX_NAME = 'Komplek';

/**
 * The name to show for a raw configured value: trimmed, and `DEFAULT_COMPLEX_NAME` when nothing is
 * left. Whitespace counts as empty because a `.env` line such as `PUBLIC_COMPLEX_NAME= ` is a slip,
 * not a request for a blank brand.
 */
export function normalizeComplexName(raw: string | undefined): string {
	const trimmed = raw?.trim() ?? '';
	return trimmed === '' ? DEFAULT_COMPLEX_NAME : trimmed;
}

/**
 * A tab title in the one pattern the spec names, "Judul halaman - Nama komplek". A page with no
 * title of its own gets the complex name alone rather than a title that starts with a separator.
 */
export function composePageTitle(pageTitle: string, name: string): string {
	const trimmed = pageTitle.trim();
	return trimmed === '' ? name : `${trimmed} - ${name}`;
}

/** The complex name this build was configured with. */
export const complexName: string = normalizeComplexName(PUBLIC_COMPLEX_NAME);

/** A tab title for this installation: `pageTitle` followed by `complexName`. */
export function pageTitle(title: string): string {
	return composePageTitle(title, complexName);
}
