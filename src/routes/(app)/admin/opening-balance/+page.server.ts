import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah, parseRupiah, type Rupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	getOpeningBalance,
	OpeningBalanceAlreadyRecordedError,
	recordOpeningBalance
} from '$lib/server/services/cash/opening-balance';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the Saldo awal: the form while none has been recorded, the one row it
 * became once it has. Follows the shape `src/routes/(app)/admin/units/+page.server.ts` settled —
 * nobody who is not signed in reaches the service layer, `PermissionDeniedError` becomes
 * `error(403, …)` here, and the service's own refusals come back as rejected forms.
 *
 * There is deliberately no edit action and no delete action. The cash book is append-only, so a
 * wrong opening balance is corrected with a reversing transaction, not overwritten — see
 * `src/lib/server/services/cash/opening-balance.ts`.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const recorded = await getOpeningBalance(database(), locals.user.id);
		return {
			openingBalance: recorded
				? { amount: recorded.amount, occurredOn: recorded.occurredOn }
				: undefined
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	record: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const rawAmount = String(form.get('amount') ?? '').trim();
		const occurredOn = String(form.get('occurredOn') ?? '').trim();
		if (rawAmount === '' || occurredOn === '') {
			return fail(400, { message: m.adminOpeningBalance_invalidForm() });
		}

		const amount = readAmount(rawAmount);
		if (amount === undefined) {
			return fail(400, { message: m.adminOpeningBalance_invalidAmount() });
		}

		try {
			const recorded = await recordOpeningBalance(database(), systemClock, {
				actorId: locals.user.id,
				amount,
				occurredOn
			});
			return {
				message: m.adminOpeningBalance_recordSuccess({
					amount: formatRupiah(recorded.amount),
					date: recorded.occurredOn
				})
			};
		} catch (caught) {
			if (caught instanceof OpeningBalanceAlreadyRecordedError) {
				return fail(400, { message: m.adminOpeningBalance_alreadyRecorded() });
			}
			if (caught instanceof TypeError || caught instanceof RangeError) {
				return fail(400, { message: m.adminOpeningBalance_invalidAmount() });
			}
			throwAsRouteError(caught);
		}
	}
};

/**
 * The typed money value behind what the form posted, or `undefined` when the text is not a
 * whole-rupiah amount. `parseRupiah` rejects fractions rather than rounding them, which is the
 * whole reason the raw text goes through it instead of through `Number()`.
 */
function readAmount(raw: string): Rupiah | undefined {
	try {
		return parseRupiah(raw);
	} catch {
		return undefined;
	}
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * `never`, so it can end a `catch` block without widening what SvelteKit infers — the same helper
 * the units and invitations screens carry, for the same reason.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminOpeningBalance_forbidden());
	}
	throw caught;
}
