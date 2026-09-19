import { redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { listComplaints, type ComplaintWithAge } from '$lib/server/services/complaint';
import { reporterIdForUser } from '$lib/server/services/complaint/visibility';
import type { PageServerLoad } from './$types';

/**
 * A Warga's own Keluhan list, and the public board of everyone else's — user stories 4 and 8 of
 * `docs/spec-keluhan-v1.md`, and the ticket's own "warga dapat membaca daftar keluhan yang ditandai
 * umum, tanpa bisa mengubah apa pun di dalamnya".
 *
 * **Both sections come from one call to `listComplaints`.** Its own doc comment in
 * `src/lib/server/services/complaint/index.ts` already answers exactly this union for a signed-in
 * viewer — every complaint they reported, whatever its visibility, plus every `public` complaint
 * anyone reported — so this route asks for it once and splits the rows by `reporterId` afterwards,
 * rather than filtering a second time with a rule of its own. Splitting, not a second query, is what
 * keeps the two lists from ever disagreeing about which complaints exist at all.
 *
 * **Read-only, on purpose.** Nothing on this screen writes: withdrawing and replying both need one
 * complaint's own detail screen, `/complaints/[id]`, which is where the acceptance criterion "tanpa
 * bisa mengubah apa pun" is enforced by there being no form here at all, not by a check that could be
 * bypassed.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const db = database();
	const [items, ownResidentId] = await Promise.all([
		listComplaints(db, systemClock, { viewerUserId: locals.user.id }),
		reporterIdForUser(db, locals.user.id)
	]);

	const mine: ComplaintWithAge[] = [];
	const others: ComplaintWithAge[] = [];
	for (const item of items) {
		if (ownResidentId && item.reporterId === ownResidentId) {
			mine.push(item);
		} else {
			others.push(item);
		}
	}

	return {
		mine: mine.map(toRow),
		public: others.map(toRow)
	};
};

/** One row either list renders — the age already reduced to whole days. */
function toRow(item: ComplaintWithAge) {
	return {
		id: item.id,
		title: item.title,
		category: item.category,
		status: item.status,
		ageDays: Math.floor(item.ageMilliseconds / (24 * 60 * 60 * 1000))
	};
}
