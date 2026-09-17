import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig(({ mode }) => {
	// Every variable out of the .env files and out of the real environment. Vite exposes only
	// VITE_-prefixed names by itself, and none of the server-side variables this application reads
	// carry that prefix, so the prefix argument is deliberately empty.
	const environment = loadEnv(mode, process.cwd(), '');

	// `bun run dev` starts `vite dev` under Node, and Node does not inherit what Bun loaded from
	// .env into its own process, so every request the development server served found
	// DATABASE_URL empty and answered 500 while blaming a .env that was correct. The values are
	// copied here rather than by running the development server under Bun with `bun --bun`:
	// production is built with @sveltejs/adapter-node, and a development runtime different from
	// the production one changes far more than .env loading. This also makes one source serve the
	// development server and the Vitest workers below.
	//
	// `??=`, not assignment: a variable that already exists in the real environment always wins
	// over the file. CI supplies DATABASE_URL and TEST_DATABASE_URL that way, docker compose
	// supplies the container's own view of the network that way, and a machine without a .env has
	// nothing to copy and is left untouched.
	for (const [name, value] of Object.entries(environment)) {
		process.env[name] ??= value;
	}

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter()
			})
		],
		server: {
			host: true,
			port: 5173,
			strictPort: true,
			// Bind mounts on Windows and macOS do not always deliver file-change events into the
			// container. Set VITE_USE_POLLING=true in .env when hot reload stops working.
			watch: { usePolling: process.env.VITE_USE_POLLING === 'true' }
		},
		test: {
			expect: { requireAssertions: true },
			environment: 'node',
			include: ['tests/unit/**/*.{test,spec}.{js,ts}'],
			// Tests talk to a real PostgreSQL and read TEST_DATABASE_URL from the environment. Vitest
			// runs each test file in a Node worker that does not inherit the variables Bun injects
			// from .env into its own process, so the workers are handed the same set read above —
			// which already carries the real environment's values, which is where CI supplies them.
			env: environment,
			// A file's beforeAll hook creates its own schema and runs every migration into it; on a
			// container that has just started that can pass the 10 second default. See
			// src/lib/server/db/test-helpers.ts.
			hookTimeout: 60_000,
			testTimeout: 20_000
		}
	};
});
