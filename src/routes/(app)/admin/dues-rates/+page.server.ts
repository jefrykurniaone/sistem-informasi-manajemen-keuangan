import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { formatRupiah, type Rupiah } from '#lib/money.ts';
import {
	failOrThrow,
	productionDependencies,
	readRupiah,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages,
	type Refusal
} from '#lib/server/route-action.ts';
import {
	createDuesRate,
	deleteDuesRate,
	DuesRateConflictError,
	DuesRateInUseError,
	DuesRateNotFoundError,
	listDuesRates,
	updateDuesRate
} from '#lib/server/services/dues/rate.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the Tarif: the whole history, and the forms that set, change and remove
 * one. Follows the shape `src/lib/server/route-action.ts` settled (#318) — nobody who is not signed
 * in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in
 * the service, and every rule the service refuses comes back as `fail(400, …)` with a message the
 * superuser can read. A rule this screen does not name is the invalid-form sentence rather than a
 * 500.
 *
 * Every refusal here is something the superuser was entitled to try and the rules said no to, which
 * is a `fail(400, …)` rather than a 403 — the same split `LastSuperuserError` records in
 * `src/lib/errors.ts`. A `TypeError` from the service's own input checks is named too, and reads as
 * the invalid-form sentence.
 *
 * This route decides nothing about rates. Which one is in force, which one may still be changed, and
 * what "already used to bill" means are all answered in `#lib/server/services/dues/rate.ts` and travel
 * here as data.
 */

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminDuesRates_forbidden } satisfies PageMessages;

/** The refusals every action shares, after whichever `DuesRateInUseError` wording it picked. */
const SHARED_REFUSALS = [
	refusal(DuesRateConflictError, ({ error }) =>
		m.adminDuesRates_conflict({ date: error.effectiveFrom })
	),
	refusal(DuesRateNotFoundError, m.adminDuesRates_notFound),
	refusal(TypeError, m.adminDuesRates_invalidForm)
];

/** What `update` and `delete` say: a rate in use there is the rate being changed. */
const RATE_FORM = {
	...PAGE,
	fallback: m.adminDuesRates_invalidForm,
	refusals: [
		refusal(DuesRateInUseError, ({ error }) =>
			m.adminDuesRates_inUse({ period: error.usedSincePeriod })
		),
		...SHARED_REFUSALS
	]
} satisfies FormMessages;

/**
 * What `create` says. Refused here, a rate in use is never the rate being written — it is the
 * existing one whose already-billed Periode this new rate would take over, so it needs its own
 * wording, which names the day the new rate was asked to start.
 */
function createForm(effectiveFrom: string): FormMessages {
	const wouldClaimBilled: Refusal = refusal(DuesRateInUseError, ({ error }) =>
		m.adminDuesRates_wouldClaimBilled({ date: effectiveFrom, period: error.usedSincePeriod })
	);
	return {
		...PAGE,
		fallback: m.adminDuesRates_invalidForm,
		refusals: [wouldClaimBilled, ...SHARED_REFUSALS]
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db, clock } = productionDependencies();
	try {
		return await listDuesRates(db, clock, user.id);
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);

		const input = readRateInput(await request.formData());
		if (!input) {
			return fail(400, { message: m.adminDuesRates_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const created = await createDuesRate(db, clock, {
				actorId: user.id,
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
			return failOrThrow(caught, createForm(input.effectiveFrom));
		}
	},

	update: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const duesRateId = readText(form, 'duesRateId');
		const input = readRateInput(form);
		if (!input || duesRateId === '') {
			return fail(400, { message: m.adminDuesRates_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const updated = await updateDuesRate(db, clock, {
				actorId: user.id,
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
			return failOrThrow(caught, RATE_FORM);
		}
	},

	delete: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const duesRateId = readText(form, 'duesRateId');
		if (duesRateId === '') {
			return fail(400, { message: m.adminDuesRates_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const removed = await deleteDuesRate(db, clock, {
				actorId: user.id,
				duesRateId
			});
			return { message: m.adminDuesRates_deleteSuccess({ date: removed.effectiveFrom }) };
		} catch (caught) {
			return failOrThrow(caught, RATE_FORM);
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
 * `readRupiah` is the only way a form value becomes money — it refuses fractions rather than
 * rounding them, and an empty or malformed amount comes back `undefined`, reported as an invalid
 * form instead of reaching the service. A negative amount parses fine and is refused here for the
 * same reason: it is a typo in a form, not an exceptional condition.
 */
function readRateInput(form: FormData): RateInput | undefined {
	const effectiveFrom = readText(form, 'effectiveFrom');
	const amount = readRupiah(form, 'amount');
	if (effectiveFrom === '' || amount === undefined || amount < 0) {
		return undefined;
	}
	return { amount, effectiveFrom };
}
