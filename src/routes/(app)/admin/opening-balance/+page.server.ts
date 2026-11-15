import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { formatRupiah } from '#lib/money.ts';
import {
	failOrThrow,
	productionDependencies,
	readRupiah,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	getOpeningBalance,
	OpeningBalanceAfterEarliestCashTransactionError,
	OpeningBalanceAlreadyRecordedError,
	recordOpeningBalance
} from '#lib/server/services/cash/opening-balance.ts';
import { PeriodLockedError } from '#lib/server/services/cash/period.ts';
import { formatDay, formatMonthLabel } from '#lib/time.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for the Saldo awal: the opening balance in force, or the form while there is
 * none, either because none was recorded or because a Koreksi reversed the one that was. Follows
 * the shape `src/lib/server/route-action.ts` settled (#318) — nobody who is not signed in reaches
 * the service layer, `PermissionDeniedError` becomes `error(403, …)` here, and the service's own
 * refusals come back as rejected forms. A rule this screen does not name is the invalid-form
 * sentence rather than a 500.
 *
 * There is deliberately no edit action and no delete action. The cash book is append-only, so a
 * wrong opening balance is corrected with a reversing transaction, not overwritten — see
 * `src/lib/server/services/cash/opening-balance.ts`.
 */

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminOpeningBalance_forbidden } satisfies PageMessages;

/**
 * What `record` says when the service refuses it, each `fail(400)`. A `TypeError` or `RangeError`
 * from the service's own money checks reads as the invalid-amount sentence.
 */
const RECORD_FORM = {
	...PAGE,
	fallback: m.adminOpeningBalance_invalidForm,
	refusals: [
		refusal(OpeningBalanceAlreadyRecordedError, m.adminOpeningBalance_alreadyRecorded),
		refusal(OpeningBalanceAfterEarliestCashTransactionError, ({ error }) =>
			m.adminOpeningBalance_afterEarliestTransaction({ date: asDay(error.earliestOccurredOn) })
		),
		refusal(PeriodLockedError, ({ error }) =>
			m.adminOpeningBalance_periodLocked({
				period: formatMonthLabel(error.period, getLocale()),
				date: asDay(error.occurredOn)
			})
		),
		refusal(TypeError, m.adminOpeningBalance_invalidAmount),
		refusal(RangeError, m.adminOpeningBalance_invalidAmount)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db } = productionDependencies();
	try {
		const recorded = await getOpeningBalance(db, user.id);
		return {
			openingBalance: recorded
				? { amount: recorded.amount, occurredOn: recorded.occurredOn }
				: undefined
		};
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	record: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const rawAmount = readText(form, 'amount');
		const occurredOn = readText(form, 'occurredOn');
		if (rawAmount === '' || occurredOn === '') {
			return fail(400, { message: m.adminOpeningBalance_invalidForm() });
		}

		const amount = readRupiah(form, 'amount');
		if (amount === undefined) {
			return fail(400, { message: m.adminOpeningBalance_invalidAmount() });
		}

		const { db, clock } = productionDependencies();
		try {
			const recorded = await recordOpeningBalance(db, clock, {
				actorId: user.id,
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
			return failOrThrow(caught, RECORD_FORM);
		}
	}
};

/** A stored `YYYY-MM-DD` as a day a person reads, the way the page itself shows one. */
function asDay(day: string): string {
	return formatDay(new Date(`${day}T00:00:00.000Z`));
}
