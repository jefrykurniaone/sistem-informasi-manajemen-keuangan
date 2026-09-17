// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Session, User } from 'better-auth';

declare global {
	namespace App {
		// interface Error {}
		/**
		 * What `src/hooks.server.ts` puts on every request, so that no `load` or form action has
		 * to fetch the session for itself.
		 *
		 * Both are `null` when nobody is signed in — and, because signing in requires a verified
		 * address, a `user` that is not `null` is always one whose email has been proven.
		 */
		interface Locals {
			session: Session | null;
			user: User | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
