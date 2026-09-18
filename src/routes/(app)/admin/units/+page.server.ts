import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	createUnit,
	DEFAULT_UNIT_PAGE_SIZE,
	listUnits,
	needsPrimaryOccupant,
	UnitConflictError
} from '$lib/server/services/unit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the house register: search and pagination over `units`, and a form to
 * add a new one. Follows the shape `src/routes/(app)/admin/roles/+page.server.ts` settled — nobody
 * who is not signed in reaches the service layer, and `PermissionDeniedError` becomes `error(403,
 * …)` here, never in the service.
 *
 * Deactivating and reactivating a unit live on `[id]/+page.server.ts`, next to the single unit they
 * act on, not here.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const page = parsePositivePage(url.searchParams.get('page'));
	const search = url.searchParams.get('q')?.trim() || undefined;
	const includeInactive = url.searchParams.get('includeInactive') === 'true';

	try {
		const result = await listUnits(database(), {
			actorId: locals.user.id,
			page,
			pageSize: DEFAULT_UNIT_PAGE_SIZE,
			search,
			includeInactive
		});
		// `needsPrimaryOccupant` is decided here rather than in the template because it is a rule, not
		// a rendering choice — see the function's own comment in `$lib/server/services/unit`. A
		// component may not import from `$lib/server` at all, so the answer travels as data.
		return {
			...result,
			units: result.units.map((unit) => ({
				...unit,
				needsPrimaryOccupant: needsPrimaryOccupant(unit)
			})),
			search: search ?? '',
			includeInactive
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const block = String(form.get('block') ?? '').trim();
		const number = String(form.get('number') ?? '').trim();
		if (block === '' || number === '') {
			return fail(400, { message: m.adminUnits_invalidForm() });
		}

		try {
			const created = await createUnit(database(), systemClock, {
				actorId: locals.user.id,
				block,
				number
			});
			return {
				message: m.adminUnits_addSuccess({ block: created.block, number: created.number })
			};
		} catch (caught) {
			if (caught instanceof UnitConflictError) {
				return fail(400, {
					message: m.adminUnits_conflict({ block: caught.block, number: caught.number })
				});
			}
			throwAsRouteError(caught);
		}
	}
};

/** A 1-based page number from a query string value, or `undefined` when it does not name one. */
function parsePositivePage(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what an action or a load function returns, exactly as the
 * roles screen's copy of this helper explains.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminUnits_forbidden());
	}
	throw caught;
}
