import { redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import { occupiedUnitsForUser, type OwnOccupancy } from '$lib/server/services/occupancy';
import { residentProfileForUser } from '$lib/server/services/resident/profile';
import type { PageServerLoad } from './$types';

/**
 * A resident's own house: the stays recorded in their name, and who else is recorded as living
 * there — `spec-warga-unit-v1.md`'s "Sebagai warga, saya ingin melihat rumah saya beserta siapa saja
 * yang tercatat menghuninya, supaya saya bisa melapor kalau datanya salah".
 *
 * **There is nothing to guard beyond the session.** The only key `occupiedUnitsForUser` takes is the
 * signed-in account's own id, so there is no id in a URL or a form that a caller could swap for
 * someone else's — the same reason `src/lib/server/services/resident/profile.ts` gives for guarding
 * by row ownership instead of by a `PERMISSIONS` action. This load reads and never writes, so it has
 * no action and no `PermissionDeniedError` to translate.
 *
 * **A signed-in account with no `residents` row is expected, not an error.** It is the normal state
 * of someone who has signed up and is waiting to be admitted, and it stays normal until #20
 * (undangan) and #21 (persetujuan pendaftaran) land. The screen says so rather than showing an empty
 * list, which would read as "your house is not recorded" and send the resident to complain about the
 * wrong thing.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const db = database();
	const profile = await residentProfileForUser(db, locals.user.id);
	const occupancies: readonly OwnOccupancy[] = profile
		? await occupiedUnitsForUser(db, systemClock, locals.user.id)
		: [];

	return { hasResidentRecord: profile !== undefined, occupancies };
};
