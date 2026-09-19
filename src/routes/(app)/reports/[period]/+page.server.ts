import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { CASH_BOOK_MONTH_PATTERN } from '$lib/server/services/cash/balance';
import { reportForPeriod } from '$lib/server/services/report/resident-payload';
import type { PageServerLoad } from './$types';

/**
 * One published Laporan Bulanan, as a warga reads it — the frozen figures of one revision, and the
 * transactions behind one category when they open it.
 *
 * **The session check is the whole guard**, for the reason `(app)/reports/+page.server.ts` records:
 * every signed-in Warga may read a published report, so there is no action to check, and the
 * criterion "pengunjung tanpa akun ditolak" is about a session rather than about roles.
 *
 * ## Why the revision and the category are query parameters
 *
 * `?revision=2&category=<id>`, read here and written by the links in
 * `src/lib/components/report/category-table.svelte`. A revision is a *view* of one month's report
 * rather than a resource of its own — the address of the January report is `/reports/2026-01`
 * whichever revision is newest, so a link shared in a WhatsApp group keeps meaning "January's
 * report" instead of freezing on the revision that happened to be newest the day it was sent. A
 * reader who wants a specific revision says so, and that stays in the address bar so they can share
 * *that* too. The same reasoning `(app)/admin/cash/+page.server.ts` gives for keeping its filters in
 * the query string.
 *
 * An unrecognisable `revision` or `category` is dropped rather than refused: both can only arrive
 * from a hand-edited address bar, and showing the newest revision with nothing opened is friendlier
 * than a 400 and gives away nothing. A `period` that is not a month, a month with no published
 * report, and a revision number that was never published are all a 404 — to a reader they are the
 * same fact, and answering them differently would tell somebody which months have been published
 * without them being signed in to anything.
 */

/** The query parameter naming which revision to read. */
const REVISION_PARAMETER = 'revision';

/** The query parameter naming which category to open. */
const CATEGORY_PARAMETER = 'category';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}
	if (!CASH_BOOK_MONTH_PATTERN.test(params.period)) {
		error(404, m.reports_notFound());
	}

	const view = await reportForPeriod(database(), {
		period: params.period,
		revision: revisionFrom(url),
		categoryId: categoryFrom(url)
	});
	if (!view) {
		error(404, m.reports_notFound());
	}
	return view;
};

/** The revision this request asks for, or `undefined` for the newest there is. */
function revisionFrom(url: URL): number | undefined {
	const raw = url.searchParams.get(REVISION_PARAMETER);
	if (raw === null) {
		return undefined;
	}
	const revision = Number(raw);
	// `Number('')` is 0 and `Number('abc')` is `NaN`; a revision starts at 1, so both fall out here
	// rather than reaching a `where` clause that would answer "no such revision" anyway.
	return Number.isInteger(revision) && revision >= 1 ? revision : undefined;
}

/** The category this request asks to open, or `undefined` for none. */
function categoryFrom(url: URL): string | undefined {
	const raw = url.searchParams.get(CATEGORY_PARAMETER)?.trim() ?? '';
	return raw === '' ? undefined : raw;
}
