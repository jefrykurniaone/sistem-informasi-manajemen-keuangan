import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { invoiceHistoryForUnit, UnitNotFoundError } from '$lib/server/services/dues/queries';
import type { PageServerLoad } from './$types';

/**
 * Admin's full Tagihan history for one house, whatever Masa Huni was running when each one was
 * issued — "Admin melihat seluruh riwayat tagihan sebuah unit, termasuk sebelum masa huni penghuni
 * sekarang." Placed under `/admin/overdue/` rather than `/admin/units/[id]/`, which this ticket's
 * `writes:` does not reach — see the orchestrator's note on this ticket.
 *
 * Follows the same shape `(app)/admin/units/[id]/+page.server.ts` settled: `params.unitId` is read
 * straight from the URL, so a house that does not exist is a 404, never a rejected form.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const history = await invoiceHistoryForUnit(
			database(),
			systemClock,
			locals.user.id,
			params.unitId
		);
		return history;
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

/**
 * Turns a caught permission refusal into a 403, or a missing house into a 404, and throws it — or
 * rethrows whatever else it was. Always throws, for the reason every other copy of this helper in
 * this codebase gives.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminOverdueUnit_forbidden());
	}
	if (caught instanceof UnitNotFoundError) {
		throw error(404, m.adminOverdueUnit_notFound());
	}
	throw caught;
}
