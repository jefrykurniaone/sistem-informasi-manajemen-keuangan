import { error, fail, redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { PermissionDeniedError } from '$lib/errors';
import { systemClock } from '$lib/server/ports/clock';
import { residentProfileForUser, updateOwnProfile } from '$lib/server/services/resident/profile';
import type { Actions, PageServerLoad } from './$types';

/**
 * A resident's own profile: their name and phone number, and nothing about anyone else.
 *
 * **A signed-in account with no `residents` row is expected, not an error.** `load` returns
 * `profile: null` for it, and `+page.svelte` shows the honest "belum tercatat" state instead of a
 * form — see `src/lib/server/services/resident/profile.ts` for why that row can be missing on a
 * freshly migrated database.
 *
 * **A permission refusal becomes a 403, never a 500.** `PermissionDeniedError` — reached here
 * through `updateOwnProfile` if a form were ever posted with someone else's `residentId` — is caught
 * below and turned into `error(403, …)`, the same translation `(app)/admin/roles/+page.server.ts`
 * does for the same error class.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const profile = await residentProfileForUser(database(), locals.user.id);
	return { profile: profile ?? null };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await readProfileForm(request);
		if (!form.ok) {
			return fail(400, { name: form.name, phone: form.phone, message: form.complaint });
		}

		try {
			await updateOwnProfile(database(), systemClock, {
				callerUserId: locals.user.id,
				residentId: form.residentId,
				name: form.name,
				phone: form.phone
			});
		} catch (caught) {
			if (caught instanceof PermissionDeniedError) {
				throw error(403, 'Anda hanya dapat mengubah data diri Anda sendiri.');
			}
			throw caught;
		}

		return { name: form.name, phone: form.phone, saved: true };
	}
};

/** What a profile form posts, after being checked for shape. */
type ProfileForm =
	| {
			readonly ok: true;
			readonly residentId: string;
			readonly name: string;
			readonly phone: string | null;
	  }
	| {
			readonly ok: false;
			readonly name: string;
			readonly phone: string | null;
			readonly complaint: string;
	  };

/** Reads and validates a profile form, without yet knowing whether the change is allowed. */
async function readProfileForm(request: Request): Promise<ProfileForm> {
	const form = await request.formData();
	const residentId = String(form.get('residentId') ?? '').trim();
	const name = String(form.get('name') ?? '').trim();
	const phoneRaw = String(form.get('phone') ?? '').trim();
	const phone = phoneRaw === '' ? null : phoneRaw;

	if (residentId === '') {
		return { ok: false, name, phone, complaint: 'Permintaan tidak valid.' };
	}
	if (name === '') {
		return { ok: false, name, phone, complaint: 'Nama tidak boleh kosong.' };
	}
	return { ok: true, residentId, name, phone };
}
