import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import type { FileStore } from '$lib/server/ports/file-store';
import { PeriodLockedError } from '$lib/server/services/cash/period';
import {
	PaymentNotFoundError,
	VERIFICATION_RULE,
	VerificationRuleError,
	listPendingPayments,
	rejectPayment,
	verifyPayment,
	type PendingPayment,
	type VerificationRule
} from '$lib/server/services/dues/verification';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { Actions, PageServerLoad } from './$types';

/**
 * The verification queue — `docs/spec-iuran-v1.md` user stories 14 through 16. Follows the shape
 * `(app)/admin/cash/+page.server.ts` settled: nobody who is not signed in reaches the service
 * layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the service, and every
 * rule the service refuses comes back as a rejected form.
 *
 * The proof links are short-lived signed links minted in this `load`, which is refused with a 403
 * to anyone not holding `ACTION.verifyPayments` — the same "the permission check is where the link
 * is rendered" rule every other proof- and receipt-showing screen records.
 *
 * `PeriodLockedError` is caught here by name, as this ticket's own screens must (#97 owns the two
 * cash screens' copies of the same catch): a verification of money received in a locked month is a
 * legitimate request the book refuses, and the admin reads which month and why rather than a 500.
 */

/** The form field naming which payment is being decided. */
const PAYMENT_ID_FIELD = 'paymentId';

/** The form field carrying the explicitly chosen Tagihan — one value per ticked box. */
const INVOICE_IDS_FIELD = 'invoiceIds';

/** The form field carrying a rejection's reason. */
const REASON_FIELD = 'reason';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const pending = await listPendingPayments(database(), locals.user.id);
		const fileStore = localFileStoreFromEnvironment(systemClock);
		return { payments: await Promise.all(pending.map((payment) => toRow(payment, fileStore))) };
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	verify: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const paymentId = String(form.get(PAYMENT_ID_FIELD) ?? '').trim();
		const invoiceIds = form
			.getAll(INVOICE_IDS_FIELD)
			.map((value) => String(value).trim())
			.filter((value) => value !== '');
		if (paymentId === '') {
			return fail(400, { message: m.adminPayments_invalidForm() });
		}

		try {
			const outcome = await verifyPayment(database(), systemClock, {
				actorId: locals.user.id,
				paymentId,
				invoiceIds
			});
			return {
				message: m.adminPayments_verifySuccess({
					amount: formatRupiah(outcome.payment.amount),
					date: outcome.cashTransaction.occurredOn
				})
			};
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	reject: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const paymentId = String(form.get(PAYMENT_ID_FIELD) ?? '').trim();
		const reason = String(form.get(REASON_FIELD) ?? '').trim();
		if (paymentId === '') {
			return fail(400, { message: m.adminPayments_invalidForm() });
		}

		try {
			await rejectPayment(database(), systemClock, {
				actorId: locals.user.id,
				paymentId,
				reason
			});
			return { message: m.adminPayments_rejectSuccess() };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	}
};

/**
 * One queue row as the table renders it, with its proof already signed for.
 *
 * A Tagihan whose remaining amount is zero is left off the checkbox list here, at the screen: it is
 * settled, so offering it as something to "pay first" reads as a contradiction. The service keeps
 * answering the full set on purpose — the verification transaction re-reads and re-validates under
 * its own locks, and an explicitly named settled Tagihan is simply skipped by the planner.
 */
async function toRow(payment: PendingPayment, fileStore: FileStore) {
	const { proofFileKey, openInvoices, ...rest } = payment;
	return {
		...rest,
		openInvoices: openInvoices.filter((invoice) => invoice.remainingAmount > 0),
		proofUrl: proofFileKey === null ? null : await fileStore.signedLink(proofFileKey)
	};
}

/** The sentence an admin reads for each named rule refusal. */
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

/** Turns each refusal the verification service names into a rejected form. */
function failAsRejectedForm(caught: unknown) {
	if (caught instanceof VerificationRuleError) {
		return fail(400, { message: ruleMessage(caught.rule) });
	}
	if (caught instanceof PaymentNotFoundError) {
		return fail(400, { message: m.adminPayments_notFound() });
	}
	if (caught instanceof PeriodLockedError) {
		return fail(400, {
			message: m.adminPayments_periodLocked({ period: caught.period, date: caught.occurredOn })
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
