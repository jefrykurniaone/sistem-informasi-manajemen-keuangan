import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import { formatRupiah } from '#lib/money.ts';
import type { FileStore } from '#lib/server/ports/file-store.ts';
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
import { PeriodLockedError } from '#lib/server/services/cash/period.ts';
import {
	PaymentNotFoundError,
	VERIFICATION_RULE,
	VerificationRuleError,
	listPendingPayments,
	rejectPayment,
	verifyPayment,
	type PendingPayment,
	type VerificationRule
} from '#lib/server/services/dues/verification.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The verification queue — `docs/spec-iuran-v1.md` user stories 14 through 16. Follows the shape
 * `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in reaches the service
 * layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the service, and every
 * rule the service refuses comes back as a rejected form. A rule this screen does not name is the
 * invalid-form sentence rather than a 500.
 *
 * The proof links are short-lived signed links minted in this `load`, which is refused with a 403
 * to anyone not holding `ACTION.verifyPayments` — the same "the permission check is where the link
 * is rendered" rule every other proof- and receipt-showing screen records.
 *
 * `PeriodLockedError` is named here: a verification of money received in a locked month is a
 * legitimate request the book refuses, and the admin reads which month and why rather than the
 * screen's general sentence.
 */

/** The form field naming which payment is being decided. */
const PAYMENT_ID_FIELD = 'paymentId';

/** The form field carrying the explicitly chosen Tagihan — one value per ticked box. */
const INVOICE_IDS_FIELD = 'invoiceIds';

/** The form field carrying a rejection's reason. */
const REASON_FIELD = 'reason';

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminPayments_forbidden } satisfies PageMessages;

/** What both decisions say when the service refuses them, each `fail(400)`. */
const DECISION_FORM = {
	...PAGE,
	fallback: m.adminPayments_invalidForm,
	refusals: [
		refusal(VerificationRuleError, ({ error }) => ruleMessage(error.rule)),
		refusal(PaymentNotFoundError, m.adminPayments_notFound),
		refusal(PeriodLockedError, ({ error }) =>
			m.adminPayments_periodLocked({ period: error.period, date: error.occurredOn })
		)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const dependencies = productionDependencies();
	try {
		const pending = await listPendingPayments(dependencies.db, user.id);
		const fileStore = dependencies.fileStore;
		return { payments: await Promise.all(pending.map((payment) => toRow(payment, fileStore))) };
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	verify: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const paymentId = readText(form, PAYMENT_ID_FIELD);
		const invoiceIds = form
			.getAll(INVOICE_IDS_FIELD)
			.map((value) => String(value).trim())
			.filter((value) => value !== '');
		if (paymentId === '') {
			return fail(400, { message: m.adminPayments_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const outcome = await verifyPayment(db, clock, {
				actorId: user.id,
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
			return failOrThrow(caught, DECISION_FORM);
		}
	},

	reject: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const paymentId = readText(form, PAYMENT_ID_FIELD);
		const reason = readText(form, REASON_FIELD);
		if (paymentId === '') {
			return fail(400, { message: m.adminPayments_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			await rejectPayment(db, clock, {
				actorId: user.id,
				paymentId,
				reason
			});
			return { message: m.adminPayments_rejectSuccess() };
		} catch (caught) {
			return failOrThrow(caught, DECISION_FORM);
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
