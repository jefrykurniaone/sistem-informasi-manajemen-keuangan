import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { parseRupiah, type Rupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
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
} from '$lib/server/services/dues/payment';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen a Warga records one Pembayaran on — `docs/spec-iuran-v1.md` user stories 8 through 10.
 *
 * Follows the shape `(app)/admin/cash/new/+page.server.ts` settled: nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a named rule refusal becomes `fail(400, …)` with the fields still filled in.
 *
 * **The houses the form offers are a courtesy, not the guarantee.** `payableUnitsForUser` lists the
 * ones the resident is living in today, and a `unitId` that arrives by hand is refused again by
 * `recordPayment` with the same rule — which is what `tests/unit/payment-service.test.ts` proves.
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

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const units = await payableUnitsForUser(database(), systemClock, locals.user.id);
	return {
		units,
		acceptedProofTypes: PROOF_CONTENT_TYPES,
		maximumProofBytes: MAXIMUM_PROOF_BYTES
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const values = readFormValues(form);
		if (values.unitId === '' || values.amount === '' || values.receivedOn === '') {
			return fail(400, { message: m.payments_invalidForm(), values });
		}

		const amount = readAmount(values.amount);
		if (amount === undefined) {
			return fail(400, { message: m.payments_invalidAmount(), values });
		}

		const proof = await readProof(form);
		if (!proof) {
			return fail(400, { message: m.payments_rule_proofMissing(), values });
		}

		try {
			await recordPayment(database(), systemClock, localFileStoreFromEnvironment(systemClock), {
				actorUserId: locals.user.id,
				unitId: values.unitId,
				amount,
				receivedOn: values.receivedOn,
				proof
			});
		} catch (caught) {
			if (caught instanceof PaymentRuleError) {
				return fail(400, { message: ruleMessage(caught.rule), values });
			}
			throwAsRouteError(caught);
		}

		// Outside the `try`, because SvelteKit signals a redirect by throwing and a `catch` around it
		// would turn a saved payment into an error nobody meant.
		redirect(303, RECORDED_PATH);
	}
};

/** What the recording form carries, trimmed, as strings. */
function readFormValues(form: FormData) {
	return {
		unitId: String(form.get(UNIT_FIELD) ?? '').trim(),
		amount: String(form.get(AMOUNT_FIELD) ?? '').trim(),
		receivedOn: String(form.get(RECEIVED_ON_FIELD) ?? '').trim()
	};
}

/**
 * The typed money value behind what the form posted, or `undefined` when the text is not a
 * whole-rupiah amount. `parseRupiah` rejects fractions rather than rounding them, which is the whole
 * reason the raw text goes through it instead of through `Number()`.
 */
function readAmount(raw: string): Rupiah | undefined {
	try {
		return parseRupiah(raw);
	} catch {
		return undefined;
	}
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

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` for the same reason the cash screens' copies are.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.payments_forbidden());
	}
	throw caught;
}
