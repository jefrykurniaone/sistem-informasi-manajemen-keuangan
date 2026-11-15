import * as m from '#lib/paraglide/messages.js';
import { ACTION, requirePermission } from '#lib/server/authz.ts';
import type { ComplaintStatus } from '#lib/server/db/schema/complaint.ts';
import {
	productionDependencies,
	requireUser,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import { complaintWorklistSummary, listComplaints } from '#lib/server/services/complaint/index.ts';
import { OPEN_COMPLAINT_STATUSES } from '#lib/server/services/complaint/state-machine.ts';
import type { PageServerLoad } from './$types';

/**
 * The admin work queue for Keluhan: everything still open, longest wait first, filterable by
 * status and category, with the current month's summary above it. Story 12, 13, 14 and 20.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, and `PermissionDeniedError` becomes `error(403, …)` here.
 *
 * **This route calls `requirePermission` itself, before calling `listComplaints`.** `listComplaints`
 * is documented as refusing nobody — it is the same function #44's resident screen calls for a
 * warga's own list — so the admin-only guard this ticket's acceptance criteria asks for
 * ("peran warga tidak dapat membuka daftar kerja ini") has to live here, not in the shared service.
 */

/** The 403 for anyone who may not read every Keluhan. The work queue has no 404 of its own. */
const PAGE = { forbidden: m.adminComplaints_forbidden } satisfies PageMessages;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals);

	const status = parseStatus(url.searchParams.get('status'));
	const category = parseCategory(url.searchParams.get('category'));

	const { db, clock } = productionDependencies();
	try {
		await requirePermission(db, user.id, ACTION.readAllComplaints);

		const [items, summary] = await Promise.all([
			listComplaints(db, clock, {
				viewerUserId: user.id,
				status,
				category,
				onlyOpen: true
			}),
			complaintWorklistSummary(db, clock, user.id)
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
		throwRouteError(caught, PAGE);
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
