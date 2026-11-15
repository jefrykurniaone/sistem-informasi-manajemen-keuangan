import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
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
import { PeriodLockedError } from '#lib/server/services/cash/period.ts';
import { UnitNotFoundError } from '#lib/server/services/dues/queries.ts';
import {
	VERIFICATION_RULE,
	VerificationRuleError,
	assertMayVerifyPayments,
	listCashPayableUnits,
	recordCashPayment,
	type VerificationRule
} from '#lib/server/services/dues/verification.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * An admin recording a Pembayaran handed over in cash — `docs/spec-iuran-v1.md` user story 17. The
 * payment is verified the moment it is recorded, through the same service path the queue uses, so
 * this screen's one action does what the queue's "verifikasi" does plus the recording itself.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): the `load` asserts the action
 * before offering the form, a permission refusal becomes `error(403, …)`, and every rule the
 * service refuses comes back as a rejected form with the fields still filled in. A rule this screen
 * does not name is the invalid-form sentence rather than a 500. No invoice picker:
 * a cash deposit's allocation runs by the automatic rule — oldest unpaid first — and the depositor
 * naming specific months is served by the queue's explicit selection when it matters, not by a
 * second picker here.
 */

/** The form field naming the house the money is for. */
const UNIT_FIELD = 'unitId';
/** The form field carrying the amount, as typed. */
const AMOUNT_FIELD = 'amount';
/** The form field carrying the day the money was handed over. */
const RECEIVED_ON_FIELD = 'receivedOn';

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminPayments_forbidden } satisfies PageMessages;

/** What `record` says when the service refuses it, each `fail(400)` with the fields refilled. */
const RECORD_FORM = {
	...PAGE,
	fallback: m.adminPayments_cash_invalidForm,
	refusals: [
		refusal(VerificationRuleError, ({ error }) => ruleMessage(error.rule)),
		refusal(UnitNotFoundError, m.adminPayments_cash_unitNotFound),
		refusal(PeriodLockedError, ({ error }) =>
			m.adminPayments_periodLocked({ period: error.period, date: error.occurredOn })
		)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db } = productionDependencies();
	try {
		await assertMayVerifyPayments(db, user.id);
		const units = await listCashPayableUnits(db, user.id);
		return { units };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	record: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const values = {
			unitId: readText(form, UNIT_FIELD),
			amount: readText(form, AMOUNT_FIELD),
			receivedOn: readText(form, RECEIVED_ON_FIELD)
		};
		if (values.unitId === '' || values.amount === '' || values.receivedOn === '') {
			return fail(400, { message: m.adminPayments_cash_invalidForm(), values });
		}

		const amount = readRupiah(form, AMOUNT_FIELD);
		if (amount === undefined) {
			return fail(400, { message: m.adminPayments_cash_invalidAmount(), values });
		}

		const { db, clock } = productionDependencies();
		try {
			const outcome = await recordCashPayment(db, clock, {
				actorId: user.id,
				unitId: values.unitId,
				amount,
				receivedOn: values.receivedOn
			});
			return {
				message: m.adminPayments_cash_success({ amount: formatRupiah(outcome.payment.amount) })
			};
		} catch (caught) {
			return failOrThrow(caught, RECORD_FORM, { values });
		}
	}
};

/** The sentence an admin reads for each named rule refusal this screen can run into. */
function ruleMessage(rule: VerificationRule): string {
	const messages: Record<VerificationRule, () => string> = {
		[VERIFICATION_RULE.alreadyDecided]: m.adminPayments_rule_alreadyDecided,
		[VERIFICATION_RULE.actorNotRegistered]: m.adminPayments_rule_actorNotRegistered,
		[VERIFICATION_RULE.reasonMissing]: m.adminPayments_rule_reasonMissing,
		[VERIFICATION_RULE.unknownInvoiceSelected]: m.adminPayments_rule_unknownInvoiceSelected,
		[VERIFICATION_RULE.amountNotPositive]: m.adminPayments_rule_amountNotPositive,
		[VERIFICATION_RULE.notACalendarDay]: m.adminPayments_rule_notACalendarDay,
		[VERIFICATION_RULE.receivedInTheFuture]: m.adminPayments_rule_receivedInTheFuture
	};
	return messages[rule]();
}
