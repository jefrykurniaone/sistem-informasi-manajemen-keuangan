import * as m from '#lib/paraglide/messages.js';
import {
	productionDependencies,
	requireUser,
	requireUuidParam,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import { invoiceHistoryForUnit } from '#lib/server/services/dues/queries.ts';
import type { PageServerLoad } from './$types';

/**
 * Admin's full Tagihan history for one house, whatever Masa Huni was running when each one was
 * issued — "Admin melihat seluruh riwayat tagihan sebuah unit, termasuk sebelum masa huni penghuni
 * sekarang." Placed under `/admin/overdue/` rather than `/admin/units/[id]/`, which this ticket's
 * `writes:` does not reach — see the orchestrator's note on this ticket.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): `params.unitId` is read
 * straight from the URL, so a house that does not exist is a 404, never a rejected form, and a
 * malformed id reads the same 404 as an unused one.
 */

/** The 403 for anyone without the right, and the 404 for a unit id that names no house. */
const PAGE = {
	forbidden: m.adminOverdueUnit_forbidden,
	notFound: m.adminOverdueUnit_notFound
} satisfies PageMessages;

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	// `units.id` is a `uuid` column — see #111 and `#lib/server/services/identifier.ts`.
	const unitId = requireUuidParam(params.unitId, PAGE);

	const { db, clock } = productionDependencies();
	try {
		const history = await invoiceHistoryForUnit(db, clock, user.id, unitId);
		return history;
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};
