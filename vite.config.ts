import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
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
		include: ['tests/unit/**/*.{test,spec}.{js,ts}']
	}
});
