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
import {
	CashCategoryNotFoundError,
	listActiveCashCategories
} from '#lib/server/services/cash/category.ts';
import {
	assertMayRecordCashTransactions,
	CASH_RULE,
	CashRuleError,
	RECEIPT_CONTENT_TYPES,
	recordCashTransaction,
	type CashReceiptUpload,
	type CashRule
} from '#lib/server/services/cash/transaction.ts';
import { PeriodLockedError } from '#lib/server/services/cash/period.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The screen an admin records one Transaksi Kas on. It stays on itself after a successful save,
 * with the date kept and the rest of the fields cleared, because a pengurus works through a stack
 * of receipts in one sitting; the cash book is one link away.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and a named rule refusal becomes `fail(400, …)` with the fields still filled in. A rule
 * this screen does not name is the invalid-form sentence rather than a 500.
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

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminCash_forbidden } satisfies PageMessages;

/** What `create` says when the service refuses it, each `fail(400)` with the fields refilled. */
const CREATE_FORM = {
	...PAGE,
	fallback: m.adminCash_invalidForm,
	refusals: [
		refusal(CashRuleError, ({ error }) => ruleMessage(error.rule)),
		refusal(CashCategoryNotFoundError, m.adminCash_categoryNotFound),
		refusal(PeriodLockedError, ({ error }) => m.adminCash_periodLocked({ period: error.period }))
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const { db } = productionDependencies();
	// The category list takes no caller — it is the same read every recording form makes — so the
	// permission check is made on its own. Without it a resident would be shown a form and only
	// refused once they had filled it in.
	try {
		await assertMayRecordCashTransactions(db, user.id);
	} catch (caught) {
		throwRouteError(caught, PAGE);
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
		const user = requireUser(locals);

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

		const amount = readRupiah(form, AMOUNT_FIELD);
		if (amount === undefined) {
			return fail(400, { message: m.adminCash_invalidAmount(), values });
		}

		const dependencies = productionDependencies();
		try {
			const recorded = await recordCashTransaction(
				dependencies.db,
				dependencies.clock,
				dependencies.fileStore,
				{
					actorId: user.id,
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
			return failOrThrow(caught, CREATE_FORM, { values });
		}
	}
};

/** What the recording form carries, trimmed, as strings. */
function readFormValues(form: FormData) {
	return {
		occurredOn: readText(form, DATE_FIELD),
		categoryId: readText(form, CATEGORY_FIELD),
		amount: readText(form, AMOUNT_FIELD),
		description: readText(form, DESCRIPTION_FIELD)
	};
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
