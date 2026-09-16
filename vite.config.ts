import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig(({ mode }) => ({
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
		// from .env into its own process, and Vite only exposes VITE_-prefixed variables by
		// itself. loadEnv with an empty prefix reads every variable out of the .env files (and
		// out of the real environment, which is where CI supplies them) so the workers see them.
		env: loadEnv(mode, process.cwd(), ''),
		// A file's beforeAll hook creates its own schema and runs every migration into it; on a
		// container that has just started that can pass the 10 second default. See
		// src/lib/server/db/test-helpers.ts.
		hookTimeout: 60_000,
		testTimeout: 20_000
	}
}));
