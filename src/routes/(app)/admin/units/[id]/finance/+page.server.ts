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
	requireUuidParam,
	throwRouteError,
	type PageMessages
} from '#lib/server/route-action.ts';
import { PeriodLockedError } from '#lib/server/services/cash/period.ts';
import { CashTransactionAlreadyCorrectedError } from '#lib/server/services/cash/writer.ts';
import {
	correctionsHistoryFor,
	unitFinanceFor
} from '#lib/server/services/dues/corrections-history.ts';
import {
	AllocationNotFoundError,
	InvoiceNotFoundError,
	REFUND_RULE,
	RELEASE_RULE,
	REVERSE_REFUND_RULE,
	RefundNotFoundError,
	RefundRuleError,
	ReleaseRuleError,
	ReverseRefundRuleError,
	VOID_RULE,
	VoidRefusedAllocatedError,
	VoidRuleError,
	refundCredit,
	releaseAllocation,
	reverseRefund,
	voidInvoice,
	type RefundRule,
	type ReleaseRule,
	type ReverseRefundRule,
	type VoidRule
} from '#lib/server/services/dues/dues-correction.ts';
import { isUuid } from '#lib/server/services/identifier.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The unit finance screen: one Unit's saldo titipan, its Tagihan with their Alokasi, its
 * Pengembalian, the history of the superuser's dues corrections, and the four actions themselves
 * (#30's three, and #329's Pembatalan Pengembalian), which all come from the dues-correction module,
 * `#lib/server/services/dues/dues-correction.ts`, with the screen's reads in
 * `corrections-history.ts` beside it.
 *
 * Since #329 the screen goes through the route-action module (`#lib/server/route-action.ts`, #318):
 * `requireUser` is the session guard, `throwRouteError` answers the `load`, and every action's
 * `catch` is one `return failOrThrow(...)` naming the classes that get a sentence of their own. A
 * permission refusal is always a 403, a missing Unit a 404, and a rule refusal nobody named the
 * screen's invalid-form sentence rather than a 500. `CashCorrectionTargetError` is deliberately not
 * named: from the dues-correction module it means the wrong cash line was found, a defect that must
 * reach the log, as `route-action.ts` records.
 *
 * Every action and the `load` are `ACTION.correctDues`'s, superuser's alone: this screen is only
 * useful to whoever may press its buttons, the reasoning
 * `src/lib/server/services/dues/corrections-history.ts` records.
 */

/** The form field naming which Tagihan is being cancelled. */
const INVOICE_ID_FIELD = 'invoiceId';

/** The form field naming which Alokasi is being released. */
const ALLOCATION_ID_FIELD = 'allocationId';

/** The form field naming which Pengembalian is being reversed. */
const REFUND_ID_FIELD = 'refundId';

/** The form field carrying each action's required reason. */
const REASON_FIELD = 'reason';

/** The form field carrying a refund's amount, in whole rupiah. */
const AMOUNT_FIELD = 'amount';

/** The form field carrying the day a refund's money was handed back, as `YYYY-MM-DD`. */
const OCCURRED_ON_FIELD = 'occurredOn';

/** The screen's 403 and 404 sentences. */
const PAGE = {
	forbidden: m.unitFinance_forbidden,
	notFound: m.unitFinance_notFound
} satisfies PageMessages;

/** What every action falls back on for a rule refusal it did not name. */
const FORM = { ...PAGE, fallback: m.unitFinance_invalidForm };

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals);
	// `units.id` is a `uuid` column: see #111 and `#lib/server/services/identifier.ts`.
	const unitId = requireUuidParam(params.id, PAGE);
	const { db, clock } = productionDependencies();

	try {
		const [finance, history] = await Promise.all([
			unitFinanceFor(db, clock, user.id, unitId),
			correctionsHistoryFor(db, user.id, unitId)
		]);
		return { finance, history };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	void: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const invoiceId = readText(form, INVOICE_ID_FIELD);
		const reason = readText(form, REASON_FIELD);
		if (invoiceId === '') {
			return fail(400, { message: m.unitFinance_invalidForm() });
		}
		const { db, clock } = productionDependencies();

		try {
			const voided = await voidInvoice(db, clock, { actorId: user.id, invoiceId, reason });
			return { message: m.voidInvoice_success({ period: voided.period }) };
		} catch (caught) {
			return failOrThrow(caught, {
				...FORM,
				refusals: [
					refusal(VoidRuleError, ({ error }) => voidRuleMessage(error.rule)),
					// The named refusal, sentence included: which Alokasi stand in the way.
					refusal(VoidRefusedAllocatedError, ({ error }) =>
						m.voidInvoice_refusedAllocated({
							allocations: error.allocations
								.map(
									(allocation) =>
										`${formatRupiah(allocation.amount)} (alokasi ${allocation.allocationId})`
								)
								.join(', ')
						})
					),
					refusal(InvoiceNotFoundError, () => m.voidInvoice_notFound())
				]
			});
		}
	},

	release: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const allocationId = readText(form, ALLOCATION_ID_FIELD);
		const reason = readText(form, REASON_FIELD);
		if (allocationId === '') {
			return fail(400, { message: m.unitFinance_invalidForm() });
		}
		const { db, clock } = productionDependencies();

		try {
			const released = await releaseAllocation(db, clock, {
				actorId: user.id,
				allocationId,
				reason
			});
			return { message: m.releaseAllocation_success({ amount: formatRupiah(released.amount) }) };
		} catch (caught) {
			return failOrThrow(caught, {
				...FORM,
				refusals: [
					refusal(ReleaseRuleError, ({ error }) => releaseRuleMessage(error.rule)),
					refusal(AllocationNotFoundError, () => m.releaseAllocation_notFound())
				]
			});
		}
	},

	refund: async ({ request, locals, params }) => {
		const user = requireUser(locals);
		const unitId = requireUuidParam(params.id, PAGE);
		const form = await request.formData();
		const occurredOn = readText(form, OCCURRED_ON_FIELD);
		const reason = readText(form, REASON_FIELD);
		const amount = readRupiah(form, AMOUNT_FIELD);
		if (amount === undefined) {
			return fail(400, { message: m.refund_amountInvalid() });
		}
		const { db, clock } = productionDependencies();

		try {
			const outcome = await refundCredit(db, clock, {
				actorId: user.id,
				unitId,
				amount,
				occurredOn,
				reason
			});
			return {
				message: m.refund_success({ amount: formatRupiah(outcome.amount), date: occurredOn })
			};
		} catch (caught) {
			return failOrThrow(caught, {
				...FORM,
				refusals: [
					refusal(RefundRuleError, ({ error }) => refundRuleMessage(error.rule)),
					refusal(PeriodLockedError, ({ error }) =>
						m.refund_periodLocked({ period: error.period, date: error.occurredOn })
					)
				]
			});
		}
	},

	reverseRefund: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const refundId = readText(form, REFUND_ID_FIELD);
		const reason = readText(form, REASON_FIELD);
		// `refunds.id` is a `uuid` column, and an id of any other shape would reach PostgreSQL as a
		// driver error: the screen only ever posts the ids it rendered.
		if (!isUuid(refundId)) {
			return fail(400, { message: m.unitFinance_invalidForm() });
		}
		const { db, clock } = productionDependencies();

		try {
			const reversed = await reverseRefund(db, clock, { actorId: user.id, refundId, reason });
			return {
				message: m.reverseRefund_success({
					amount: formatRupiah(reversed.refund.amount),
					date: reversed.correction.occurredOn
				})
			};
		} catch (caught) {
			return failOrThrow(caught, {
				...FORM,
				refusals: [
					refusal(ReverseRefundRuleError, ({ error }) => reverseRefundRuleMessage(error.rule)),
					refusal(RefundNotFoundError, () => m.reverseRefund_notFound()),
					refusal(PeriodLockedError, ({ error }) =>
						m.reverseRefund_periodLocked({ period: error.period, date: error.occurredOn })
					),
					// The writer's own backstop for "reversed once", reached only by a Koreksi that some
					// writer put on the line without the payment lock `reverseRefund` reads under. The
					// same answer as the named rule, because it is the same fact.
					refusal(CashTransactionAlreadyCorrectedError, () =>
						m.reverseRefund_rule_alreadyReversed()
					)
				]
			});
		}
	}
};

/** The sentence a superuser reads for each named void rule refusal. */
function voidRuleMessage(rule: VoidRule): string {
	const messages: Record<VoidRule, () => string> = {
		[VOID_RULE.reasonMissing]: m.voidInvoice_rule_reasonMissing,
		[VOID_RULE.alreadyVoided]: m.voidInvoice_rule_alreadyVoided,
		[VOID_RULE.actorNotRegistered]: m.voidInvoice_rule_actorNotRegistered
	};
	return messages[rule]();
}

/** The sentence a superuser reads for each named release rule refusal. */
function releaseRuleMessage(rule: ReleaseRule): string {
	const messages: Record<ReleaseRule, () => string> = {
		[RELEASE_RULE.reasonMissing]: m.releaseAllocation_rule_reasonMissing
	};
	return messages[rule]();
}

/** The sentence a superuser reads for each named refund rule refusal. */
function refundRuleMessage(rule: RefundRule): string {
	const messages: Record<RefundRule, () => string> = {
		[REFUND_RULE.amountNotPositive]: m.refund_rule_amountNotPositive,
		[REFUND_RULE.notACalendarDay]: m.refund_rule_notACalendarDay,
		[REFUND_RULE.dayInTheFuture]: m.refund_rule_dayInTheFuture,
		[REFUND_RULE.reasonMissing]: m.refund_rule_reasonMissing,
		[REFUND_RULE.amountAboveBalance]: m.refund_rule_amountAboveBalance
	};
	return messages[rule]();
}

/** The sentence a superuser reads for each named Pembatalan Pengembalian rule refusal. */
function reverseRefundRuleMessage(rule: ReverseRefundRule): string {
	const messages: Record<ReverseRefundRule, () => string> = {
		[REVERSE_REFUND_RULE.reasonMissing]: m.reverseRefund_rule_reasonMissing,
		[REVERSE_REFUND_RULE.alreadyReversed]: m.reverseRefund_rule_alreadyReversed
	};
	return messages[rule]();
}
