import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from 'vite';

/**
 * The end-to-end harness: one production build, served by `bun run preview`, driven by Chromium.
 *
 * ## `ORIGIN` and the preview port are one decision, and it is written down once
 *
 * `PORT` below is the only place this harness names a port. The `--port` the preview server is
 * started with, the `baseURL` every test navigates against, and the `ORIGIN` that server reads are
 * all derived from it, so there is nothing left for a second line to disagree with.
 *
 * They have to agree, and not for tidiness. `src/lib/server/auth.ts` hands `ORIGIN` to better-auth
 * as its `baseURL` — this repository has no `BETTER_AUTH_URL`, deliberately, so that two variables
 * cannot drift apart — and `better-auth/svelte-kit`'s `svelteKitHandler` forwards a request to
 * better-auth's own router only when the request's origin equals that `baseURL` exactly. The
 * preview server builds that origin from the request's `Host` header, which is the address it is
 * really listening on. Pin a port here while `ORIGIN` names another one, and every `/api/auth/*`
 * request falls through to SvelteKit and is answered instead by the Elysia catch-all mounted at
 * `/api`, with a 404 — silently, for every test at once, with nothing in the output to say why.
 *
 * That is not hypothetical: it is what this file did while it pinned the port and left `ORIGIN` to
 * `.env`, which names the address `bun run dev` serves on. The whole better-auth HTTP surface was
 * unreachable from the e2e layer, so the most expensive failure this application has — the
 * catch-all quietly starting to swallow `/api/auth/*` — was the one failure no test could see.
 * `tests/e2e/api-health.spec.ts` proves both sides of that boundary now, and it can only keep
 * doing so while the uses below stay derived from `PORT`. Do not split them again.
 *
 * `ORIGIN` is also what decides whether the session cookie is marked `Secure`, so the scheme here
 * stays `http://`: a browser never stores a `Secure` cookie handed out over plain
 * `http://localhost`, and a session cookie that is never stored signs nobody in.
 *
 * The port is deliberately *not* read back out of `ORIGIN` or out of `.env`. The preview server
 * must not land on the port `bun run dev` already answers on, and a clean checkout carrying no
 * `.env` at all — which is what CI is — still has to be able to run `bun run test:e2e` without
 * anyone filling a variable in by hand first.
 */
const PORT = 4173;

/** The one address this run serves on, drives and asserts against. */
const ORIGIN = `http://localhost:${PORT}`;

/**
 * Copies `.env` into this process, the same way `vite.config.ts` does and for the same reason.
 *
 * Bun reads `.env` into its own process, but the Playwright command it spawns for `bun run
 * test:e2e` does not inherit those values, and neither do the Node workers Playwright forks from
 * it. Measured rather than assumed: a worker printed `DATABASE_URL = undefined` under `bun run
 * test:e2e` while the same variable was set in `.env`. Every spec that reads the database — every
 * one that registers an account and waits for its verification mail — therefore reached `pg`'s
 * built-in default of `localhost:5432` and failed with `ECONNREFUSED`, blaming a `.env` that was
 * correct. The values are read here, in the configuration, because it is evaluated in the runner
 * before a worker or the web server is started, and both are handed `process.env`.
 *
 * `??=`, not assignment: a variable that already exists in the real environment always wins over
 * the file, which is decision #59. CI has no `.env` to read and supplies `DATABASE_URL` itself.
 */
for (const [name, value] of Object.entries(loadEnv('production', process.cwd(), ''))) {
	process.env[name] ??= value;
}

/**
 * The exception to the `??=` above. This run serves on `PORT` and nowhere else, so the address it
 * answers on outranks whatever `.env` names for `bun run dev` — otherwise the two disagree again,
 * which is the whole defect this file exists to keep fixed.
 */
process.env.ORIGIN = ORIGIN;

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: '**/*.spec.ts',
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	use: { baseURL: ORIGIN },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: `bun run build && bun run preview --port ${PORT}`,
		port: PORT,
		reuseExistingServer: !process.env.CI,
		// Playwright allows a web server 60 seconds by default, and this one runs a full production
		// build before it serves anything — measured between 35 and 55 seconds on a warm machine, and
		// longer on a cold one or while the gate is also running. The default turned that into a
		// timeout that looks exactly like a broken server, so it is raised to three minutes. It is a
		// ceiling, not a wait: the run starts as soon as the port answers.
		timeout: 180_000,
		// Playwright layers this over `process.env` rather than replacing it, so everything else the
		// machine supplies still reaches the server. `ORIGIN` is named again here, derived from the
		// same constant, so that reading this block alone is enough to see which address the server
		// under test is told it answers on.
		env: { ORIGIN }
	}
});
