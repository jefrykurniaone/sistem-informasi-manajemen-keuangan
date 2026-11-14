import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Every environment variable SvelteKit itself hands to application code, through `$app/env/public`
 * and `$app/env/private`. There is one. The rest of the server reads `process.env` directly (see
 * the third point in `src/lib/server/db/index.ts`), and stays that way.
 *
 * - **`PUBLIC_COMPLEX_NAME`** is `public`, because the sidebar and every tab title render it in the
 *   browser too, and `static`, because the value is inlined at build time so no page ever waits for
 *   it. `src/lib/complex-name.ts` records why. Without a `schema` SvelteKit insists the variable is
 *   set, so the function turns a missing one into the empty string: a build with no name configured
 *   still succeeds, and `normalizeComplexName` shows "Komplek" for it.
 */
export const variables = defineEnvVars({
	PUBLIC_COMPLEX_NAME: {
		public: true,
		static: true,
		schema: (value) => value ?? ''
	}
});
