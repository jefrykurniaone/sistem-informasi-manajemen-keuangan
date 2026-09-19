import { redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { listPublishedReports } from '$lib/server/services/report/publication';
import type { PageServerLoad } from './$types';

/**
 * Every Laporan Bulanan that has been published, newest month first — the page a warga lands on to
 * find out where the complex's money went.
 *
 * **The session check is the whole guard, and it is here.** A published report is readable by every
 * signed-in Warga, so there is no action anybody holds or fails to hold and
 * `listPublishedReports` checks none — see the argument recorded on it. The acceptance criterion
 * "laporan hanya bisa dibuka setelah masuk; pengunjung tanpa akun ditolak" is a question about a
 * session rather than about roles, and this redirect is what answers it, the same shape
 * `(app)/invoices/+page.server.ts` and `(app)/my-unit/+page.server.ts` already have.
 *
 * Only the newest revision of each month is listed. Older revisions are never out of reach: the
 * report's own page carries every revision of its Periode, which is where "revisi lama tetap bisa
 * dibaca" is met. A list showing all of them would answer "which figures apply now" with four rows
 * for one January.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	return { reports: await listPublishedReports(database()) };
};
