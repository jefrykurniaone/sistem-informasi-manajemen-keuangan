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
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	MAXIMUM_PROOF_MEBIBYTES,
	PAYMENT_RULE,
	PaymentRuleError,
	cancelOwnPayment,
	ownPayments,
	type OwnPayment,
	type PaymentRule
} from '#lib/server/services/dues/payment.ts';
import {
	residentViewFor,
	unitsOccupiedToday
} from '#lib/server/services/occupancy/resident-view.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * A Warga's own payments: what they recorded, what came of it, and the one action they still have
 * over a payment nobody has decided on — `docs/spec-iuran-v1.md` user stories 11 and 13.
 *
 * **There is nothing to guard beyond the session.** Both service calls take the signed-in account's
 * own id and nothing else, so there is no id in a URL a caller could swap for somebody else's — the
 * reasoning `(app)/my-unit/+page.server.ts` and `src/lib/server/services/resident/profile.ts`
 * already settled. The `cancel` action does carry a payment id, and that id is checked against the
 * caller's `residents` row inside the service, which refuses with `PermissionDeniedError`; this
 * route turns that into a 403 exactly as it would one from `requirePermission`.
 *
 * ## The proof links
 *
 * A proof is opened through a short-lived signed link minted here, and "hanya bisa dibuka lewat
 * tautan bertanda tangan berumur pendek" is met by *where the link is rendered* rather than by a
 * check at the route that serves it. `src/lib/server/ports/file-store.ts` says so outright — a
 * signed link "belongs in a page a recipient already reached through a permission check" — and this
 * `load` is that page: the only payments it lists are the caller's own, so a link is only ever
 * minted for the person who uploaded the file, and it stops working minutes later wherever it is
 * taken. `src/routes/files/[...key]/+server.ts` is the single serving route for every stored file in
 * this application, and this ticket adds no second one.
 */

/** The form field naming which payment is being withdrawn. */
const PAYMENT_ID_FIELD = 'paymentId';

/** The query parameter the "catat pembayaran" screen redirects back with. */
const RECORDED_PARAMETER = 'recorded';

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.payments_forbidden } satisfies PageMessages;

/** What `cancel` says when the service refuses it, each `fail(400)`. */
const CANCEL_FORM = {
	...PAGE,
	fallback: m.payments_invalidForm,
	refusals: [refusal(PaymentRuleError, ({ error }) => ruleMessage(error.rule))]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals);

	const { db, clock, fileStore } = productionDependencies();
	const [recorded, view] = await Promise.all([
		ownPayments(db, user.id),
		residentViewFor(db, clock, user.id)
	]);

	return {
		payments: await Promise.all(recorded.map((payment) => toRow(payment, fileStore))),
		// Whether the "catat pembayaran" link is worth offering. A resident who lives nowhere today
		// has no house to record a payment for, and the service would refuse them anyway. "Lives
		// there today" is the shared resident view's, the same answer the payment guard reads.
		canRecord: unitsOccupiedToday(view).length > 0,
		justRecorded: url.searchParams.get(RECORDED_PARAMETER) === '1'
	};
};

export const actions: Actions = {
	cancel: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const paymentId = readText(form, PAYMENT_ID_FIELD);
		if (paymentId === '') {
			return fail(400, { message: m.payments_invalidForm() });
		}

		const dependencies = productionDependencies();
		try {
			const cancelled = await cancelOwnPayment(
				dependencies.db,
				dependencies.clock,
				dependencies.fileStore,
				{ actorUserId: user.id, paymentId }
			);
			return { message: m.payments_cancelSuccess({ amount: formatRupiah(cancelled.amount) }) };
		} catch (caught) {
			return failOrThrow(caught, CANCEL_FORM);
		}
	}
};

/** One payment as the list renders it, with its proof already signed for. */
async function toRow(payment: OwnPayment, fileStore: FileStore) {
	const { proofFileKey, ...rest } = payment;
	return {
		...rest,
		proofUrl: proofFileKey === null ? null : await fileStore.signedLink(proofFileKey)
	};
}

/** The sentence a resident reads for each named rule refusal this screen can run into. */
function ruleMessage(rule: PaymentRule): string {
	const messages: Record<PaymentRule, () => string> = {
		[PAYMENT_RULE.amountNotPositive]: m.payments_rule_amountNotPositive,
		[PAYMENT_RULE.notACalendarDay]: m.payments_rule_notACalendarDay,
		[PAYMENT_RULE.receivedInTheFuture]: m.payments_rule_receivedInTheFuture,
		[PAYMENT_RULE.proofMissing]: m.payments_rule_proofMissing,
		// The only one carrying a figure, and it comes from the constant the service enforces rather
		// than from a number written into both catalogues by hand.
		[PAYMENT_RULE.proofTooLarge]: () =>
			m.payments_rule_proofTooLarge({ maximumSize: MAXIMUM_PROOF_MEBIBYTES }),
		[PAYMENT_RULE.proofNotAnImage]: m.payments_rule_proofNotAnImage,
		[PAYMENT_RULE.alreadyDecided]: m.payments_rule_alreadyDecided
	};
	return messages[rule]();
}
