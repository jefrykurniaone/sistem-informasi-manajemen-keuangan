import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah, parseRupiah, type Rupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	CashCategoryNotFoundError,
	listActiveCashCategories
} from '$lib/server/services/cash/category';
import {
	assertMayRecordCashTransactions,
	CASH_RULE,
	CashRuleError,
	RECEIPT_CONTENT_TYPES,
	recordCashTransaction,
	type CashReceiptUpload,
	type CashRule
} from '$lib/server/services/cash/transaction';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen an admin records one Transaksi Kas on. It stays on itself after a successful save,
 * with the date kept and the rest of the fields cleared, because a pengurus works through a stack
 * of receipts in one sitting; the cash book is one link away.
 *
 * Follows the shape `(app)/admin/posts/new/+page.server.ts` settled: nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a named rule refusal becomes `fail(400, …)` with the fields still filled in.
 *
 * There is no direction field, and the form offers no system category. The first is because a
 * transaction's direction is its category's type — a rule
 * `src/lib/server/services/cash/transaction.ts` makes true by never reading one from the caller —
 * and the second is a courtesy: the service refuses a system category whether or not an option for
 * it was drawn, which is what `tests/unit/cash-transaction.test.ts` proves.
 */

/** The form field carrying the day money moved. */
const DATE_FIELD = 'occurredOn';
/** The form field naming the Kategori Kas. */
const CATEGORY_FIELD = 'categoryId';
/** The form field carrying the amount, as typed. */
const AMOUNT_FIELD = 'amount';
/** The form field carrying the keterangan. */
const DESCRIPTION_FIELD = 'description';
/** The form field carrying the optional receipt photo. */
const RECEIPT_FIELD = 'receipt';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const db = database();
	// The category list takes no caller — it is the same read every recording form makes — so the
	// permission check is made on its own. Without it a resident would be shown a form and only
	// refused once they had filled it in.
	try {
		await assertMayRecordCashTransactions(db, locals.user.id);
	} catch (caught) {
		throwAsRouteError(caught);
	}

	const categories = await listActiveCashCategories(db);
	return {
		categories: categories
			.filter((category) => category.systemKey === null)
			.map((category) => ({ id: category.id, name: category.name, type: category.type })),
		acceptedReceiptTypes: RECEIPT_CONTENT_TYPES
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const values = readFormValues(form);
		if (
			values.occurredOn === '' ||
			values.categoryId === '' ||
			values.amount === '' ||
			values.description === ''
		) {
			return fail(400, { message: m.adminCash_invalidForm(), values });
		}

		const amount = readAmount(values.amount);
		if (amount === undefined) {
			return fail(400, { message: m.adminCash_invalidAmount(), values });
		}

		try {
			const recorded = await recordCashTransaction(
				database(),
				systemClock,
				localFileStoreFromEnvironment(systemClock),
				{
					actorId: locals.user.id,
					occurredOn: values.occurredOn,
					categoryId: values.categoryId,
					amount,
					description: values.description,
					receipt: await readReceipt(form)
				}
			);
			return {
				message: m.adminCash_recordSuccess({
					amount: formatRupiah(recorded.amount),
					date: recorded.occurredOn
				}),
				// The date stays, the rest is cleared: the next receipt in the pile is usually another
				// line of the same day, and never the same amount.
				values: { occurredOn: recorded.occurredOn, categoryId: '', amount: '', description: '' }
			};
		} catch (caught) {
			if (caught instanceof CashRuleError) {
				return fail(400, { message: ruleMessage(caught.rule), values });
			}
			if (caught instanceof CashCategoryNotFoundError) {
				return fail(400, { message: m.adminCash_categoryNotFound(), values });
			}
			throwAsRouteError(caught);
		}
	}
};

/** What the recording form carries, trimmed, as strings. */
function readFormValues(form: FormData) {
	return {
		occurredOn: String(form.get(DATE_FIELD) ?? '').trim(),
		categoryId: String(form.get(CATEGORY_FIELD) ?? '').trim(),
		amount: String(form.get(AMOUNT_FIELD) ?? '').trim(),
		description: String(form.get(DESCRIPTION_FIELD) ?? '').trim()
	};
}

/**
 * The typed money value behind what the form posted, or `undefined` when the text is not a
 * whole-rupiah amount. `parseRupiah` rejects fractions rather than rounding them, which is the
 * whole reason the raw text goes through it instead of through `Number()`.
 */
function readAmount(raw: string): Rupiah | undefined {
	try {
		return parseRupiah(raw);
	} catch {
		return undefined;
	}
}

/**
 * The receipt the admin attached, or `undefined` when they attached none.
 *
 * An empty file input posts a zero-byte `File`, which is "no receipt" rather than an empty image —
 * the same reading `(app)/admin/posts/[id]` makes of its cover field. Whether the bytes really are
 * an image is the service's question, not this one's.
 */
async function readReceipt(form: FormData): Promise<CashReceiptUpload | undefined> {
	const file = form.get(RECEIPT_FIELD);
	if (!(file instanceof File) || file.size === 0) {
		return undefined;
	}
	return { contentType: file.type, content: new Uint8Array(await file.arrayBuffer()) };
}

/** The sentence a person reads for each named rule refusal. */
function ruleMessage(rule: CashRule): string {
	const messages: Record<CashRule, () => string> = {
		[CASH_RULE.categoryIsSystem]: m.adminCash_rule_categoryIsSystem,
		[CASH_RULE.categoryRetired]: m.adminCash_rule_categoryRetired,
		[CASH_RULE.amountNotPositive]: m.adminCash_rule_amountNotPositive,
		[CASH_RULE.notACalendarDay]: m.adminCash_rule_notACalendarDay,
		[CASH_RULE.descriptionMissing]: m.adminCash_rule_descriptionMissing,
		[CASH_RULE.receiptTooLarge]: m.adminCash_rule_receiptTooLarge,
		[CASH_RULE.receiptNotAnImage]: m.adminCash_rule_receiptNotAnImage
	};
	return messages[rule]();
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * Always throws — the return type is `never` for the same reason the unit screens' copies of this
 * helper are.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminCash_forbidden());
	}
	throw caught;
}
