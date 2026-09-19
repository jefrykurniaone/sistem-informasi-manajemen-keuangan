import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah, parseRupiah, type Rupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { PeriodLockedError } from '$lib/server/services/cash/period';
import { UnitNotFoundError } from '$lib/server/services/dues/queries';
import {
	VERIFICATION_RULE,
	VerificationRuleError,
	assertMayVerifyPayments,
	listCashPayableUnits,
	recordCashPayment,
	type VerificationRule
} from '$lib/server/services/dues/verification';
import type { Actions, PageServerLoad } from './$types';

/**
 * An admin recording a Pembayaran handed over in cash — `docs/spec-iuran-v1.md` user story 17. The
 * payment is verified the moment it is recorded, through the same service path the queue uses, so
 * this screen's one action does what the queue's "verifikasi" does plus the recording itself.
 *
 * Follows the shape `(app)/admin/cash/new/+page.server.ts` settled: the `load` asserts the action
 * before offering the form, a permission refusal becomes `error(403, …)`, and every rule the
 * service refuses comes back as a rejected form with the fields still filled in. No invoice picker:
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

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		await assertMayVerifyPayments(database(), locals.user.id);
		const units = await listCashPayableUnits(database(), locals.user.id);
		return { units };
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
		const values = {
			unitId: String(form.get(UNIT_FIELD) ?? '').trim(),
			amount: String(form.get(AMOUNT_FIELD) ?? '').trim(),
			receivedOn: String(form.get(RECEIVED_ON_FIELD) ?? '').trim()
		};
		if (values.unitId === '' || values.amount === '' || values.receivedOn === '') {
			return fail(400, { message: m.adminPayments_cash_invalidForm(), values });
		}

		const amount = readAmount(values.amount);
		if (amount === undefined) {
			return fail(400, { message: m.adminPayments_cash_invalidAmount(), values });
		}

		try {
			const outcome = await recordCashPayment(database(), systemClock, {
				actorId: locals.user.id,
				unitId: values.unitId,
				amount,
				receivedOn: values.receivedOn
			});
			return {
				message: m.adminPayments_cash_success({ amount: formatRupiah(outcome.payment.amount) })
			};
		} catch (caught) {
			return failAsRejectedForm(caught, values);
		}
	}
};

/** What the form posted, for refilling a rejected submission. */
interface FormValues {
	readonly unitId: string;
	readonly amount: string;
	readonly receivedOn: string;
}

/**
 * The typed money value behind what the form posted, or `undefined` when the text is not a
 * whole-rupiah amount. `parseRupiah` rejects fractions rather than rounding them.
 */
function readAmount(raw: string): Rupiah | undefined {
	try {
		return parseRupiah(raw);
	} catch {
		return undefined;
	}
}

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

/** Turns each refusal the service names into a rejected form that keeps what was typed. */
function failAsRejectedForm(caught: unknown, values: FormValues) {
	if (caught instanceof VerificationRuleError) {
		return fail(400, { message: ruleMessage(caught.rule), values });
	}
	if (caught instanceof UnitNotFoundError) {
		return fail(400, { message: m.adminPayments_cash_unitNotFound(), values });
	}
	if (caught instanceof PeriodLockedError) {
		return fail(400, {
			message: m.adminPayments_periodLocked({ period: caught.period, date: caught.occurredOn }),
			values
		});
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` for the same reason the cash screens' copies are.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminPayments_forbidden());
	}
	throw caught;
}
