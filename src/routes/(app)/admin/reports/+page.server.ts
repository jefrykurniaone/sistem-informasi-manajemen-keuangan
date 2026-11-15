import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import { CASH_BOOK_MONTH_PATTERN } from '#lib/server/services/cash/balance.ts';
import { PERIOD_RULE, PeriodRuleError, type PeriodRule } from '#lib/server/services/cash/period.ts';
import {
	publishReport,
	reportWorkbench,
	REPORT_RULE,
	ReportRuleError,
	type ReportRule
} from '#lib/server/services/report/publication.ts';
import { presentBreakdown } from '#lib/server/services/report/resident-payload.ts';
import { formatMonthLabel } from '#lib/time.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen an admin previews a Laporan Bulanan on and publishes it from — user stories 12 and 13,
 * which are one screen because a preview is only useful to whoever may press the button under it.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and every rule the service refuses comes back as `fail(400, …)` with a sentence an admin
 * can read. A rule this screen does not name is the invalid-form sentence rather than a 500.
 *
 * This route decides nothing. Which month is previewed, whether it is locked, which revision would
 * be next and whether that revision needs an alasan are all answered by `reportWorkbench`, and the
 * publication itself is one service call. In particular the screen hiding the publish form on a
 * locked month is **not** what stops a second publication: `lockPeriod` inside `publishReport`
 * refuses it whoever posts the form.
 *
 * The month lives in the query string — `?period=YYYY-MM` — so a preview is an address an admin can
 * keep and reload, the same reasoning `(app)/admin/cash/+page.server.ts` gives for its filters. An
 * unrecognisable month is dropped rather than refused, and the current month is previewed instead.
 */

/** The query parameter carrying which month to preview. */
const PERIOD_PARAMETER = 'period';

/** The form field carrying the month being published. */
const PERIOD_FIELD = 'period';

/** The form field carrying the alasan revisi, which every warga is shown. */
const REASON_FIELD = 'revisionReason';

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminReports_forbidden } satisfies PageMessages;

/** What `publish` says when the publication is refused, each `fail(400)`. */
const PUBLISH_FORM = {
	...PAGE,
	fallback: m.adminReports_invalidForm,
	refusals: [
		refusal(ReportRuleError, ({ error }) => reportRuleMessage(error.rule)),
		refusal(PeriodRuleError, ({ error }) => periodRuleMessage(error.rule))
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals);

	const { db, clock } = productionDependencies();
	try {
		const workbench = await reportWorkbench(db, clock, user.id, periodFrom(url));
		// Arranged through the same function the published report uses, so that a preview cannot show
		// a different grouping of the same numbers than the page a warga opens afterwards — including
		// which line is the iuran category and is therefore never broken down.
		const breakdown = await presentBreakdown(db, workbench.figures.categoryBreakdown);
		// The preview heading names the month, not the raw `YYYY-MM`, in whichever language is
		// active — `formatMonthLabel` is the same formatter the Beranda uses (`#lib/time.ts`).
		const month = formatMonthLabel(workbench.period, getLocale());
		return { ...workbench, ...breakdown, month };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	publish: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const period = readText(form, PERIOD_FIELD);
		const revisionReason = readText(form, REASON_FIELD);
		if (!CASH_BOOK_MONTH_PATTERN.test(period)) {
			return fail(400, { message: m.adminReports_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const report = await publishReport(db, clock, {
				actorId: user.id,
				period,
				revisionReason
			});
			return {
				message: m.adminReports_publishSuccess({ period, revision: report.revision })
			};
		} catch (caught) {
			return failOrThrow(caught, PUBLISH_FORM);
		}
	}
};

/** The month this request asks to preview, or `undefined` for the one the complex is in now. */
function periodFrom(url: URL): string | undefined {
	const period = url.searchParams.get(PERIOD_PARAMETER) ?? '';
	return CASH_BOOK_MONTH_PATTERN.test(period) ? period : undefined;
}

/**
 * The sentence an admin reads for each named publication refusal.
 *
 * An exhaustive `Record`, the shape `(app)/admin/periods/+page.server.ts` uses for `PERIOD_RULE`: a
 * rule added to `REPORT_RULE` later is a type error here until somebody writes its message.
 */
function reportRuleMessage(rule: ReportRule): string {
	const messages: Record<ReportRule, () => string> = {
		[REPORT_RULE.revisionReasonMissing]: m.adminReports_rule_revisionReasonMissing,
		[REPORT_RULE.revisionReasonNotAllowed]: m.adminReports_rule_revisionReasonNotAllowed
	};
	return messages[rule]();
}

/**
 * The sentence an admin reads when locking the month refuses the publication.
 *
 * `alreadyLocked` is the one that really happens here, and it is the whole flow of a revision: a
 * month stays locked until a superuser reopens it, so publishing a second time without that is
 * refused by name rather than by overwriting what warga have read. The other three are written out
 * because that is what makes the map exhaustive rather than merely complete today — the same
 * reasoning the period screen records for its own unreachable member.
 */
function periodRuleMessage(rule: PeriodRule): string {
	const messages: Record<PeriodRule, () => string> = {
		[PERIOD_RULE.notACalendarMonth]: m.adminReports_periodRule_notACalendarMonth,
		[PERIOD_RULE.reasonMissing]: m.adminReports_periodRule_reasonMissing,
		[PERIOD_RULE.alreadyOpen]: m.adminReports_periodRule_alreadyOpen,
		[PERIOD_RULE.alreadyLocked]: m.adminReports_periodRule_alreadyLocked
	};
	return messages[rule]();
}
