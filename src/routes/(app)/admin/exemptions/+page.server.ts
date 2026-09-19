import { error, fail, redirect, type ActionFailure } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import {
	endExemption,
	ExemptionActorNotRegisteredError,
	ExemptionDateOrderError,
	ExemptionNotFoundError,
	ExemptionOverlapError,
	grantExemption,
	listActiveExemptions
} from '$lib/server/services/dues/exemption';
import { systemClock } from '$lib/server/ports/clock';
import { listUnits, UnitNotFoundError } from '$lib/server/services/unit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Pembebasan: every unit currently exempt, and the forms that grant a new
 * exemption or end one that is running. Follows the shape
 * `src/routes/(app)/admin/dues-rates/+page.server.ts` settled — nobody who is not signed in reaches
 * the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the service,
 * and every rule the service refuses comes back as `fail(400, …)` with a message the superuser can
 * read.
 *
 * This route decides nothing about exemptions. Which units are exempt today, and whether a period
 * overlaps one that already exists, are both answered in `$lib/server/services/dues/exemption` and
 * travel here as data.
 *
 * The picker for "which unit" is every active unit, fetched with a page size large enough to be the
 * whole house register in one request. A residential complex the size this application targets
 * never has enough units to make that expensive, and a paged picker would be a second kind of
 * pagination control on a screen that already has none.
 */

const UNIT_PICKER_PAGE_SIZE = 1000;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const [activeExemptions, unitsPage] = await Promise.all([
			listActiveExemptions(database(), systemClock, locals.user.id),
			listUnits(database(), systemClock, {
				actorId: locals.user.id,
				pageSize: UNIT_PICKER_PAGE_SIZE
			})
		]);
		return {
			exemptions: activeExemptions,
			units: unitsPage.units.map((unit) => ({
				id: unit.id,
				block: unit.block,
				number: unit.number
			}))
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	grant: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const input = readGrantInput(await request.formData());
		if (!input) {
			return fail(400, { message: m.adminExemptions_invalidForm() });
		}

		try {
			const granted = await grantExemption(database(), systemClock, {
				actorId: locals.user.id,
				unitId: input.unitId,
				startedOn: input.startedOn,
				endedOn: input.endedOn,
				reason: input.reason
			});
			return { message: m.adminExemptions_grantSuccess({ date: granted.startedOn }) };
		} catch (caught) {
			return failFromServiceError(caught);
		}
	},

	end: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const exemptionId = String(form.get('exemptionId') ?? '').trim();
		const endedOn = String(form.get('endedOn') ?? '').trim();
		if (exemptionId === '' || endedOn === '') {
			return fail(400, { message: m.adminExemptions_invalidForm() });
		}

		try {
			const ended = await endExemption(database(), systemClock, {
				actorId: locals.user.id,
				exemptionId,
				endedOn
			});
			return { message: m.adminExemptions_endSuccess({ date: ended.endedOn ?? endedOn }) };
		} catch (caught) {
			return failFromServiceError(caught);
		}
	}
};

/** The fields the grant form submits, once known to be well formed. */
interface GrantInput {
	readonly unitId: string;
	readonly startedOn: string;
	readonly endedOn: string | null;
	readonly reason: string;
}

/** The grant form's fields off a submission, or `undefined` when the required ones are missing. */
function readGrantInput(form: FormData): GrantInput | undefined {
	const unitId = String(form.get('unitId') ?? '').trim();
	const startedOn = String(form.get('startedOn') ?? '').trim();
	const endedOnRaw = String(form.get('endedOn') ?? '').trim();
	const reason = String(form.get('reason') ?? '').trim();

	if (unitId === '' || startedOn === '' || reason === '') {
		return undefined;
	}
	return { unitId, startedOn, endedOn: endedOnRaw === '' ? null : endedOnRaw, reason };
}

/**
 * Turns a refusal from the exemption service into a rejected submission, or rethrows whatever else
 * it was.
 *
 * Every case here is something the superuser was entitled to try and the rules said no to, which is
 * a `fail(400, …)` rather than a 403 — the same split `src/routes/(app)/admin/dues-rates/+page.server.ts`
 * follows.
 */
function failFromServiceError(caught: unknown): ActionFailure<{ message: string }> {
	if (caught instanceof ExemptionOverlapError) {
		return fail(
			400,
			caught.endedOn === null
				? { message: m.adminExemptions_overlapOpen({ startedOn: caught.startedOn }) }
				: {
						message: m.adminExemptions_overlapScheduled({
							startedOn: caught.startedOn,
							endedOn: caught.endedOn
						})
					}
		);
	}
	if (caught instanceof ExemptionDateOrderError) {
		return fail(400, {
			message: m.adminExemptions_dateOrder({
				startedOn: caught.startedOn,
				endedOn: caught.endedOn
			})
		});
	}
	if (caught instanceof ExemptionActorNotRegisteredError) {
		return fail(400, { message: m.adminExemptions_actorNotRegistered() });
	}
	if (caught instanceof ExemptionNotFoundError) {
		return fail(400, { message: m.adminExemptions_notFound() });
	}
	// The unit named by a stale picker option — deactivated or removed between this page's load and
	// this submission. A rejected form, not a 404: nothing about the request itself was malformed.
	if (caught instanceof UnitNotFoundError) {
		return fail(400, { message: m.adminExemptions_unitNotFound() });
	}
	if (caught instanceof TypeError) {
		return fail(400, { message: m.adminExemptions_invalidForm() });
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what an action or a load function returns, exactly as the
 * Tarif screen's copy of this helper explains.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminExemptions_forbidden());
	}
	throw caught;
}
