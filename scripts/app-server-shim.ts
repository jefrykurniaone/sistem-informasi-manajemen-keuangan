/**
 * A stand-in for SvelteKit's `$app/server`, so that `src/lib/server/auth.ts` can be imported by a
 * script run with plain `bun run`.
 *
 * ## Why this file has to exist
 *
 * `$app/server` is a *virtual* module. Only SvelteKit's own module loader resolves it, and
 * `.svelte-kit/tsconfig.json` maps `$lib` and `$app/types` and nothing else — so a plain
 * `bun run` that reaches `src/lib/server/auth.ts` fails outright:
 *
 * ```
 * error: Cannot find module '$app/server' from '…/src/lib/server/auth.ts'
 * ```
 *
 * `scripts/grant-superuser.ts` avoids the problem by never importing that module, and its own doc
 * comment says so in as many words: "Only `db`, the `Clock` port and `bootstrap.ts`.
 * `src/lib/server/auth.ts` imports `$app/server`, which only SvelteKit's module loader can resolve,
 * so pulling it — or anything that pulls it — in would make this script need a shim to run at all."
 *
 * `scripts/seed-dev.ts` is the script that needs it. It creates the Data Contoh accounts through
 * better-auth's own `signUpEmail`, so that a seeded password is hashed exactly the way a real
 * sign-up hashes one, and the only configured better-auth instance this repository has is
 * `createAuth` in `src/lib/server/auth.ts`. Rebuilding that configuration inside the seeder was
 * rejected: the scrypt parameters, the schema mapping and the session rules would then exist in two
 * places, and the copy nobody signs in against is the one that drifts.
 *
 * ## Why it may throw rather than do something
 *
 * `getRequestEvent()` is used in exactly one place — `auth()` passes it to `sveltekitCookies` — and
 * `auth.ts` is explicit that a script must not go through `auth()`:
 *
 * > **`auth()` may only be called while a request is in flight.** … A scheduled job, a seed script
 * > or a command-line tool that needs better-auth builds its own instance with `createAuth()` and
 * > no plugins.
 *
 * `scripts/seed-dev.ts` does exactly that, so nothing ever calls the function below. It is here to
 * make the *import* resolve, and it throws rather than returning a fake event because a plausible
 * stand-in would let a future caller reach `auth()` from a script and get a session cookie written
 * into nothing at all.
 *
 * It is wired up by `scripts/tsconfig.seed.json`, which the `db:seed-dev` script passes to Bun with
 * `--tsconfig-override`. Nothing in `src/` imports this file, and the running application never
 * loads it: SvelteKit resolves the real `$app/server` itself.
 */

/**
 * Refuses, always.
 *
 * @throws {Error} explaining that a command-line script builds its own better-auth instance with
 *   `createAuth()` instead of calling `auth()`.
 */
export function getRequestEvent(): never {
	throw new Error(
		'getRequestEvent() is not available outside SvelteKit. This is scripts/app-server-shim.ts, the stand-in for $app/server that lets a command-line script import src/lib/server/auth.ts. A script builds its own better-auth instance with createAuth() and no plugins — see the "Two things the next ticket has to know" section of src/lib/server/auth.ts — so nothing should have called this.'
	);
}
