import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { ACTION, isAllowed, rolesOf } from '#lib/server/authz.ts';
import { PERIOD_STATUS } from '#lib/server/db/schema/period.ts';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	listPeriods,
	PERIOD_RULE,
	periodLabel,
	PeriodRuleError,
	unlockPeriod,
	type PeriodRule
} from '#lib/server/services/cash/period.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen that shows every Periode of the buku kas with its status and the Laporan Bulanan
 * published inside it, and lets a superuser reopen a locked month with a reason.
 *
 * Nobody who is not signed in reaches the service layer, `PermissionDeniedError` becomes
 * `error(403, …)` here and never in the service, and every rule the service refuses comes back as
 * `fail(400, …)` with a sentence the superuser can read. All three go through
 * `#lib/server/route-action.ts` (#318): this file names its sentences and nothing else.
 *
 * This route decides nothing about periods. Which months exist, whether a month with no row is
 * open, and whether this caller may reopen one are all answered in
 * `#lib/server/services/cash/period.ts` and travel here as data — including `mayUnlock`, which only
 * decides whether the button is drawn. `unlockPeriod` refuses an admin on its own, so a hand-posted
 * form gains nothing by the button being absent.
 *
 * The month is posted as two integer fields rather than as a row id. A month that has transactions
 * but no `periods` row yet is on this list with a null id — it is open, so its unlock button is
 * never drawn — and keying the whole surface on `(year, month)` means no screen ever has to invent
 * an id for a row that does not exist.
 *
 * ## There is still no lock button here, and there was never going to be one
 *
 * Locking a Periode is not a thing anybody does on its own: it is what publishing that month's
 * Laporan Bulanan does to it (`docs/spec-kas-laporan-v1.md` user story 13, and the argument recorded
 * on `lockPeriod`). So an open month carries a *link* to `/admin/reports`, where the month is
 * previewed and then published — and publishing is what locks it.
 *
 * `mayPublish` decides whether the link is drawn, and it is read here rather than returned by
 * `listPeriods`: `src/lib/server/services/cash/period.ts` is outside this ticket's surface, and
 * `isAllowed` over the roles this screen already needs answers the question without a second service
 * function. Drawing the link is not authorization — `/admin/reports` refuses with a 403 on its own
 * and `publishReport` refuses again — it only keeps the screen from offering a superuser something
 * the next click would turn down.
 */

/** The form field carrying the year of the month being reopened. */
const YEAR_FIELD = 'year';

/** The form field carrying the month, 1 through 12. */
const MONTH_FIELD = 'month';

/** The form field carrying the alasan, which the audit log records. */
const REASON_FIELD = 'reason';

/**
 * The page's own refusal: the 403 for anyone without `ACTION.readPeriods` who opens the page, and
 * for anyone without `ACTION.unlockPeriods` who posts the unlock form. There is no 404 sentence,
 * because nothing on this screen is addressed by an id.
 */
const PAGE = { forbidden: m.adminPeriods_forbidden } satisfies PageMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db } = productionDependencies();
	const userId = user.id;
	try {
		const [listing, roles] = await Promise.all([listPeriods(db, userId), rolesOf(db, userId)]);
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
			mayUnlock: listing.mayUnlock,
			mayPublish: isAllowed(roles, ACTION.publishReports)
		};
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	unlock: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const rawYear = readText(form, YEAR_FIELD);
		const rawMonth = readText(form, MONTH_FIELD);
		const reason = readText(form, REASON_FIELD);
		if (rawYear === '' || rawMonth === '' || reason === '') {
			return fail(400, { message: m.adminPeriods_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const reopened = await unlockPeriod(db, clock, {
				actorId: user.id,
				// `Number('abc')` is `NaN`, which the service refuses by name as `notACalendarMonth`
				// rather than letting it reach a `where` clause.
				year: Number(rawYear),
				month: Number(rawMonth),
				reason
			});
			return { message: m.adminPeriods_unlockSuccess({ period: periodLabel(reopened) }) };
		} catch (caught) {
			return failOrThrow(caught, {
				...PAGE,
				fallback: m.adminPeriods_invalidForm,
				refusals: [refusal(PeriodRuleError, ({ error }) => ruleMessage(error.rule))]
			});
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
