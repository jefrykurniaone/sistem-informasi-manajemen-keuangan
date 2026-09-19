import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { ACTION, requirePermission } from '$lib/server/authz';
import { database } from '$lib/server/db';
import type { ComplaintStatus } from '$lib/server/db/schema/complaint';
import { systemClock } from '$lib/server/ports/clock';
import { complaintWorklistSummary, listComplaints } from '$lib/server/services/complaint';
import { OPEN_COMPLAINT_STATUSES } from '$lib/server/services/complaint/state-machine';
import type { PageServerLoad } from './$types';

/**
 * The admin work queue for Keluhan: everything still open, longest wait first, filterable by
 * status and category, with the current month's summary above it. Story 12, 13, 14 and 20.
 *
 * Follows the shape `(app)/admin/posts/+page.server.ts` settled: nobody who is not signed in
 * reaches the service layer, and `PermissionDeniedError` becomes `error(403, …)` here.
 *
 * **This route calls `requirePermission` itself, before calling `listComplaints`.** `listComplaints`
 * is documented as refusing nobody — it is the same function #44's resident screen calls for a
 * warga's own list — so the admin-only guard this ticket's acceptance criteria asks for
 * ("peran warga tidak dapat membuka daftar kerja ini") has to live here, not in the shared service.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const status = parseStatus(url.searchParams.get('status'));
	const category = parseCategory(url.searchParams.get('category'));

	try {
		const db = database();
		await requirePermission(db, locals.user.id, ACTION.readAllComplaints);

		const [items, summary] = await Promise.all([
			listComplaints(db, systemClock, {
				viewerUserId: locals.user.id,
				status,
				category,
				onlyOpen: true
			}),
			complaintWorklistSummary(db, systemClock, locals.user.id)
		]);

		return {
			complaints: items.map((item) => ({
				id: item.id,
				title: item.title,
				category: item.category,
				status: item.status,
				statusChangedAt: item.statusChangedAt,
				ageDays: Math.floor(item.ageMilliseconds / (24 * 60 * 60 * 1000)),
				stale: item.stale
			})),
			summary,
			filters: { status: status ?? '', category: category ?? '' },
			statuses: OPEN_COMPLAINT_STATUSES
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

/** A status from the query string, restricted to the open ones this screen ever filters by. */
function parseStatus(value: string | null): ComplaintStatus | undefined {
	return OPEN_COMPLAINT_STATUSES.find((status) => status === value);
}

/**
 * A category from the query string, trimmed, or `undefined` for "every category".
 *
 * There is no closed list of categories to validate against — `src/lib/server/db/schema/complaint.ts`
 * says so outright — so this is an exact-match text filter, the same shape `listComplaints`'s own
 * `category` parameter already expects.
 */
function parseCategory(value: string | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` so this can sit in a `catch` block without widening
 * what SvelteKit infers a load function returns, exactly as the posts and registrations screens'
 * copies of this helper explain.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminComplaints_forbidden());
	}
	throw caught;
}
