import { fail, redirect } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import {
	failOrThrow,
	productionDependencies,
	readRupiah,
	readText,
	refusal,
	requireUser,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	MAXIMUM_PROOF_BYTES,
	MAXIMUM_PROOF_MEBIBYTES,
	PAYMENT_RULE,
	PaymentRuleError,
	PROOF_CONTENT_TYPES,
	payableUnitsForUser,
	recordPayment,
	type PaymentProofUpload,
	type PaymentRule
} from '#lib/server/services/dues/payment.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen a Warga records one Pembayaran on — `docs/spec-iuran-v1.md` user stories 8 through 10.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a named rule refusal becomes `fail(400, …)` with the fields still filled in. A rule
 * this screen does not name is the invalid-form sentence rather than a 500.
 *
 * **The houses the form offers are a courtesy, not the guarantee.** `payableUnitsForUser` lists the
 * ones the resident is living in today, and a `unitId` that arrives by hand is refused again by
 * `recordPayment` with the same rule — which is what `tests/unit/payment-service.test.ts` proves.
 * Both read `src/lib/server/services/occupancy/resident-view.ts`, which reads no role: a superuser
 * or an admin who lives in a house is offered that house's Tagihan from their own Masa Huni only.
 * The Tagihan offered are only the ones not paid in full, each with what it still owes, from
 * `src/lib/server/services/dues/invoice-standing.ts`; the page adds that remainder when one is ticked.
 *
 * **A successful save redirects to the list rather than staying here.** Recording a transfer is a
 * thing a resident does once and then wants to see the state of; the cash book's "stay and clear the
 * form" behaviour is for an admin working through a pile of receipts, which is a different job.
 */

/** The form field naming the house the money is for. */
const UNIT_FIELD = 'unitId';
/** The form field carrying the amount, as typed. */
const AMOUNT_FIELD = 'amount';
/** The form field carrying the day the money changed hands. */
const RECEIVED_ON_FIELD = 'receivedOn';
/** The form field carrying the photograph of the transfer receipt. */
const PROOF_FIELD = 'proof';

/** Where a saved payment lands, with the query that makes the list say so. */
const RECORDED_PATH = '/payments?recorded=1';

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.payments_forbidden } satisfies PageMessages;

/** What `create` says when the service refuses it, each `fail(400)` with the fields refilled. */
const CREATE_FORM = {
	...PAGE,
	fallback: m.payments_invalidForm,
	refusals: [refusal(PaymentRuleError, ({ error }) => ruleMessage(error.rule))]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db, clock } = productionDependencies();
	const units = await payableUnitsForUser(db, clock, user.id);
	return {
		units,
		acceptedProofTypes: PROOF_CONTENT_TYPES,
		maximumProofBytes: MAXIMUM_PROOF_BYTES
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const values = readFormValues(form);
		if (values.unitId === '' || values.amount === '' || values.receivedOn === '') {
			return fail(400, { message: m.payments_invalidForm(), values });
		}

		const amount = readRupiah(form, AMOUNT_FIELD);
		if (amount === undefined) {
			return fail(400, { message: m.payments_invalidAmount(), values });
		}

		const proof = await readProof(form);
		if (!proof) {
			return fail(400, { message: m.payments_rule_proofMissing(), values });
		}

		const dependencies = productionDependencies();
		try {
			await recordPayment(dependencies.db, dependencies.clock, dependencies.fileStore, {
				actorUserId: user.id,
				unitId: values.unitId,
				amount,
				receivedOn: values.receivedOn,
				proof
			});
		} catch (caught) {
			return failOrThrow(caught, CREATE_FORM, { values });
		}

		// Outside the `try`, because SvelteKit signals a redirect by throwing and a `catch` around it
		// would turn a saved payment into an error nobody meant.
		redirect(303, RECORDED_PATH);
	}
};

/** What the recording form carries, trimmed, as strings. */
function readFormValues(form: FormData) {
	return {
		unitId: readText(form, UNIT_FIELD),
		amount: readText(form, AMOUNT_FIELD),
		receivedOn: readText(form, RECEIVED_ON_FIELD)
	};
}

/**
 * The photograph the resident attached, or `undefined` when they attached none. An empty file input
 * posts a zero-byte `File`, which is "no proof" rather than an empty image. Whether the bytes really
 * are the image they claim to be is the service's question, not this one's.
 */
async function readProof(form: FormData): Promise<PaymentProofUpload | undefined> {
	const file = form.get(PROOF_FIELD);
	if (!(file instanceof File) || file.size === 0) {
		return undefined;
	}
	return { contentType: file.type, content: new Uint8Array(await file.arrayBuffer()) };
}

/** The sentence a resident reads for each named rule refusal. */
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
