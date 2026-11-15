import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import {
	failOrThrow,
	productionDependencies,
	readOptionalText,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	endExemption,
	ExemptionActorNotRegisteredError,
	ExemptionDateOrderError,
	ExemptionNotFoundError,
	ExemptionOverlapError,
	grantExemption,
	listActiveExemptions
} from '#lib/server/services/dues/exemption.ts';
import { listUnits, UnitNotFoundError } from '#lib/server/services/unit/index.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Pembebasan: every unit currently exempt, and the forms that grant a new
 * exemption or end one that is running. Follows the shape `src/lib/server/route-action.ts` settled
 * (#318) — nobody who is not signed in reaches the service layer, `PermissionDeniedError` becomes
 * `error(403, …)` here and never in the service, and every rule the service refuses comes back as
 * `fail(400, …)` with a message the superuser can read. A rule this screen does not name is the
 * invalid-form sentence rather than a 500.
 *
 * This route decides nothing about exemptions. Which units are exempt today, and whether a period
 * overlaps one that already exists, are both answered in `#lib/server/services/dues/exemption.ts` and
 * travel here as data.
 *
 * The picker for "which unit" is every active unit, fetched with a page size large enough to be the
 * whole house register in one request. A residential complex the size this application targets
 * never has enough units to make that expensive, and a paged picker would be a second kind of
 * pagination control on a screen that already has none.
 */

const UNIT_PICKER_PAGE_SIZE = 1000;

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminExemptions_forbidden } satisfies PageMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db, clock } = productionDependencies();
	try {
		const [activeExemptions, unitsPage] = await Promise.all([
			listActiveExemptions(db, clock, user.id),
			listUnits(db, clock, {
				actorId: user.id,
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
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	grant: async ({ request, locals }) => {
		const user = requireUser(locals);

		const input = readGrantInput(await request.formData());
		if (!input) {
			return fail(400, { message: m.adminExemptions_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const granted = await grantExemption(db, clock, {
				actorId: user.id,
				unitId: input.unitId,
				startedOn: input.startedOn,
				endedOn: input.endedOn,
				reason: input.reason
			});
			return { message: m.adminExemptions_grantSuccess({ date: granted.startedOn }) };
		} catch (caught) {
			return failOrThrow(caught, exemptionForm('grant'));
		}
	},

	end: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const exemptionId = readText(form, 'exemptionId');
		const endedOn = readText(form, 'endedOn');
		if (exemptionId === '' || endedOn === '') {
			return fail(400, { message: m.adminExemptions_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const ended = await endExemption(db, clock, {
				actorId: user.id,
				exemptionId,
				endedOn
			});
			return { message: m.adminExemptions_endSuccess({ date: ended.endedOn ?? endedOn }) };
		} catch (caught) {
			return failOrThrow(caught, exemptionForm('end'));
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
	const unitId = readText(form, 'unitId');
	const startedOn = readText(form, 'startedOn');
	const endedOn = readOptionalText(form, 'endedOn');
	const reason = readText(form, 'reason');

	if (unitId === '' || startedOn === '' || reason === '') {
		return undefined;
	}
	return { unitId, startedOn, endedOn, reason };
}

/**
 * What the exemption service's refusals read as on a rejected submission.
 *
 * Every case here is something the superuser was entitled to try and the rules said no to, which is
 * a `fail(400, …)` rather than a 403 — the same split `src/routes/(app)/admin/dues-rates/+page.server.ts`
 * follows.
 *
 * `context` picks the wording for `ExemptionOverlapError`: `grantExemption` and `endExemption` both
 * throw it, but "the period you asked to grant overlaps" and "the later end date you asked for would
 * overlap" are different sentences to read on a rejected form, so `end` gets its own message key.
 *
 * `UnitNotFoundError` is the unit named by a stale picker option — deactivated or removed between
 * this page's load and this submission. A rejected form, not a 404: nothing about the request itself
 * was malformed. A `TypeError` from the service's own input checks reads as the invalid-form
 * sentence.
 */
function exemptionForm(context: 'grant' | 'end'): FormMessages {
	return {
		...PAGE,
		fallback: m.adminExemptions_invalidForm,
		refusals: [
			refusal(ExemptionOverlapError, ({ error }) => overlapMessage(error, context)),
			refusal(ExemptionDateOrderError, ({ error }) =>
				m.adminExemptions_dateOrder({ startedOn: error.startedOn, endedOn: error.endedOn })
			),
			refusal(ExemptionActorNotRegisteredError, m.adminExemptions_actorNotRegistered),
			refusal(ExemptionNotFoundError, m.adminExemptions_notFound),
			refusal(UnitNotFoundError, m.adminExemptions_unitNotFound),
			refusal(TypeError, m.adminExemptions_invalidForm)
		]
	};
}

/** The message for `ExemptionOverlapError`, worded for whichever action threw it. */
function overlapMessage(caught: ExemptionOverlapError, context: 'grant' | 'end'): string {
	if (context === 'end') {
		return caught.endedOn === null
			? m.adminExemptions_endOverlapOpen({ startedOn: caught.startedOn })
			: m.adminExemptions_endOverlapScheduled({
					startedOn: caught.startedOn,
					endedOn: caught.endedOn
				});
	}
	return caught.endedOn === null
		? m.adminExemptions_overlapOpen({ startedOn: caught.startedOn })
		: m.adminExemptions_overlapScheduled({ startedOn: caught.startedOn, endedOn: caught.endedOn });
}
