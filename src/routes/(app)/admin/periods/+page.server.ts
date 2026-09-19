import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { PERIOD_STATUS } from '$lib/server/db/schema/period';
import { systemClock } from '$lib/server/ports/clock';
import {
	listPeriods,
	PERIOD_RULE,
	periodLabel,
	PeriodRuleError,
	unlockPeriod,
	type PeriodRule
} from '$lib/server/services/cash/period';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen that shows every Periode of the buku kas with its status and the Laporan Bulanan
 * published inside it, and lets a superuser reopen a locked month with a reason.
 *
 * Follows the shape `src/routes/(app)/admin/exemptions/+page.server.ts` settled: nobody who is not
 * signed in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and
 * never in the service, and every rule the service refuses comes back as `fail(400, …)` with a
 * sentence the superuser can read.
 *
 * This route decides nothing about periods. Which months exist, whether a month with no row is
 * open, and whether this caller may reopen one are all answered in
 * `$lib/server/services/cash/period` and travel here as data — including `mayUnlock`, which only
 * decides whether the button is drawn. `unlockPeriod` refuses an admin on its own, so a hand-posted
 * form gains nothing by the button being absent.
 *
 * The month is posted as two integer fields rather than as a row id. A month that has transactions
 * but no `periods` row yet is on this list with a null id — it is open, so its unlock button is
 * never drawn — and keying the whole surface on `(year, month)` means no screen ever has to invent
 * an id for a row that does not exist.
 */

/** The form field carrying the year of the month being reopened. */
const YEAR_FIELD = 'year';

/** The form field carrying the month, 1 through 12. */
const MONTH_FIELD = 'month';

/** The form field carrying the alasan, which the audit log records. */
const REASON_FIELD = 'reason';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const listing = await listPeriods(database(), locals.user.id);
		return {
			// `status` and the row's id are turned into the two booleans the screen actually asks —
			// "is it locked" and "does the row exist yet" — here rather than in the component.
			// `PERIOD_STATUS` lives under `src/lib/server/`, which a `.svelte` file may not import, and
			// comparing against a hand-written `'locked'` in the markup would be the schema's vocabulary
			// spelled out a second time somewhere nothing checks it.
			periods: listing.periods.map((summary) => ({
				year: summary.year,
				month: summary.month,
				period: summary.period,
				isLocked: summary.status === PERIOD_STATUS.locked,
				hasRow: summary.id !== null,
				transactionCount: summary.transactionCount,
				reports: summary.reports
			})),
			mayUnlock: listing.mayUnlock
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	unlock: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const rawYear = String(form.get(YEAR_FIELD) ?? '').trim();
		const rawMonth = String(form.get(MONTH_FIELD) ?? '').trim();
		const reason = String(form.get(REASON_FIELD) ?? '').trim();
		if (rawYear === '' || rawMonth === '' || reason === '') {
			return fail(400, { message: m.adminPeriods_invalidForm() });
		}

		try {
			const reopened = await unlockPeriod(database(), systemClock, {
				actorId: locals.user.id,
				// `Number('abc')` is `NaN`, which the service refuses by name as `notACalendarMonth`
				// rather than letting it reach a `where` clause.
				year: Number(rawYear),
				month: Number(rawMonth),
				reason
			});
			return { message: m.adminPeriods_unlockSuccess({ period: periodLabel(reopened) }) };
		} catch (caught) {
			if (caught instanceof PeriodRuleError) {
				return fail(400, { message: ruleMessage(caught.rule) });
			}
			throwAsRouteError(caught);
		}
	}
};

/**
 * The sentence a person reads for each named rule refusal.
 *
 * An exhaustive `Record`, the shape `(app)/admin/cash/new/+page.server.ts` uses for `CASH_RULE`: a
 * rule added to `PERIOD_RULE` later is a type error here until somebody writes its message.
 * `alreadyLocked` cannot be reached from this screen, which offers no lock button — locking a month
 * is what publishing its Laporan Bulanan does — and it is written out all the same, because that is
 * what makes the map exhaustive rather than merely complete today.
 */
function ruleMessage(rule: PeriodRule): string {
	const messages: Record<PeriodRule, () => string> = {
		[PERIOD_RULE.notACalendarMonth]: m.adminPeriods_rule_notACalendarMonth,
		[PERIOD_RULE.reasonMissing]: m.adminPeriods_rule_reasonMissing,
		[PERIOD_RULE.alreadyOpen]: m.adminPeriods_rule_alreadyOpen,
		[PERIOD_RULE.alreadyLocked]: m.adminPeriods_rule_alreadyLocked
	};
	return messages[rule]();
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` so that this can sit in a `catch` block without
 * widening the type SvelteKit infers, the same helper every other admin screen carries.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminPeriods_forbidden());
	}
	throw caught;
}
