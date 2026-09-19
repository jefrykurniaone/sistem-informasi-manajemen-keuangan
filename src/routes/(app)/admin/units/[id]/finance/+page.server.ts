import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah, parseRupiah, type Rupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { PeriodLockedError } from '$lib/server/services/cash/period';
import {
	AllocationNotFoundError,
	RELEASE_RULE,
	ReleaseRuleError,
	releaseAllocation,
	type ReleaseRule
} from '$lib/server/services/dues/allocation-release';
import {
	correctionsHistoryFor,
	unitFinanceFor
} from '$lib/server/services/dues/corrections-history';
import {
	REFUND_RULE,
	RefundRuleError,
	refundCredit,
	type RefundRule
} from '$lib/server/services/dues/credit-refund';
import {
	InvoiceNotFoundError,
	VOID_RULE,
	VoidRefusedAllocatedError,
	VoidRuleError,
	voidInvoice,
	type VoidRule
} from '$lib/server/services/dues/invoice-void';
import { UnitNotFoundError } from '$lib/server/services/dues/queries';
import type { Actions, PageServerLoad } from './$types';

/**
 * The unit finance screen — one Unit's saldo titipan, its Tagihan with their Alokasi, the history
 * of the three superuser corrections, and the three actions themselves (#30). Follows the shape
 * `(app)/admin/payments/+page.server.ts` settled: nobody who is not signed in reaches the service
 * layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the service, and every
 * rule a service refuses comes back as a rejected form (`fail(400, …)`), `PeriodLockedError`
 * included.
 *
 * All three actions are `ACTION.correctDues`'s — superuser's alone — and so is the `load`: this
 * screen is only useful to whoever may press its buttons, the reasoning
 * `src/lib/server/services/dues/corrections-history.ts` records.
 */

/** The form field naming which Tagihan is being cancelled. */
const INVOICE_ID_FIELD = 'invoiceId';

/** The form field naming which Alokasi is being released. */
const ALLOCATION_ID_FIELD = 'allocationId';

/** The form field carrying each action's required reason. */
const REASON_FIELD = 'reason';

/** The form field carrying a refund's amount, in whole rupiah. */
const AMOUNT_FIELD = 'amount';

/** The form field carrying the day a refund's money was handed back, as `YYYY-MM-DD`. */
const OCCURRED_ON_FIELD = 'occurredOn';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const [finance, history] = await Promise.all([
			unitFinanceFor(database(), locals.user.id, params.id),
			correctionsHistoryFor(database(), locals.user.id, params.id)
		]);
		return { finance, history };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	void: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const invoiceId = String(form.get(INVOICE_ID_FIELD) ?? '').trim();
		const reason = String(form.get(REASON_FIELD) ?? '').trim();
		if (invoiceId === '') {
			return fail(400, { message: m.unitFinance_invalidForm() });
		}

		try {
			const voided = await voidInvoice(database(), systemClock, {
				actorId: locals.user.id,
				invoiceId,
				reason
			});
			return { message: m.voidInvoice_success({ period: voided.period }) };
		} catch (caught) {
			return failVoid(caught);
		}
	},

	release: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const allocationId = String(form.get(ALLOCATION_ID_FIELD) ?? '').trim();
		const reason = String(form.get(REASON_FIELD) ?? '').trim();
		if (allocationId === '') {
			return fail(400, { message: m.unitFinance_invalidForm() });
		}

		try {
			const released = await releaseAllocation(database(), systemClock, {
				actorId: locals.user.id,
				allocationId,
				reason
			});
			return { message: m.releaseAllocation_success({ amount: formatRupiah(released.amount) }) };
		} catch (caught) {
			return failRelease(caught);
		}
	},

	refund: async ({ request, locals, params }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const occurredOn = String(form.get(OCCURRED_ON_FIELD) ?? '').trim();
		const reason = String(form.get(REASON_FIELD) ?? '').trim();
		let amount: Rupiah;
		try {
			amount = parseRupiah(String(form.get(AMOUNT_FIELD) ?? ''));
		} catch {
			return fail(400, { message: m.refund_amountInvalid() });
		}

		try {
			const outcome = await refundCredit(database(), systemClock, {
				actorId: locals.user.id,
				unitId: params.id,
				amount,
				occurredOn,
				reason
			});
			return {
				message: m.refund_success({ amount: formatRupiah(outcome.amount), date: occurredOn })
			};
		} catch (caught) {
			return failRefund(caught);
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

/** Turns each refusal the void service names into a rejected form. */
function failVoid(caught: unknown) {
	if (caught instanceof VoidRuleError) {
		return fail(400, { message: voidRuleMessage(caught.rule) });
	}
	if (caught instanceof VoidRefusedAllocatedError) {
		// The acceptance criteria's named refusal, sentence included: which Alokasi stand in the way.
		return fail(400, {
			message: m.voidInvoice_refusedAllocated({
				allocations: caught.allocations
					.map(
						(allocation) =>
							`${formatRupiah(allocation.amount)} (alokasi ${allocation.allocationId})`
					)
					.join(', ')
			})
		});
	}
	if (caught instanceof InvoiceNotFoundError) {
		return fail(400, { message: m.voidInvoice_notFound() });
	}
	throwAsRouteError(caught);
}

/** Turns each refusal the release service names into a rejected form. */
function failRelease(caught: unknown) {
	if (caught instanceof ReleaseRuleError) {
		return fail(400, { message: releaseRuleMessage(caught.rule) });
	}
	if (caught instanceof AllocationNotFoundError) {
		return fail(400, { message: m.releaseAllocation_notFound() });
	}
	throwAsRouteError(caught);
}

/** Turns each refusal the refund service names into a rejected form. */
function failRefund(caught: unknown) {
	if (caught instanceof RefundRuleError) {
		return fail(400, { message: refundRuleMessage(caught.rule) });
	}
	if (caught instanceof PeriodLockedError) {
		return fail(400, {
			message: m.refund_periodLocked({ period: caught.period, date: caught.occurredOn })
		});
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403, or a caught missing unit into a 404, and throws
 * it — or rethrows whatever else it was. Always throws — the return type is `never` for the same
 * reason `(app)/admin/units/[id]/+page.server.ts`'s copy is: a `catch` block that sometimes
 * *returned* an error instead of throwing it is what breaks SvelteKit's inference of `ActionData`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.unitFinance_forbidden());
	}
	if (caught instanceof UnitNotFoundError) {
		throw error(404, m.unitFinance_notFound());
	}
	throw caught;
}
