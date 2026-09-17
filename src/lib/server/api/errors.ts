/**
 * The one error shape every response out of the Elysia surface takes.
 *
 * `src/routes/api/[...slugs]/+server.ts` mounts an Elysia instance straight onto the network, so
 * anything an unguarded route throws would otherwise reach the caller as whatever `.toString()` or
 * a driver produces — a stack trace, a file path, a SQL fragment. Every route in
 * `src/lib/server/api/app.ts` and every macro in `src/lib/server/api/auth-macro.ts` reports failure
 * through the constants and the builder below instead, so a caller — human or another service —
 * always gets the same `{ error: { message } }` shape, and the message is one of a small, fixed set
 * written here rather than composed from whatever the underlying failure happened to say.
 *
 * These messages are developer-facing JSON, not interface text a resident reads, so they stay in
 * English per this repository's language convention.
 */

/** The body every API error response carries. */
export interface ApiErrorBody {
	readonly error: {
		readonly message: string;
	};
}

/** Builds the uniform error body around one message. */
export function apiErrorBody(message: string): ApiErrorBody {
	return { error: { message } };
}

/** The fixed set of messages this surface ever answers a failure with. */
export const API_ERROR = {
	unauthorized: 'Authentication required.',
	forbidden: 'You do not have permission to perform this action.',
	notFound: 'Not found.',
	badRequest: 'The request could not be understood.',
	internal: 'An internal error occurred.'
} as const;
