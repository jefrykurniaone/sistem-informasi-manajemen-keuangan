import { error, fail, redirect, type ActionFailure } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah, parseRupiah, type Rupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	createDuesRate,
	deleteDuesRate,
	DuesRateConflictError,
	DuesRateInUseError,
	DuesRateNotFoundError,
	listDuesRates,
	updateDuesRate
} from '$lib/server/services/dues/rate';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the Tarif: the whole history, and the forms that set, change and remove
 * one. Follows the shape `src/routes/(app)/admin/units/+page.server.ts` settled — nobody who is not
 * signed in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and
 * never in the service, and every rule the service refuses comes back as `fail(400, …)` with a
 * message the superuser can read.
 *
 * This route decides nothing about rates. Which one is in force, which one may still be changed, and
 * what "already used to bill" means are all answered in `$lib/server/services/dues/rate` and travel
 * here as data.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		return await listDuesRates(database(), systemClock, locals.user.id);
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const input = readRateInput(await request.formData());
		if (!input) {
			return fail(400, { message: m.adminDuesRates_invalidForm() });
		}

		try {
			const created = await createDuesRate(database(), systemClock, {
				actorId: locals.user.id,
				amount: input.amount,
				effectiveFrom: input.effectiveFrom
			});
			return {
				message: m.adminDuesRates_setSuccess({
					amount: formatRupiah(created.amount),
					date: created.effectiveFrom
				})
			};
		} catch (caught) {
			// Refused here, a rate in use is never the rate being written — it is the existing one whose
			// already-billed Periode this new rate would take over, so it needs its own wording.
			if (caught instanceof DuesRateInUseError) {
				return fail(400, {
					message: m.adminDuesRates_wouldClaimBilled({
						date: input.effectiveFrom,
						period: caught.usedSincePeriod
					})
				});
			}
			return failFromServiceError(caught);
		}
	},

	update: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const duesRateId = String(form.get('duesRateId') ?? '').trim();
		const input = readRateInput(form);
		if (!input || duesRateId === '') {
			return fail(400, { message: m.adminDuesRates_invalidForm() });
		}

		try {
			const updated = await updateDuesRate(database(), systemClock, {
				actorId: locals.user.id,
				duesRateId,
				amount: input.amount,
				effectiveFrom: input.effectiveFrom
			});
			return {
				message: m.adminDuesRates_editSuccess({
					amount: formatRupiah(updated.amount),
					date: updated.effectiveFrom
				})
			};
		} catch (caught) {
			return failFromServiceError(caught);
		}
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const duesRateId = String(form.get('duesRateId') ?? '').trim();
		if (duesRateId === '') {
			return fail(400, { message: m.adminDuesRates_invalidForm() });
		}

		try {
			const removed = await deleteDuesRate(database(), systemClock, {
				actorId: locals.user.id,
				duesRateId
			});
			return { message: m.adminDuesRates_deleteSuccess({ date: removed.effectiveFrom }) };
		} catch (caught) {
			return failFromServiceError(caught);
		}
	}
};

/** The two fields the create and update forms share, once they are known to be well formed. */
interface RateInput {
	readonly amount: Rupiah;
	readonly effectiveFrom: string;
}

/**
 * The amount and the start date off a submitted form, or `undefined` when either is missing or not a
 * shape the domain accepts.
 *
 * `parseRupiah` is the only way a form value becomes money — it refuses fractions rather than
 * rounding them, which is why its `TypeError` is caught here and reported as an invalid form instead
 * of reaching the service. A negative amount parses fine and is refused here for the same reason: it
 * is a typo in a form, not an exceptional condition.
 */
function readRateInput(form: FormData): RateInput | undefined {
	const effectiveFrom = String(form.get('effectiveFrom') ?? '').trim();
	const rawAmount = String(form.get('amount') ?? '').trim();
	if (effectiveFrom === '' || rawAmount === '') {
		return undefined;
	}

	let amount: Rupiah;
	try {
		amount = parseRupiah(rawAmount);
	} catch {
		return undefined;
	}

	if (amount < 0) {
		return undefined;
	}
	return { amount, effectiveFrom };
}

/**
 * Turns a refusal from the rate service into a rejected submission, or rethrows whatever else it
 * was.
 *
 * Every case here is something the superuser was entitled to try and the rules said no to, which is
 * a `fail(400, …)` rather than a 403 — the same split `LastSuperuserError` records in
 * `src/lib/errors.ts`.
 */
function failFromServiceError(caught: unknown): ActionFailure<{ message: string }> {
	if (caught instanceof DuesRateConflictError) {
		return fail(400, { message: m.adminDuesRates_conflict({ date: caught.effectiveFrom }) });
	}
	if (caught instanceof DuesRateInUseError) {
		return fail(400, { message: m.adminDuesRates_inUse({ period: caught.usedSincePeriod }) });
	}
	if (caught instanceof DuesRateNotFoundError) {
		return fail(400, { message: m.adminDuesRates_notFound() });
	}
	if (caught instanceof TypeError) {
		return fail(400, { message: m.adminDuesRates_invalidForm() });
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 *
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers for what an action or a load function returns, exactly as the
 * unit screen's copy of this helper explains.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminDuesRates_forbidden());
	}
	throw caught;
}
