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
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	CASH_BOOK_MONTH_PATTERN,
	cashBook,
	type CashBookEntry,
	type CashBookFilter
} from '#lib/server/services/cash/balance.ts';
import { duesCategory } from '#lib/server/services/cash/category.ts';
import {
	CashCorrectionTargetError,
	CashTransactionAlreadyCorrectedError,
	CashTransactionNotFoundError,
	recordCashCorrection,
	type CashCorrectionTargetReason
} from '#lib/server/services/cash/correction.ts';
import { PeriodLockedError } from '#lib/server/services/cash/period.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The buku kas an admin reads and corrects: every line in date order with its running balance, the
 * two filters user story 10 asks for, and one action — recording a Koreksi. There is deliberately
 * no edit action and no delete action, because the service layer offers neither; see
 * `src/lib/server/services/cash/transaction.ts`.
 *
 * Follows the shape `src/lib/server/route-action.ts` settled (#318): nobody who is not signed in
 * reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in the
 * service, and every rule the service refuses comes back as a rejected form. A rule this action does
 * not name is the fallback sentence rather than a 500.
 *
 * ## A line in "Iuran warga" offers no Koreksi button
 *
 * The ordinary Koreksi refuses every line in the system category "Iuran warga" (#323), because such
 * a line is reversed from the Keuangan Unit screen, where the Payment, its Alokasi and its Invoice
 * follow the cash. `load` marks each row with `isDuesLine`, the table draws a note instead of the
 * button, and the action still answers a posted dues line with the service's refusal, since the
 * button is a courtesy and the service is the rule. `CashCorrectionTargetError` is deliberately not
 * categorised in `route-action.ts` (from the dues-correction module it is a defect), so this action
 * names it with `refusal`.
 *
 * ## The receipt links
 *
 * A receipt is opened through a short-lived signed link minted by the `FileStore` port, and the
 * criterion "hanya bisa dibuka lewat tautan bertanda tangan berumur pendek oleh peran admin atau
 * superuser" is met by *where the link is rendered*, not by a second check at the route that serves
 * it. `src/lib/server/ports/file-store.ts` says so outright — a signed link "belongs in a page a
 * recipient already reached through a permission check" — and this `load` is that page: it is
 * refused with a 403 to anyone who does not hold `ACTION.recordCashTransactions`, so a link is only
 * ever minted for an admin, and it stops working ten minutes later wherever it is taken.
 *
 * The route that answers `/files/<key>` is the single serving route for every file this application
 * stores; it checks the signature, which is the authorization.
 *
 * ## Filters live in the query string
 *
 * `?month=YYYY-MM&category=<id>`, read by `load` and posted by a `GET` form. A filtered cash book is
 * then a URL an admin can keep, reload and send to the next pengurus, which a filter held in
 * component state would not be. An unrecognised `month` is dropped rather than refused: it can only
 * arrive from a hand-edited address bar, and answering it with the whole book is friendlier than a
 * 400 and gives away nothing.
 */

/** The query parameter carrying the month filter. */
const MONTH_PARAMETER = 'month';

/** The query parameter carrying the category filter. */
const CATEGORY_PARAMETER = 'category';

/** The form field naming which transaction a correction is about. */
const TRANSACTION_ID_FIELD = 'transactionId';

/** The form field carrying a correction's reason. */
const REASON_FIELD = 'reason';

/** The sentences the page says when it refuses a request outright. */
const PAGE = { forbidden: m.adminCash_forbidden } satisfies PageMessages;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals);

	const filter = filterFrom(url);
	const dependencies = productionDependencies();
	try {
		const book = await cashBook(dependencies.db, user.id, filter);
		const dues = await duesCategory(dependencies.db);
		const fileStore = dependencies.fileStore;
		return {
			filter,
			openingBalance: book.openingBalance,
			closingBalance: book.closingBalance,
			categories: book.categories,
			months: book.months,
			rows: await Promise.all(book.entries.map((entry) => toRow(entry, dues.id, fileStore)))
		};
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	correct: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const transactionId = readText(form, TRANSACTION_ID_FIELD);
		const reason = readText(form, REASON_FIELD);
		if (transactionId === '' || reason === '') {
			return fail(400, { message: m.adminCash_correctionInvalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const correction = await recordCashCorrection(db, clock, {
				actorId: user.id,
				transactionId,
				reason
			});
			return {
				message: m.adminCash_correctionSuccess({
					amount: formatRupiah(correction.amount),
					date: correction.occurredOn
				})
			};
		} catch (caught) {
			return failOrThrow(caught, {
				...PAGE,
				fallback: m.adminCash_correctionInvalidForm,
				refusals: [
					refusal(CashTransactionAlreadyCorrectedError, m.adminCash_correctionAlreadyCorrected),
					refusal(CashTransactionNotFoundError, m.adminCash_correctionNotFound),
					refusal(PeriodLockedError, ({ error }) =>
						m.adminCash_periodLocked({ period: error.period })
					),
					refusal(CashCorrectionTargetError, ({ error }) => targetRefusal(error.reason))
				]
			});
		}
	}
};

/** The filter this request asks for, with anything unrecognisable left out. */
function filterFrom(url: URL): CashBookFilter {
	const month = url.searchParams.get(MONTH_PARAMETER) ?? '';
	const categoryId = url.searchParams.get(CATEGORY_PARAMETER) ?? '';
	return {
		month: CASH_BOOK_MONTH_PATTERN.test(month) ? month : undefined,
		categoryId: categoryId === '' ? undefined : categoryId
	};
}

/**
 * One cash book line as the table renders it, with its receipt already signed for. `duesCategoryId`
 * is the id of "Iuran warga": a line in it is flagged, so the table draws a note and no button.
 */
async function toRow(entry: CashBookEntry, duesCategoryId: string, fileStore: FileStore) {
	return {
		id: entry.id,
		occurredOn: entry.occurredOn,
		type: entry.type,
		categoryName: entry.categoryName,
		description: entry.description,
		amount: entry.amount,
		balance: entry.balance,
		isCorrection: entry.correctionOf !== null,
		isCorrected: entry.correctedBy !== null,
		isDuesLine: entry.categoryId === duesCategoryId,
		recordedByName: entry.recordedByName,
		receiptUrl:
			entry.attachmentKey === null ? null : await fileStore.signedLink(entry.attachmentKey)
	};
}

/**
 * The sentence for why the ordinary Koreksi refused its line. `notThisKind` only comes from the
 * Pembatalan kinds, which this screen never writes, so it takes the same sentence as a malformed
 * request rather than inventing a screen text for a state it cannot reach.
 */
function targetRefusal(reason: CashCorrectionTargetReason): string {
	switch (reason) {
		case 'duesLine':
			return m.adminCash_correctionDuesLine();
		case 'reversedOpeningBalance':
			return m.adminCash_correctionReversedOpeningBalance();
		case 'notThisKind':
			return m.adminCash_correctionInvalidForm();
	}
}
