import { api } from '$lib/server/api/app';
import type { RequestHandler } from './$types';

/**
 * The catch-all SvelteKit route Elysia's own SvelteKit integration doc asks for: every request
 * under `/api` is handed to `api().handle(request)`, whatever its method or the rest of its path.
 *
 * `/api/auth/*` is not routed here in practice: `src/hooks.server.ts`'s `authHandle` runs
 * `svelteKitHandler`, which answers anything under `/api/auth/` before SvelteKit's router ever
 * picks a route to match — see `tests/e2e/api-health.spec.ts` for the assertion that this still
 * holds with this route mounted.
 */
export const fallback: RequestHandler = ({ request }) => api().handle(request);
