import * as m from '#lib/paraglide/messages.js';
import {
	productionDependencies,
	requireUser,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import { listOverdueUnits } from '#lib/server/services/dues/queries.ts';
import type { PageServerLoad } from './$types';

/**
 * Admin's daftar penunggak: every house owing something past its due date, largest total first —
 * `docs/spec-iuran-v1.md` user story 18, and the one screen the spec says explicitly "hanya bisa
 * dibuka oleh admin". Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who
 * is not signed in reaches the service layer, and a permission refusal becomes `error(403, …)` here
 * rather than in the service.
 */

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminOverdue_forbidden } satisfies PageMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db, clock } = productionDependencies();
	try {
		const overdue = await listOverdueUnits(db, clock, user.id);
		return { overdue };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};
