import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { formatRupiah } from '$lib/money';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import type { FileStore } from '$lib/server/ports/file-store';
import {
	CASH_BOOK_MONTH_PATTERN,
	cashBook,
	type CashBookEntry,
	type CashBookFilter
} from '$lib/server/services/cash/balance';
import {
	CashTransactionAlreadyCorrectedError,
	CashTransactionNotFoundError,
	recordCashCorrection
} from '$lib/server/services/cash/correction';
import { CashRuleError } from '$lib/server/services/cash/transaction';
import { localFileStoreFromEnvironment } from '$lib/server/storage/local-file-store';
import type { Actions, PageServerLoad } from './$types';

/**
 * The buku kas an admin reads and corrects: every line in date order with its running balance, the
 * two filters user story 10 asks for, and one action — recording a Koreksi. There is deliberately
 * no edit action and no delete action, because the service layer offers neither; see
 * `src/lib/server/services/cash/transaction.ts`.
 *
 * Follows the shape `src/routes/(app)/admin/units/+page.server.ts` settled: nobody who is not signed
 * in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and never in
 * the service, and every rule the service refuses comes back as a rejected form.
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

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const filter = filterFrom(url);
	try {
		const book = await cashBook(database(), locals.user.id, filter);
		const fileStore = localFileStoreFromEnvironment(systemClock);
		return {
			filter,
			openingBalance: book.openingBalance,
			closingBalance: book.closingBalance,
			categories: book.categories,
			months: book.months,
			rows: await Promise.all(book.entries.map((entry) => toRow(entry, fileStore)))
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	correct: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const transactionId = String(form.get(TRANSACTION_ID_FIELD) ?? '').trim();
		const reason = String(form.get(REASON_FIELD) ?? '').trim();
		if (transactionId === '' || reason === '') {
			return fail(400, { message: m.adminCash_correctionInvalidForm() });
		}

		try {
			const correction = await recordCashCorrection(database(), systemClock, {
				actorId: locals.user.id,
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
			return failAsRejectedForm(caught);
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

/** One cash book line as the table renders it, with its receipt already signed for. */
async function toRow(entry: CashBookEntry, fileStore: FileStore) {
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
		recordedByName: entry.recordedByName,
		receiptUrl:
			entry.attachmentKey === null ? null : await fileStore.signedLink(entry.attachmentKey)
	};
}

/** Turns each refusal the correction service names into a rejected form. */
function failAsRejectedForm(caught: unknown) {
	if (caught instanceof CashTransactionAlreadyCorrectedError) {
		return fail(400, { message: m.adminCash_correctionAlreadyCorrected() });
	}
	if (caught instanceof CashTransactionNotFoundError) {
		return fail(400, { message: m.adminCash_correctionNotFound() });
	}
	if (caught instanceof CashRuleError) {
		return fail(400, { message: m.adminCash_correctionInvalidForm() });
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * `never`, so it can end a `catch` block without widening what SvelteKit infers — the same helper
 * the units and cash category screens carry, for the same reason.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminCash_forbidden());
	}
	throw caught;
}
